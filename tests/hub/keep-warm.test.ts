import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TEXT,
  KeepWarm,
  MAX_INJECT_BYTES,
  parseKeepWarmMinutes,
  sanitizeKeepWarmText,
} from "@/hub/keep-warm";
import type { KeepWarmSessionState } from "@/hub/keep-warm";

// Small helper: wait for a real timer to elapse. KeepWarm uses real
// setTimeout, so tests use short intervals rather than fake clocks.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeState(
  overrides?: Partial<KeepWarmSessionState>,
): KeepWarmSessionState {
  return {
    lastEventAt: Date.now(),
    activity: "awaiting_input",
    awaitingUser: false,
    open: true,
    attached: true,
    lastUserPromptAt: 0,
    ...overrides,
  };
}

describe("parseKeepWarmMinutes", () => {
  test("blank input falls back to the default", () => {
    expect(parseKeepWarmMinutes(undefined)).toBe(50);
    expect(parseKeepWarmMinutes("")).toBe(50);
    expect(parseKeepWarmMinutes("   ")).toBe(50);
  });

  test("zero, negative, and unparsable input fall back to the default", () => {
    expect(parseKeepWarmMinutes("0")).toBe(50);
    expect(parseKeepWarmMinutes("-5")).toBe(50);
    expect(parseKeepWarmMinutes("abc")).toBe(50);
  });

  test("a huge value clamps to the maximum instead of falling back", () => {
    expect(parseKeepWarmMinutes("1e9")).toBe(1440);
  });

  test("a normal value passes through unchanged", () => {
    expect(parseKeepWarmMinutes("10")).toBe(10);
  });

  test("a below-floor value clamps to the minimum", () => {
    expect(parseKeepWarmMinutes("0.2")).toBe(1);
  });
});

describe("sanitizeKeepWarmText", () => {
  test("blank input falls back to the default", () => {
    expect(sanitizeKeepWarmText(undefined)).toBe(DEFAULT_TEXT);
    expect(sanitizeKeepWarmText("")).toBe(DEFAULT_TEXT);
    expect(sanitizeKeepWarmText("   ")).toBe(DEFAULT_TEXT);
  });

  test("collapses internal whitespace runs, including newlines", () => {
    expect(sanitizeKeepWarmText("hello\n\n  world\t\tagain")).toBe(
      "hello world again",
    );
  });

  test("trims leading and trailing whitespace", () => {
    expect(sanitizeKeepWarmText("  hi there  ")).toBe("hi there");
  });

  test("falls back when the text exceeds MAX_INJECT_BYTES", () => {
    const oversized = "a".repeat(MAX_INJECT_BYTES + 1);
    expect(sanitizeKeepWarmText(oversized)).toBe(DEFAULT_TEXT);
  });

  test("falls back when the text would run a slash command", () => {
    expect(sanitizeKeepWarmText("/compact")).toBe(DEFAULT_TEXT);
  });

  test("falls back when the text would run a shell command", () => {
    expect(sanitizeKeepWarmText("!ls -la")).toBe(DEFAULT_TEXT);
  });

  test("passes an ordinary prompt through unchanged", () => {
    expect(sanitizeKeepWarmText("just checking in")).toBe("just checking in");
  });
});

describe("KeepWarm", () => {
  test("pings after the idle interval elapses", async () => {
    const state = makeState();
    const calls: Array<[string, string, string, string | undefined]> = [];
    const events: string[] = [];
    const kw = new KeepWarm({
      intervalMs: 100,
      text: "ping",
      fireInject: (sid, text, watcher, host) => {
        calls.push([sid, text, watcher, host]);
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action) => events.push(action));
    kw.enable("sid-1", "host-1");
    await sleep(150); // 50ms after the ~100ms fire, 50ms before the next
    expect(calls).toEqual([["sid-1", "ping", "keep-warm", "host-1"]]);
    expect(events).toContain("fired");
    kw.stop();
  });

  test("activity inside the interval defers the ping and emits nothing while deferred", async () => {
    const state = makeState();
    const calls: number[] = [];
    const notifyCalls: string[] = [];
    const kw = new KeepWarm({
      intervalMs: 400,
      fireInject: () => {
        calls.push(Date.now());
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action) => notifyCalls.push(action));
    kw.enable("sid-1");
    // Bumping at B pushes the real deadline to intervalMs + B: the
    // first (stale) check at ~intervalMs defers by exactly B. Wide
    // margins throughout (100ms+) since this asserts a "not yet" state
    // between two computed deadlines, which a loaded test run can
    // otherwise miss.
    await sleep(250);
    state.lastEventAt = Date.now();
    await sleep(300); // t=550: past the stale check (~400), before the deferred one (~650)
    expect(calls).toHaveLength(0);
    // The not_idle recheck at ~400ms must not have notified anything.
    expect(notifyCalls).toEqual(["enabled"]);
    await sleep(250); // t=800: past the deferred deadline (~650), before the next (~1050)
    expect(calls).toHaveLength(1);
    expect(notifyCalls).toEqual(["enabled", "fired"]);
    kw.stop();
  });

  test("already idle past the interval pings immediately on enable", async () => {
    const state = makeState({ lastEventAt: Date.now() - 60_000 });
    const calls: number[] = [];
    const kw = new KeepWarm({
      intervalMs: 200,
      fireInject: () => {
        calls.push(1);
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.enable("sid-1");
    await sleep(150);
    expect(calls).toHaveLength(1);
    kw.stop();
  });

  test("a background session still pings", async () => {
    const state = makeState({
      lastEventAt: Date.now() - 60_000,
      activity: "background",
    });
    const calls: number[] = [];
    const events: string[] = [];
    const kw = new KeepWarm({
      intervalMs: 200,
      fireInject: () => {
        calls.push(1);
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action) => events.push(action));
    kw.enable("sid-1");
    await sleep(150);
    expect(calls).toHaveLength(1);
    expect(events).toContain("fired");
    kw.stop();
  });

  test("busy skips with reason busy, then pings once the state clears", async () => {
    const state = makeState({
      lastEventAt: Date.now() - 60_000,
      activity: "busy",
    });
    const events: Array<{ action: string; reason?: string }> = [];
    const calls: number[] = [];
    const kw = new KeepWarm({
      intervalMs: 150,
      recheckMs: 150,
      fireInject: () => {
        calls.push(1);
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action, info) =>
      events.push({ action, reason: info.lastSkipReason }),
    );
    kw.enable("sid-1");
    await sleep(70);
    expect(
      events.some((e) => e.action === "skipped" && e.reason === "busy"),
    ).toBe(true);
    expect(calls).toHaveLength(0);
    state.activity = "awaiting_input";
    await sleep(150);
    expect(calls).toHaveLength(1);
    kw.stop();
  });

  test("awaitingUser skips the ping", async () => {
    const state = makeState({
      lastEventAt: Date.now() - 60_000,
      awaitingUser: true,
    });
    const events: Array<{ action: string; reason?: string }> = [];
    const calls: number[] = [];
    const kw = new KeepWarm({
      intervalMs: 150,
      recheckMs: 300,
      fireInject: () => {
        calls.push(1);
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action, info) =>
      events.push({ action, reason: info.lastSkipReason }),
    );
    kw.enable("sid-1");
    await sleep(100);
    expect(
      events.some(
        (e) => e.action === "skipped" && e.reason === "awaiting_user",
      ),
    ).toBe(true);
    expect(calls).toHaveLength(0);
    kw.stop();
  });

  test("a detached session skips the ping", async () => {
    const state = makeState({
      lastEventAt: Date.now() - 60_000,
      attached: false,
    });
    const events: Array<{ action: string; reason?: string }> = [];
    const calls: number[] = [];
    const kw = new KeepWarm({
      intervalMs: 150,
      recheckMs: 300,
      fireInject: () => {
        calls.push(1);
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action, info) =>
      events.push({ action, reason: info.lastSkipReason }),
    );
    kw.enable("sid-1");
    await sleep(100);
    expect(
      events.some((e) => e.action === "skipped" && e.reason === "detached"),
    ).toBe(true);
    expect(calls).toHaveLength(0);
    kw.stop();
  });

  test("a session closed at check time disables the timer", async () => {
    const state = makeState({ lastEventAt: Date.now() - 60_000 });
    const events: string[] = [];
    const kw = new KeepWarm({
      intervalMs: 100,
      fireInject: () => ({ ok: true }),
      getState: () => state,
    });
    kw.setNotify((action) => events.push(action));
    kw.enable("sid-1");
    state.open = false;
    await sleep(100);
    expect(events).toContain("disabled");
    expect(kw.isEnabled("sid-1")).toBe(false);
    kw.stop();
  });

  test("fireInject failure emits failed and retries after recheckMs", async () => {
    const state = makeState({ lastEventAt: Date.now() - 60_000 });
    let calls = 0;
    const events: Array<{ action: string; error?: string }> = [];
    const kw = new KeepWarm({
      intervalMs: 100,
      recheckMs: 200,
      fireInject: () => {
        calls++;
        return { ok: false, error: "offline" };
      },
      getState: () => state,
    });
    kw.setNotify((action, info) =>
      events.push({ action, error: info.lastError }),
    );
    kw.enable("sid-1");
    await sleep(100);
    expect(
      events.some((e) => e.action === "failed" && e.error === "offline"),
    ).toBe(true);
    expect(kw.isEnabled("sid-1")).toBe(true);
    await sleep(170);
    expect(calls).toBeGreaterThanOrEqual(2);
    kw.stop();
  });

  test("disable cancels a pending ping; enable twice is idempotent", async () => {
    const state = makeState();
    let calls = 0;
    const events: string[] = [];
    const kw = new KeepWarm({
      intervalMs: 200,
      fireInject: () => {
        calls++;
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action) => events.push(action));
    const r1 = kw.enable("sid-1");
    const r2 = kw.enable("sid-1");
    expect(r1.ok && r2.ok).toBe(true);
    expect(events.filter((a) => a === "enabled")).toHaveLength(1);
    expect(kw.disable("sid-1")).toBe(true);
    await sleep(250);
    expect(calls).toBe(0);
    kw.stop();
  });

  test("enable reports 404 for an unknown session and 409 for a closed one", () => {
    let known: KeepWarmSessionState | null = null;
    const kw = new KeepWarm({
      fireInject: () => ({ ok: true }),
      getState: () => known,
    });
    const missing = kw.enable("sid-1");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    known = makeState({ open: false });
    const closed = kw.enable("sid-1");
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.status).toBe(409);
    kw.stop();
  });

  test("stop clears every timer", async () => {
    const state = makeState();
    let calls = 0;
    const kw = new KeepWarm({
      intervalMs: 200,
      fireInject: () => {
        calls++;
        return { ok: true };
      },
      getState: () => state,
    });
    kw.enable("sid-1");
    kw.stop();
    await sleep(250);
    expect(calls).toBe(0);
    kw.stop();
  });

  test("enable after stop is refused", () => {
    const state = makeState();
    const kw = new KeepWarm({
      intervalMs: 1000,
      fireInject: () => ({ ok: true }),
      getState: () => state,
    });
    kw.stop();
    const r = kw.enable("sid-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain("shut down");
    }
  });

  test("stop emits disabled for every item it clears", () => {
    const states: Record<string, KeepWarmSessionState> = {
      a: makeState(),
      b: makeState(),
    };
    const events: Array<{ action: string; sid: string }> = [];
    const kw = new KeepWarm({
      intervalMs: 1000,
      fireInject: () => ({ ok: true }),
      getState: (sid) => states[sid] ?? null,
    });
    kw.setNotify((action, info) => events.push({ action, sid: info.sid }));
    kw.enable("a");
    kw.enable("b");
    kw.stop();
    const disabledSids = events
      .filter((e) => e.action === "disabled")
      .map((e) => e.sid)
      .sort();
    expect(disabledSids).toEqual(["a", "b"]);
    expect(kw.isEnabled("a")).toBe(false);
    expect(kw.isEnabled("b")).toBe(false);
  });

  test("keys items by (host, sid): the same sid on two hosts is independent", () => {
    const statesByHost: Record<string, KeepWarmSessionState> = {
      h1: makeState(),
      h2: makeState(),
    };
    const kw = new KeepWarm({
      intervalMs: 1000,
      fireInject: () => ({ ok: true }),
      getState: (_sid, host) => (host && statesByHost[host]) || null,
    });
    const r1 = kw.enable("shared-sid", "h1");
    expect(r1.ok).toBe(true);
    expect(kw.isEnabled("shared-sid", "h1")).toBe(true);
    expect(kw.isEnabled("shared-sid", "h2")).toBe(false);
    expect(kw.isEnabled("shared-sid")).toBe(true); // host omitted matches any

    expect(kw.disable("shared-sid", "h1")).toBe(true);
    expect(kw.isEnabled("shared-sid", "h1")).toBe(false);

    kw.enable("shared-sid", "h1");
    kw.enable("shared-sid", "h2");
    expect(kw.disable("shared-sid")).toBe(true); // host omitted -> every host
    expect(kw.isEnabled("shared-sid", "h1")).toBe(false);
    expect(kw.isEnabled("shared-sid", "h2")).toBe(false);
    kw.stop();
  });

  test("the ping floor blocks a re-enable from pinging again immediately", async () => {
    const state = makeState({ lastEventAt: Date.now() - 60_000 });
    const calls: number[] = [];
    const kw = new KeepWarm({
      intervalMs: 30,
      recheckMs: 200,
      fireInject: () => {
        calls.push(Date.now());
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.enable("sid-1");
    await sleep(80);
    expect(calls).toHaveLength(1); // the immediate first ping
    kw.disable("sid-1");
    kw.enable("sid-1"); // re-enable right away
    await sleep(70);
    expect(calls).toHaveLength(1); // still inside the recheckMs floor
    await sleep(120);
    expect(calls).toHaveLength(2); // floor has lapsed; a new ping fires
    kw.stop();
  });

  test("the ping floor's skip reason is recently_pinged, not not_idle", async () => {
    const state = makeState({ lastEventAt: Date.now() - 60_000 });
    const kw = new KeepWarm({
      intervalMs: 30,
      recheckMs: 200,
      fireInject: () => {
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.enable("sid-1");
    await sleep(80); // past the first ping (~2ms) and the floor-blocked recheck (~32ms)
    const peek = kw.enable("sid-1"); // idempotent: returns the item unchanged
    expect(peek.ok).toBe(true);
    if (peek.ok) expect(peek.info.lastSkipReason).toBe("recently_pinged");
    kw.stop();
  });

  test("disable with forget clears lastPingAt so a re-enable can ping immediately", async () => {
    const state = makeState({ lastEventAt: Date.now() - 60_000 });
    const calls: number[] = [];
    const kw = new KeepWarm({
      intervalMs: 30,
      // Large enough that, without forget, a re-enable would stay
      // blocked by the floor well past this test's window.
      recheckMs: 300,
      fireInject: () => {
        calls.push(1);
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.enable("sid-1");
    await sleep(60);
    expect(calls).toHaveLength(1); // first ping fired
    // Simulates the session-closed path (index.ts's onSessionClosed).
    kw.disable("sid-1", undefined, { forget: true });
    kw.enable("sid-1"); // re-enable right away
    await sleep(60);
    expect(calls).toHaveLength(2); // no floor block - the timestamp was forgotten
    kw.stop();
  });

  test("disables a session after too many consecutive pings with no real user prompt", async () => {
    const state = makeState({ lastEventAt: Date.now() - 60_000 });
    const calls: number[] = [];
    const events: Array<{ action: string; reason?: string }> = [];
    const kw = new KeepWarm({
      intervalMs: 30,
      recheckMs: 30,
      maxConsecutivePings: 2,
      fireInject: () => {
        calls.push(1);
        state.lastEventAt = Date.now();
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action, info) =>
      events.push({ action, reason: info.lastSkipReason }),
    );
    kw.enable("sid-1");
    await sleep(150);
    expect(calls).toHaveLength(2); // cap reached, no third ping
    expect(
      events.some((e) => e.action === "disabled" && e.reason === "abandoned"),
    ).toBe(true);
    expect(kw.isEnabled("sid-1")).toBe(false);
    kw.stop();
  });

  test("a real user prompt between pings resets the consecutive-ping streak", async () => {
    const state = makeState({ lastEventAt: Date.now() - 60_000 });
    const calls: number[] = [];
    const events: Array<{ action: string; reason?: string }> = [];
    const kw = new KeepWarm({
      intervalMs: 30,
      recheckMs: 30,
      maxConsecutivePings: 2,
      fireInject: () => {
        calls.push(1);
        state.lastEventAt = Date.now();
        // A real prompt answered this ping, well after any lastPingAt
        // set moments ago - never a tie.
        state.lastUserPromptAt = Date.now() + 1000;
        return { ok: true };
      },
      getState: () => state,
    });
    kw.setNotify((action, info) =>
      events.push({ action, reason: info.lastSkipReason }),
    );
    kw.enable("sid-1");
    await sleep(150);
    // Would have stopped at 2 pings without the reset.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.reason === "abandoned")).toBe(false);
    kw.stop();
  });

  test("lastSkipReason and lastError never leak from an earlier check", async () => {
    const state = makeState({
      lastEventAt: Date.now() - 60_000,
      activity: "busy",
    });
    const kw = new KeepWarm({
      intervalMs: 30,
      recheckMs: 150,
      fireInject: () => ({ ok: false, error: "offline" }),
      getState: () => state,
    });
    kw.enable("sid-1");
    await sleep(90);
    // Peek at the current item via the idempotent enable() return.
    let info = kw.enable("sid-1");
    expect(info.ok).toBe(true);
    if (info.ok) expect(info.info.lastSkipReason).toBe("busy");

    state.activity = "awaiting_input"; // clears the busy skip
    await sleep(210); // let the next check run: fireInject fails
    info = kw.enable("sid-1");
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.info.lastError).toBe("offline");
      // Not left over from the earlier busy skip.
      expect(info.info.lastSkipReason).toBeUndefined();
    }
    kw.stop();
  });
});
