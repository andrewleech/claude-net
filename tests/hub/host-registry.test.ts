import { describe, expect, test } from "bun:test";
import { HostRegistry } from "@/hub/host-registry";
import type { DashboardEvent, HostRegisterFrame } from "@/shared/types";

function mockConn() {
  const sent: string[] = [];
  const wsIdentity = {};
  let closed = false;
  return {
    sent,
    wsIdentity,
    send: (data: string) => sent.push(data),
    close: () => {
      closed = true;
    },
    isClosed: () => closed,
  };
}

function validRegisterFrame(
  overrides: Partial<HostRegisterFrame> = {},
): HostRegisterFrame {
  return {
    action: "host_register",
    host_id: "alice@box",
    user: "alice",
    hostname: "box",
    home: "/home/alice",
    recent_cwds: ["/home/alice/projects/foo"],
    allow_dangerous_skip: true,
    ...overrides,
  };
}

describe("HostRegistry", () => {
  test("register stores entry and broadcasts host:connected", () => {
    const reg = new HostRegistry();
    const events: DashboardEvent[] = [];
    reg.setDashboardBroadcast((e) => events.push(e));
    const conn = mockConn();

    const entry = reg.register(validRegisterFrame(), conn);

    expect(entry.hostId).toBe("alice@box");
    expect(entry.user).toBe("alice");
    expect(entry.allowDangerousSkip).toBe(true);
    expect(reg.hosts.size).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("host:connected");
    if (events[0].event === "host:connected") {
      expect(events[0].host_id).toBe("alice@box");
      expect(events[0].allow_dangerous_skip).toBe(true);
    }
  });

  test("re-register with same host_id closes the stale connection", () => {
    const reg = new HostRegistry();
    const events: DashboardEvent[] = [];
    reg.setDashboardBroadcast((e) => events.push(e));

    const first = mockConn();
    reg.register(validRegisterFrame(), first);
    expect(first.isClosed()).toBe(false);

    const second = mockConn();
    reg.register(validRegisterFrame(), second);

    expect(first.isClosed()).toBe(true);
    expect(reg.hosts.size).toBe(1);
    // Should have emitted two host:connected events (one per register call).
    expect(events.filter((e) => e.event === "host:connected")).toHaveLength(2);
  });

  test("unregisterByIdentity removes only the matching entry", () => {
    const reg = new HostRegistry();
    const events: DashboardEvent[] = [];
    reg.setDashboardBroadcast((e) => events.push(e));

    const connA = mockConn();
    const connB = mockConn();
    reg.register(validRegisterFrame({ host_id: "alice@a" }), connA);
    reg.register(validRegisterFrame({ host_id: "alice@b" }), connB);
    events.length = 0;

    reg.unregisterByIdentity(connA.wsIdentity);

    expect(reg.hosts.size).toBe(1);
    expect(reg.get("alice@a")).toBeUndefined();
    expect(reg.get("alice@b")).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("host:disconnected");
    if (events[0].event === "host:disconnected") {
      expect(events[0].host_id).toBe("alice@a");
    }
  });

  test("unregisterByIdentity is a no-op for unknown identity", () => {
    const reg = new HostRegistry();
    const events: DashboardEvent[] = [];
    reg.setDashboardBroadcast((e) => events.push(e));
    const conn = mockConn();
    reg.register(validRegisterFrame(), conn);
    events.length = 0;

    reg.unregisterByIdentity({});

    expect(reg.hosts.size).toBe(1);
    expect(events).toHaveLength(0);
  });

  test("list returns summaries of every connected host", () => {
    const reg = new HostRegistry();
    reg.register(validRegisterFrame({ host_id: "alice@a" }), mockConn());
    reg.register(
      validRegisterFrame({
        host_id: "bob@b",
        user: "bob",
        hostname: "b",
        home: "/home/bob",
      }),
      mockConn(),
    );

    const list = reg.list();
    expect(list).toHaveLength(2);
    const names = list.map((h) => h.host_id).sort();
    expect(names).toEqual(["alice@a", "bob@b"]);
    const alice = list.find((h) => h.host_id === "alice@a");
    expect(alice?.home).toBe("/home/alice");
    expect(alice?.allow_dangerous_skip).toBe(true);
  });

  test("register clamps recent_cwds to 20 entries", () => {
    const reg = new HostRegistry();
    const cwds = Array.from({ length: 50 }, (_, i) => `/path/${i}`);
    reg.register(validRegisterFrame({ recent_cwds: cwds }), mockConn());
    expect(reg.get("alice@box")?.recentCwds).toHaveLength(20);
  });

  test("register coerces allow_dangerous_skip falsy values", () => {
    const reg = new HostRegistry();
    reg.register(
      validRegisterFrame({
        allow_dangerous_skip: false,
      }),
      mockConn(),
    );
    expect(reg.get("alice@box")?.allowDangerousSkip).toBe(false);
  });
});
