import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHub } from "@/hub/index";

// Minimal type for parsed /api/events responses.
type EventsResponse = {
  events: Array<{
    ts: number;
    event: string;
    data: Record<string, unknown>;
  }>;
  count: number;
  oldest_ts: number;
  capacity: number;
};

type SummaryResponse = {
  counts: Record<string, number>;
  window_ms: number;
  total: number;
};

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function waitForFrame(
  ws: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeout = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for frame")),
      timeout,
    );
    const onMsg = (event: MessageEvent) => {
      const frame = JSON.parse(event.data as string) as Record<string, unknown>;
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(frame);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}

function registerAndWait(ws: WebSocket, name: string): Promise<void> {
  const done = waitForFrame(
    ws,
    (f) => f.event === "response" && f.requestId === `reg-${name}`,
  );
  ws.send(
    JSON.stringify({
      action: "register",
      name,
      channel_capable: true,
      plugin_version: "0.0.0-test",
      requestId: `reg-${name}`,
    }),
  );
  return done.then(() => undefined);
}

async function fetchEvents(
  baseUrl: string,
  params: Record<string, string> = {},
): Promise<EventsResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${baseUrl}/api/events?${qs}` : `${baseUrl}/api/events`;
  const resp = await fetch(url);
  return (await resp.json()) as EventsResponse;
}

describe("Hub observability REST endpoints", () => {
  // Long ping interval keeps the tick from firing during these tests —
  // eviction semantics are exercised separately below.
  let hub: ReturnType<typeof createHub>;
  let baseUrl: string;
  const openSockets: WebSocket[] = [];

  beforeAll(() => {
    hub = createHub({
      pingIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      eventLogCapacity: 500,
    });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    for (const ws of openSockets) {
      try {
        ws.close();
      } catch {}
    }
    hub.stop();
  });

  async function connect(): Promise<WebSocket> {
    const port = hub.app.server?.port ?? 0;
    const ws = await connectWs(port);
    openSockets.push(ws);
    return ws;
  }

  test("GET /api/events returns capacity from the configured buffer", async () => {
    const body = await fetchEvents(baseUrl);
    expect(body.capacity).toBe(500);
    expect(Array.isArray(body.events)).toBe(true);
  });

  test("register emits agent.registered with expected fields", async () => {
    const ws = await connect();
    await registerAndWait(ws, "evt-a:tester@host");

    const body = await fetchEvents(baseUrl, {
      event: "agent.registered",
      agent: "evt-a:tester@host",
    });
    expect(body.count).toBeGreaterThanOrEqual(1);
    const entry = body.events[body.events.length - 1];
    expect(entry).toBeDefined();
    expect(entry?.data.fullName).toBe("evt-a:tester@host");
    expect(entry?.data.channelCapable).toBe(true);
    expect(entry?.data.pluginVersion).toBe("0.0.0-test");
    expect(entry?.data.restored).toBe(false);
  });

  test("version mismatch emits agent.upgraded alongside agent.registered", async () => {
    const ws = await connect();
    // plugin_version "0.0.0-test" is guaranteed not to equal the
    // hub's current PLUGIN_VERSION_CURRENT, so the upgrade path fires.
    await registerAndWait(ws, "evt-upg:tester@host");

    const body = await fetchEvents(baseUrl, {
      event: "agent.upgraded",
      agent: "evt-upg:tester@host",
    });
    expect(body.count).toBeGreaterThanOrEqual(1);
    const entry = body.events[body.events.length - 1];
    expect(entry?.data.fullName).toBe("evt-upg:tester@host");
    expect(entry?.data.reportedVersion).toBe("0.0.0-test");
    expect(typeof entry?.data.currentVersion).toBe("string");
  });

  test("send emits message.sent with outcome=delivered", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAndWait(wsA, "evt-send-a:tester@host");
    await registerAndWait(wsB, "evt-send-b:tester@host");

    const inbound = waitForFrame(wsB, (f) => f.event === "message");
    const sent = waitForFrame(
      wsA,
      (f) => f.event === "response" && f.requestId === "snd-1",
    );
    wsA.send(
      JSON.stringify({
        action: "send",
        to: "evt-send-b:tester@host",
        content: "hi",
        type: "message",
        requestId: "snd-1",
      }),
    );
    await Promise.all([inbound, sent]);

    const body = await fetchEvents(baseUrl, {
      event: "message.sent",
      agent: "evt-send-a:tester@host",
    });
    const hit = body.events.find((e) => e.data.to === "evt-send-b:tester@host");
    expect(hit).toBeDefined();
    expect(hit?.data.outcome).toBe("delivered");
    expect(typeof hit?.data.messageId).toBe("string");
    expect(typeof hit?.data.elapsedMs).toBe("number");
  });

  test("send to offline agent emits message.sent outcome=nak with reason", async () => {
    const ws = await connect();
    await registerAndWait(ws, "evt-nak:tester@host");

    const resp = waitForFrame(
      ws,
      (f) => f.event === "response" && f.requestId === "nak-1",
    );
    ws.send(
      JSON.stringify({
        action: "send",
        to: "nobody:nowhere@nohost",
        content: "x",
        requestId: "nak-1",
      }),
    );
    await resp;

    const body = await fetchEvents(baseUrl, { event: "message.sent" });
    const hit = body.events.find((e) => e.data.to === "nobody:nowhere@nohost");
    expect(hit?.data.outcome).toBe("nak");
    expect(hit?.data.reason).toBe("offline");
    expect(hit?.data.messageId).toBe(null);
  });

  test("broadcast emits message.broadcast", async () => {
    const ws = await connect();
    await registerAndWait(ws, "evt-bc:tester@host");

    const resp = waitForFrame(
      ws,
      (f) => f.event === "response" && f.requestId === "bc-1",
    );
    ws.send(
      JSON.stringify({
        action: "broadcast",
        content: "hello all",
        requestId: "bc-1",
      }),
    );
    await resp;

    const body = await fetchEvents(baseUrl, {
      event: "message.broadcast",
      agent: "evt-bc:tester@host",
    });
    expect(body.count).toBeGreaterThanOrEqual(1);
    const entry = body.events[body.events.length - 1];
    expect(entry?.data.from).toBe("evt-bc:tester@host");
    expect(typeof entry?.data.messageId).toBe("string");
    expect(typeof entry?.data.deliveredTo).toBe("number");
    expect(typeof entry?.data.skippedNoChannel).toBe("number");
  });

  test("send_team emits message.team with team name", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAndWait(wsA, "evt-tm-a:tester@host");
    await registerAndWait(wsB, "evt-tm-b:tester@host");

    for (const ws of [wsA, wsB]) {
      const r = waitForFrame(
        ws,
        (f) => f.event === "response" && f.requestId === "join",
      );
      ws.send(
        JSON.stringify({
          action: "join_team",
          team: "evt-team",
          requestId: "join",
        }),
      );
      await r;
    }

    const sent = waitForFrame(
      wsA,
      (f) => f.event === "response" && f.requestId === "tm-1",
    );
    wsA.send(
      JSON.stringify({
        action: "send_team",
        team: "evt-team",
        content: "team hi",
        type: "message",
        requestId: "tm-1",
      }),
    );
    await sent;

    const body = await fetchEvents(baseUrl, { event: "message.team" });
    const hit = body.events.find((e) => e.data.team === "evt-team");
    expect(hit).toBeDefined();
    expect(hit?.data.from).toBe("evt-tm-a:tester@host");
    expect(typeof hit?.data.messageId).toBe("string");
  });

  test("close emits agent.disconnected with reason=close", async () => {
    const ws = await connect();
    await registerAndWait(ws, "evt-close:tester@host");
    // Drop the WS out of the pool list so the afterAll doesn't double-close.
    const idx = openSockets.indexOf(ws);
    if (idx >= 0) openSockets.splice(idx, 1);

    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    ws.close();
    await closed;
    // Give the server a tick to process the close handler.
    await new Promise((r) => setTimeout(r, 50));

    const body = await fetchEvents(baseUrl, {
      event: "agent.disconnected",
      agent: "evt-close:tester@host",
    });
    const entry = body.events[body.events.length - 1];
    expect(entry?.data.reason).toBe("close");
    expect(entry?.data.fullName).toBe("evt-close:tester@host");
  });

  test("GET /api/events respects limit", async () => {
    const body = await fetchEvents(baseUrl, { limit: "2" });
    expect(body.events.length).toBeLessThanOrEqual(2);
  });

  test("GET /api/events since filter drops older events", async () => {
    const pivot = Date.now() + 10; // future — excludes existing entries
    await new Promise((r) => setTimeout(r, 20));
    const wsX = await connect();
    await registerAndWait(wsX, "evt-since:tester@host");

    const body = await fetchEvents(baseUrl, { since: String(pivot) });
    expect(body.events.every((e) => e.ts > pivot)).toBe(true);
    expect(
      body.events.some((e) => e.data.fullName === "evt-since:tester@host"),
    ).toBe(true);
  });

  test("GET /api/events/summary returns counts and window_ms", async () => {
    const resp = await fetch(`${baseUrl}/api/events/summary`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as SummaryResponse;
    expect(typeof body.window_ms).toBe("number");
    expect(body.window_ms).toBeGreaterThan(0);
    expect(typeof body.total).toBe("number");
    // Prior tests have definitely produced agent.registered events.
    expect(body.counts["agent.registered"]).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/events/summary honors since param", async () => {
    const future = Date.now() + 60_000;
    const resp = await fetch(`${baseUrl}/api/events/summary?since=${future}`);
    const body = (await resp.json()) as SummaryResponse;
    expect(body.total).toBe(0);
    expect(Object.keys(body.counts).length).toBe(0);
  });
});

describe("Ping tick emits ping.tick and agent.evicted", () => {
  test("stale agent is evicted and both events recorded", async () => {
    const hub = createHub({
      pingIntervalMs: 50,
      staleThresholdMs: 30,
      eventLogCapacity: 200,
    });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;
    const baseUrl = `http://localhost:${port}`;

    try {
      const ws = await connectWs(port);
      await registerAndWait(ws, "evt-evict:tester@host");

      // Suppress pong handling on the client side: browser WebSocket
      // auto-responds to WS pings, which would refresh lastPongAt and
      // prevent eviction. Forcing lastPongAt backwards is cleaner.
      const entry = hub.registry.getByFullName("evt-evict:tester@host");
      expect(entry).toBeTruthy();
      if (entry) entry.lastPongAt = Date.now() - 1_000;

      // Wait for two tick intervals so eviction has a chance to fire.
      await new Promise((r) => setTimeout(r, 200));

      const body = await fetchEvents(baseUrl, { event: "agent.evicted" });
      expect(
        body.events.some((e) => e.data.fullName === "evt-evict:tester@host"),
      ).toBe(true);
      const evicted = body.events.find(
        (e) => e.data.fullName === "evt-evict:tester@host",
      );
      expect(typeof evicted?.data.lastPongAt).toBe("number");
      expect(typeof evicted?.data.silentForMs).toBe("number");

      const tickBody = await fetchEvents(baseUrl, { event: "ping.tick" });
      expect(tickBody.count).toBeGreaterThanOrEqual(1);
      const tick = tickBody.events[tickBody.events.length - 1];
      expect(typeof tick?.data.agentCount).toBe("number");
      expect(typeof tick?.data.evictedCount).toBe("number");

      try {
        ws.close();
      } catch {}
    } finally {
      hub.stop();
    }
  });

  test("eviction emits agent.disconnected with reason=evicted", async () => {
    const hub = createHub({
      pingIntervalMs: 50,
      staleThresholdMs: 30,
      eventLogCapacity: 200,
    });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;
    const baseUrl = `http://localhost:${port}`;

    try {
      const ws = await connectWs(port);
      await registerAndWait(ws, "evt-evict-r:tester@host");

      const entry = hub.registry.getByFullName("evt-evict-r:tester@host");
      if (entry) entry.lastPongAt = Date.now() - 1_000;

      await new Promise((r) => setTimeout(r, 250));

      const body = await fetchEvents(baseUrl, {
        event: "agent.disconnected",
      });
      const disc = body.events.find(
        (e) => e.data.fullName === "evt-evict-r:tester@host",
      );
      expect(disc).toBeDefined();
      expect(disc?.data.reason).toBe("evicted");

      try {
        ws.close();
      } catch {}
    } finally {
      hub.stop();
    }
  });
});

describe("REST /api/send emits message.sent", () => {
  test("successful send records delivered outcome", async () => {
    const hub = createHub({ eventLogCapacity: 100 });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;
    const baseUrl = `http://localhost:${port}`;

    try {
      const ws = await connectWs(port);
      await registerAndWait(ws, "rest-recv:bob@host");

      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "rest-recv:bob@host", content: "hi" }),
      });
      expect(res.status).toBe(200);

      const body = await fetchEvents(baseUrl, { event: "message.sent" });
      const sent = body.events.find(
        (e) =>
          e.data.from === "dashboard@hub" && e.data.to === "rest-recv:bob@host",
      );
      expect(sent).toBeDefined();
      expect(sent?.data.outcome).toBe("delivered");
      expect(typeof sent?.data.messageId).toBe("string");
      expect(typeof sent?.data.elapsedMs).toBe("number");

      try {
        ws.close();
      } catch {}
    } finally {
      hub.stop();
    }
  });

  test("failed send records NAK with reason", async () => {
    const hub = createHub({ eventLogCapacity: 100 });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;
    const baseUrl = `http://localhost:${port}`;

    try {
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "nobody:nobody@nohost", content: "hi" }),
      });
      expect(res.status).toBe(400);

      const body = await fetchEvents(baseUrl, { event: "message.sent" });
      const sent = body.events.find(
        (e) => e.data.to === "nobody:nobody@nohost",
      );
      expect(sent).toBeDefined();
      expect(sent?.data.outcome).toBe("nak");
      expect(sent?.data.reason).toBe("offline");
      expect(sent?.data.messageId).toBeNull();
    } finally {
      hub.stop();
    }
  });
});

describe("query_events WS frame", () => {
  test("registered agent can query events over WS and gets structured response", async () => {
    const hub = createHub({ eventLogCapacity: 100 });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;

    try {
      const ws = await connectWs(port);
      await registerAndWait(ws, "qe-agent:tester@host");

      // Query all events via the WS frame
      const resp = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timeout waiting for query_events response")),
            2000,
          );
          const onMsg = (event: MessageEvent) => {
            const frame = JSON.parse(event.data as string) as Record<
              string,
              unknown
            >;
            if (frame.event === "response" && frame.requestId === "qe-1") {
              clearTimeout(timer);
              ws.removeEventListener("message", onMsg);
              resolve(frame);
            }
          };
          ws.addEventListener("message", onMsg);

          ws.send(
            JSON.stringify({
              action: "query_events",
              requestId: "qe-1",
            }),
          );
        },
      );

      expect(resp.ok).toBe(true);
      const data = resp.data as {
        events: unknown[];
        count: number;
        oldest_ts: number;
        capacity: number;
      };
      expect(Array.isArray(data.events)).toBe(true);
      expect(typeof data.count).toBe("number");
      expect(typeof data.oldest_ts).toBe("number");
      expect(data.capacity).toBe(100);
      // The register event should be in the results
      expect(
        (
          data.events as Array<{
            event: string;
            data: Record<string, unknown>;
          }>
        ).some(
          (e) =>
            e.event === "agent.registered" &&
            e.data.fullName === "qe-agent:tester@host",
        ),
      ).toBe(true);

      try {
        ws.close();
      } catch {}
    } finally {
      hub.stop();
    }
  });

  test("query_events respects event filter over WS", async () => {
    const hub = createHub({ eventLogCapacity: 100 });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;

    try {
      const ws = await connectWs(port);
      await registerAndWait(ws, "qe-filter:tester@host");

      const resp = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timeout")),
            2000,
          );
          const onMsg = (event: MessageEvent) => {
            const frame = JSON.parse(event.data as string) as Record<
              string,
              unknown
            >;
            if (frame.event === "response" && frame.requestId === "qe-2") {
              clearTimeout(timer);
              ws.removeEventListener("message", onMsg);
              resolve(frame);
            }
          };
          ws.addEventListener("message", onMsg);

          ws.send(
            JSON.stringify({
              action: "query_events",
              event: "message",
              requestId: "qe-2",
            }),
          );
        },
      );

      const data = resp.data as { events: Array<{ event: string }> };
      // All returned events must be message.* events
      for (const e of data.events) {
        expect(e.event.startsWith("message.")).toBe(true);
      }

      try {
        ws.close();
      } catch {}
    } finally {
      hub.stop();
    }
  });

  test("unregistered agent gets error on query_events", async () => {
    const hub = createHub({ eventLogCapacity: 100 });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;

    try {
      const ws = await connectWs(port);
      // Do NOT register

      const resp = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timeout")),
            2000,
          );
          const onMsg = (event: MessageEvent) => {
            const frame = JSON.parse(event.data as string) as Record<
              string,
              unknown
            >;
            if (frame.event === "response" && frame.requestId === "qe-3") {
              clearTimeout(timer);
              ws.removeEventListener("message", onMsg);
              resolve(frame);
            }
          };
          ws.addEventListener("message", onMsg);

          ws.send(
            JSON.stringify({
              action: "query_events",
              requestId: "qe-3",
            }),
          );
        },
      );

      expect(resp.ok).toBe(false);

      try {
        ws.close();
      } catch {}
    } finally {
      hub.stop();
    }
  });
});

describe("Dashboard receives system:event broadcasts", () => {
  test("dashboard WS receives system:event when an agent registers", async () => {
    const hub = createHub({ eventLogCapacity: 100 });
    // Need to also wire the dashboard plugin
    const { broadcastToDashboards, wsDashboardPlugin } = await import(
      "@/hub/ws-dashboard"
    );
    const { setDashboardBroadcast } = await import("@/hub/ws-plugin");
    setDashboardBroadcast(broadcastToDashboards);

    // Wire event log to broadcast system events — re-wire since index.ts
    // already did it once on createHub, but dashboard plugin needs explicit
    // registration on this app instance.
    hub.eventLog.setListener((entry) => {
      broadcastToDashboards({
        event: "system:event",
        ts: entry.ts,
        name: entry.event,
        data: entry.data,
      });
    });

    let app = hub.app;
    app = wsDashboardPlugin(app, hub.registry, hub.teams);
    app.listen(0);
    const port = app.server?.port ?? 0;

    try {
      // Connect a dashboard client
      const dashWs = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/dashboard`);
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(e);
      });

      // Drain initial state
      await new Promise((r) => setTimeout(r, 100));

      // Collect the next system:event
      const sysEvent = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timeout waiting for system:event")),
            2000,
          );
          const onMsg = (event: MessageEvent) => {
            const frame = JSON.parse(event.data as string) as Record<
              string,
              unknown
            >;
            if (
              frame.event === "system:event" &&
              frame.name === "agent.registered"
            ) {
              clearTimeout(timer);
              dashWs.removeEventListener("message", onMsg);
              resolve(frame);
            }
          };
          dashWs.addEventListener("message", onMsg);
        },
      );

      // Connect an agent to trigger agent.registered
      const agentWs = await connectWs(port);
      await registerAndWait(agentWs, "sys-evt:tester@host");

      const frame = await sysEvent;
      expect(frame.event).toBe("system:event");
      expect(frame.name).toBe("agent.registered");
      const data = frame.data as Record<string, unknown>;
      expect(data.fullName).toBe("sys-evt:tester@host");
      expect(typeof frame.ts).toBe("number");

      dashWs.close();
      agentWs.close();
    } finally {
      hub.stop();
    }
  });
});

describe("Rename emits agent.disconnected with reason=renamed", () => {
  test("registering a new name on the same WS disconnects the old identity in the event log", async () => {
    const hub = createHub({ eventLogCapacity: 100 });
    hub.app.listen(0);
    const port = hub.app.server?.port ?? 0;
    const baseUrl = `http://localhost:${port}`;

    try {
      const ws = await connectWs(port);
      await registerAndWait(ws, "rn-old:alice@host");
      await registerAndWait(ws, "rn-new:alice@host");

      const body = await fetchEvents(baseUrl, { event: "agent.disconnected" });
      const renamed = body.events.find(
        (e) =>
          e.data.fullName === "rn-old:alice@host" &&
          e.data.reason === "renamed",
      );
      expect(renamed).toBeDefined();

      try {
        ws.close();
      } catch {}
    } finally {
      hub.stop();
    }
  });
});
