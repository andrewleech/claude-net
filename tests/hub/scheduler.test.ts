import { describe, expect, test } from "bun:test";
import type { InjectAttempt } from "@/hub/scheduler";
import { Scheduler } from "@/hub/scheduler";

// Small helper: wait for a real timer to elapse. The scheduler uses real
// setTimeout, so tests use short delays rather than fake clocks.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Scheduler", () => {
  test("fires an inject after the delay elapses", async () => {
    const calls: Array<{ sid: string; text: string }> = [];
    const s = new Scheduler({
      fireInject: (sid, text) => {
        calls.push({ sid, text });
        return { ok: true };
      },
    });
    const r = s.schedule({
      sid: "sid-1",
      text: "hello",
      watcher: "test",
      delayMs: 20,
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(0);
    await sleep(50);
    expect(calls).toEqual([{ sid: "sid-1", text: "hello" }]);
    expect(s.list("sid-1")[0]?.status).toBe("sent");
    s.stop();
  });

  test("cancel prevents a pending inject from firing", async () => {
    let fired = 0;
    const s = new Scheduler({
      fireInject: () => {
        fired++;
        return { ok: true };
      },
    });
    const r = s.schedule({
      sid: "sid-1",
      text: "x",
      watcher: "test",
      delayMs: 30,
    });
    if (!r.ok) throw new Error("schedule failed");
    const c = s.cancel(r.item.id);
    expect(c.ok).toBe(true);
    await sleep(60);
    expect(fired).toBe(0);
    expect(s.list()[0]?.status).toBe("cancelled");
    s.stop();
  });

  test("cancelling an already-sent inject fails", async () => {
    const s = new Scheduler({ fireInject: () => ({ ok: true }) });
    const r = s.schedule({
      sid: "sid-1",
      text: "x",
      watcher: "test",
      delayMs: 5,
    });
    if (!r.ok) throw new Error("schedule failed");
    await sleep(30);
    const c = s.cancel(r.item.id);
    expect(c.ok).toBe(false);
    s.stop();
  });

  test("retries an offline target then fails at the deadline", async () => {
    let attempts = 0;
    const s = new Scheduler({
      fireInject: (): InjectAttempt => {
        attempts++;
        return { ok: false, error: "offline" };
      },
      retryDeadlineMs: 40,
      retryBackoffMs: 15,
    });
    const r = s.schedule({
      sid: "sid-1",
      text: "x",
      watcher: "test",
      delayMs: 10,
    });
    if (!r.ok) throw new Error("schedule failed");
    await sleep(150);
    // First attempt at ~10ms, retries at ~25/40ms, deadline at fireAt+40≈50ms.
    expect(attempts).toBeGreaterThanOrEqual(2);
    const item = s.list("sid-1")[0];
    expect(item?.status).toBe("failed");
    expect(item?.lastError).toBe("offline");
    s.stop();
  });

  test("a target that comes online during retry succeeds", async () => {
    let online = false;
    const s = new Scheduler({
      fireInject: (): InjectAttempt =>
        online ? { ok: true } : { ok: false, error: "offline" },
      retryDeadlineMs: 200,
      retryBackoffMs: 15,
    });
    const r = s.schedule({
      sid: "sid-1",
      text: "x",
      watcher: "test",
      delayMs: 10,
    });
    if (!r.ok) throw new Error("schedule failed");
    await sleep(30);
    online = true;
    await sleep(60);
    expect(s.list("sid-1")[0]?.status).toBe("sent");
    s.stop();
  });

  test("rejects non-positive and over-max delays", () => {
    const s = new Scheduler({ fireInject: () => ({ ok: true }) });
    expect(
      s.schedule({ sid: "s", text: "x", watcher: "t", delayMs: 0 }).ok,
    ).toBe(false);
    expect(
      s.schedule({ sid: "s", text: "x", watcher: "t", delayMs: -5 }).ok,
    ).toBe(false);
    expect(
      s.schedule({
        sid: "s",
        text: "x",
        watcher: "t",
        delayMs: s.maxDelayMs + 1,
      }).ok,
    ).toBe(false);
    s.stop();
  });

  test("notify reports added then a terminal status", async () => {
    const events: string[] = [];
    const s = new Scheduler({ fireInject: () => ({ ok: true }) });
    s.setNotify((action) => events.push(action));
    s.schedule({ sid: "s", text: "x", watcher: "t", delayMs: 5 });
    await sleep(30);
    expect(events[0]).toBe("added");
    expect(events).toContain("sent");
    s.stop();
  });

  test("list filters by sid and orders pending before terminal", async () => {
    const s = new Scheduler({ fireInject: () => ({ ok: true }) });
    s.schedule({ sid: "a", text: "1", watcher: "t", delayMs: 5 });
    s.schedule({ sid: "a", text: "2", watcher: "t", delayMs: 10_000 });
    s.schedule({ sid: "b", text: "3", watcher: "t", delayMs: 10_000 });
    await sleep(30); // let the first (5ms) fire → sent
    const a = s.list("a");
    expect(a).toHaveLength(2);
    expect(a[0]?.status).toBe("pending"); // pending sorts before sent
    expect(s.list("b")).toHaveLength(1);
    s.stop();
  });
});
