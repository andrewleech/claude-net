import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "@/hub/registry";

function mockWs() {
  const sent: string[] = [];
  return {
    send(data: string) {
      sent.push(data);
    },
    sent,
  };
}

describe("Registry", () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry({ disconnectTimeoutMs: 100 });
  });

  afterEach(() => {
    // Clear any pending timeouts
    for (const entry of registry.disconnected.values()) {
      clearTimeout(entry.timeoutId);
    }
  });

  test("register an agent and verify it appears in list", () => {
    const ws = mockWs();
    const result = registry.register("test:alice@host", ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.fullName).toBe("test:alice@host");
    expect(result.entry.shortName).toBe("test");
    expect(result.entry.user).toBe("alice");
    expect(result.entry.host).toBe("host");

    const agents = registry.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe("test:alice@host");
    expect(agents[0]?.status).toBe("online");
    expect(agents[0]?.user).toBe("alice");
  });

  test("register duplicate name with different WS returns error", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("test:alice@host", ws1);
    const result = registry.register("test:alice@host", ws2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already registered");
  });

  test("re-register same name with same WS succeeds (reconnect)", () => {
    const ws = mockWs();
    registry.register("test:alice@host", ws);
    const result = registry.register("test:alice@host", ws);
    expect(result.ok).toBe(true);
  });

  test("unregister moves agent to disconnected when it has teams", () => {
    const ws = mockWs();
    registry.register("test:alice@host", ws);
    const entry = registry.getByFullName("test:alice@host");
    entry?.teams.add("myteam");

    registry.unregister("test:alice@host");

    expect(registry.agents.has("test:alice@host")).toBe(false);
    expect(registry.disconnected.has("test:alice@host")).toBe(true);

    const agents = registry.list();
    const offline = agents.find((a) => a.name === "test:alice@host");
    expect(offline?.status).toBe("offline");
  });

  test("unregister agent with no teams does not track in disconnected", () => {
    const ws = mockWs();
    registry.register("test:alice@host", ws);
    registry.unregister("test:alice@host");

    expect(registry.disconnected.has("test:alice@host")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  test("reconnect within timeout restores team memberships", () => {
    const ws1 = mockWs();
    registry.register("test:alice@host", ws1);
    const entry = registry.getByFullName("test:alice@host");
    entry?.teams.add("teamA");

    registry.unregister("test:alice@host");
    expect(registry.disconnected.has("test:alice@host")).toBe(true);

    const ws2 = mockWs();
    const result = registry.register("test:alice@host", ws2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restored).toBe(true);
    expect(result.entry.teams.has("teamA")).toBe(true);
    expect(registry.disconnected.has("test:alice@host")).toBe(false);
  });

  test("timeout expires removes agent from disconnected", async () => {
    let cleanupCalled = false;
    registry.setTimeoutCleanup(() => {
      cleanupCalled = true;
    });

    const ws = mockWs();
    registry.register("test:alice@host", ws);
    const entry = registry.getByFullName("test:alice@host");
    entry?.teams.add("teamA");

    registry.unregister("test:alice@host");
    expect(registry.disconnected.has("test:alice@host")).toBe(true);

    // Wait for the 100ms timeout
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(registry.disconnected.has("test:alice@host")).toBe(false);
    expect(cleanupCalled).toBe(true);
  });

  // ── Resolve: full name exact match ──────────────────────────────────────

  test("resolve by full name returns exact match", () => {
    const ws = mockWs();
    registry.register("test:alice@host", ws);
    const result = registry.resolve("test:alice@host");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("test:alice@host");
    }
  });

  test("resolve nonexistent full name returns error", () => {
    const result = registry.resolve("nobody:user@host");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not online");
    }
  });

  // ── Resolve: session:user (across hosts) ────────────────────────────────

  test("resolve by session:user matches across hosts", () => {
    const ws = mockWs();
    registry.register("claude-net:andrew@laptop", ws);
    const result = registry.resolve("claude-net:andrew");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("claude-net:andrew@laptop");
    }
  });

  test("resolve by session:user with multiple hosts returns error", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("claude-net:andrew@laptop", ws1);
    registry.register("claude-net:andrew@desktop", ws2);
    const result = registry.resolve("claude-net:andrew");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Multiple agents match");
      expect(result.error).toContain("claude-net:andrew@laptop");
      expect(result.error).toContain("claude-net:andrew@desktop");
    }
  });

  // ── Resolve: user@host (across sessions) ────────────────────────────────

  test("resolve by user@host matches across sessions", () => {
    const ws = mockWs();
    registry.register("claude-net:andrew@laptop", ws);
    const result = registry.resolve("andrew@laptop");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("claude-net:andrew@laptop");
    }
  });

  test("resolve by user@host with multiple sessions returns error", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("project-a:andrew@laptop", ws1);
    registry.register("project-b:andrew@laptop", ws2);
    const result = registry.resolve("andrew@laptop");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Multiple agents match");
      expect(result.error).toContain("project-a:andrew@laptop");
      expect(result.error).toContain("project-b:andrew@laptop");
    }
  });

  // ── Resolve: plain string (session, then user, then host) ──────────────

  test("resolve by session name with single match", () => {
    const ws = mockWs();
    registry.register("claude-net:andrew@laptop", ws);
    const result = registry.resolve("claude-net");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("claude-net:andrew@laptop");
    }
  });

  test("resolve by ambiguous session name returns error", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("claude-net:andrew@laptop", ws1);
    registry.register("claude-net:bob@desktop", ws2);
    const result = registry.resolve("claude-net");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Multiple agents match 'claude-net'");
      expect(result.error).toContain("claude-net:andrew@laptop");
      expect(result.error).toContain("claude-net:bob@desktop");
    }
  });

  test("resolve by user name with single match", () => {
    const ws = mockWs();
    registry.register("claude-net:andrew@laptop", ws);
    const result = registry.resolve("andrew");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("claude-net:andrew@laptop");
    }
  });

  test("resolve by ambiguous user name returns error", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("project-a:andrew@laptop", ws1);
    registry.register("project-b:andrew@desktop", ws2);
    const result = registry.resolve("andrew");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Multiple agents match 'andrew'");
      expect(result.error).toContain("project-a:andrew@laptop");
      expect(result.error).toContain("project-b:andrew@desktop");
    }
  });

  test("resolve by host name with single match", () => {
    const ws = mockWs();
    registry.register("claude-net:andrew@laptop", ws);
    const result = registry.resolve("laptop");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("claude-net:andrew@laptop");
    }
  });

  test("resolve by host name with multiple matches returns error", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("project-a:andrew@laptop", ws1);
    registry.register("project-b:bob@laptop", ws2);
    const result = registry.resolve("laptop");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Multiple agents match 'laptop'");
    }
  });

  test("resolve plain string prefers session over user", () => {
    // "test" matches session of first agent, user of second
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("test:alice@host1", ws1);
    registry.register("other:test@host2", ws2);
    // "test" matches session="test" (first agent), so should return that
    // But it also matches user="test" (second agent) — session match is tried first
    // Since session match has exactly 1 result, it returns that
    const result = registry.resolve("test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("test:alice@host1");
    }
  });

  test("resolve nonexistent plain name returns error", () => {
    const result = registry.resolve("nobody");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not online");
    }
  });

  // ── Legacy format (name@host without colon) ────────────────────────────

  test("register and resolve legacy format (no colon)", () => {
    const ws = mockWs();
    registry.register("dashboard@hub", ws);
    const result = registry.resolve("dashboard@hub");
    // dashboard@hub has no colon, so resolve treats it as user@host
    // parseName("dashboard@hub") -> session="dashboard", user="", host="hub"
    // resolve("dashboard@hub") splits on @ -> user="dashboard", host="hub"
    // But the entry has user="" and host="hub", so user doesn't match
    // This means we need exact match fallback for legacy format
    // Actually: resolve("dashboard@hub") -> hasAt && !hasColon -> user@host match
    // It looks for entry.user === "dashboard" && entry.host === "hub"
    // But parseName("dashboard@hub") sets user="" since there's no colon
    // So the user@host resolve won't find it.
    // However, dashboard@hub is handled separately by the router before resolve is called.
    // For the test, let's verify the exact behavior:
    expect(result.ok).toBe(false);
  });

  // ── getByFullName ──────────────────────────────────────────────────────

  test("getByFullName returns entry or null", () => {
    const ws = mockWs();
    registry.register("test:alice@host", ws);
    expect(registry.getByFullName("test:alice@host")).not.toBeNull();
    expect(registry.getByFullName("nope:user@host")).toBeNull();
  });

  // ── rename (same WS re-registers under a new name) ─────────────────────

  test("same WS registering a new name drops the old entry", () => {
    const ws = mockWs();
    const identity = {};
    registry.register("old:alice@host", ws, identity);
    const result = registry.register("new:alice@host", ws, identity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.renamedFrom).toBe("old:alice@host");
    expect(registry.agents.has("old:alice@host")).toBe(false);
    expect(registry.agents.has("new:alice@host")).toBe(true);
  });

  test("rename carries forward team memberships", () => {
    const ws = mockWs();
    const identity = {};
    registry.register("old:alice@host", ws, identity);
    const entry = registry.getByFullName("old:alice@host");
    entry?.teams.add("alpha");
    entry?.teams.add("beta");

    const result = registry.register("new:alice@host", ws, identity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.entry.teams].sort()).toEqual(["alpha", "beta"]);
  });

  test("rename does not fire renamedFrom on first register", () => {
    const ws = mockWs();
    const result = registry.register("solo:alice@host", ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.renamedFrom).toBeUndefined();
  });

  test("rename to an existing name held by another WS fails", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("me:alice@host", ws1, {});
    registry.register("other:alice@host", ws2, {});
    const result = registry.register("other:alice@host", ws1, {});
    // ws1 wasn't tracked under an identity we can rename from (because
    // we passed a fresh {} identity each time), but the new name is
    // owned by ws2 — must fail.
    expect(result.ok).toBe(false);
  });

  // ── lastPongAt (WS liveness) ───────────────────────────────────────────

  test("register initializes lastPongAt close to now", () => {
    const ws = mockWs();
    const before = Date.now();
    const result = registry.register("live:alice@host", ws);
    const after = Date.now();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.lastPongAt).toBeGreaterThanOrEqual(before);
    expect(result.entry.lastPongAt).toBeLessThanOrEqual(after);
  });

  // ── channelCapable (FR3) ──────────────────────────────────────────────

  test("register defaults channelCapable to false when option omitted", () => {
    const ws = mockWs();
    const result = registry.register("cap:alice@host", ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.channelCapable).toBe(false);
  });

  test("register stores channelCapable=true when passed in options", () => {
    const ws = mockWs();
    const result = registry.register("cap:alice@host", ws, undefined, {
      channelCapable: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.channelCapable).toBe(true);
  });

  test("same-identity re-register updates channelCapable", () => {
    const ws = mockWs();
    const identity = {};
    const first = registry.register("cap:alice@host", ws, identity, {
      channelCapable: false,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.entry.channelCapable).toBe(false);

    const second = registry.register("cap:alice@host", ws, identity, {
      channelCapable: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entry.channelCapable).toBe(true);
    // Same entry object — update in place.
    expect(second.entry).toBe(first.entry);
  });

  test("same-identity re-register preserves lastPongAt", async () => {
    const ws = mockWs();
    const identity = {};
    const first = registry.register("live:alice@host", ws, identity);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const initial = first.entry.lastPongAt;

    // Wait long enough for Date.now() to advance at least 1ms so a
    // naive "reset to new Date()" would be detectable.
    await new Promise((r) => setTimeout(r, 5));

    const second = registry.register("live:alice@host", ws, identity);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entry.lastPongAt).toBe(initial);
  });

  // ── ccPid + findByHostPid (rename-join) ────────────────────────────

  test("register stores ccPid on the entry", () => {
    const ws = mockWs();
    const result = registry.register("pid:alice@host", ws, undefined, {
      ccPid: 4242,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.ccPid).toBe(4242);
  });

  test("register defaults ccPid to null when option omitted", () => {
    const ws = mockWs();
    const result = registry.register("pid:alice@host", ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.ccPid).toBeNull();
  });

  test("same-identity re-register refreshes ccPid when supplied", () => {
    const ws = mockWs();
    const identity = {};
    registry.register("pid:alice@host", ws, identity, { ccPid: 1000 });
    const second = registry.register("pid:alice@host", ws, identity, {
      ccPid: 2000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entry.ccPid).toBe(2000);
  });

  test("same-identity re-register without ccPid keeps the previous value", () => {
    const ws = mockWs();
    const identity = {};
    registry.register("pid:alice@host", ws, identity, { ccPid: 1000 });
    const second = registry.register("pid:alice@host", ws, identity);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entry.ccPid).toBe(1000);
  });

  test("findByHostPid returns the entry matching (host, ccPid)", () => {
    const wsA = mockWs();
    const wsB = mockWs();
    registry.register("a:alice@host1", wsA, {}, { ccPid: 1000 });
    registry.register("b:alice@host2", wsB, {}, { ccPid: 2000 });
    expect(registry.findByHostPid("host1", 1000)?.fullName).toBe(
      "a:alice@host1",
    );
    expect(registry.findByHostPid("host2", 2000)?.fullName).toBe(
      "b:alice@host2",
    );
  });

  test("findByHostPid returns null when no entry matches", () => {
    const ws = mockWs();
    registry.register("a:alice@host", ws, {}, { ccPid: 1000 });
    expect(registry.findByHostPid("host", 9999)).toBeNull();
    expect(registry.findByHostPid("other", 1000)).toBeNull();
  });

  test("findByHostPid rejects empty host and non-finite ccPid", () => {
    const ws = mockWs();
    registry.register("a:alice@host", ws, {}, { ccPid: 1000 });
    expect(registry.findByHostPid("", 1000)).toBeNull();
    expect(registry.findByHostPid("host", Number.NaN)).toBeNull();
    expect(registry.findByHostPid("host", Number.POSITIVE_INFINITY)).toBeNull();
  });
});
