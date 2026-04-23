import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { apiPlugin } from "@/hub/api";
import { EventLog } from "@/hub/event-log";
import { Registry } from "@/hub/registry";
import { Router } from "@/hub/router";
import { Teams } from "@/hub/teams";
import { broadcastToDashboards, wsDashboardPlugin } from "@/hub/ws-dashboard";
import { setDashboardBroadcast, wsPlugin } from "@/hub/ws-plugin";
import { Elysia } from "elysia";

type Msg = Record<string, unknown>;

function createHub() {
  const startedAt = new Date();
  const registry = new Registry({ disconnectTimeoutMs: 200 });
  const teams = new Teams(registry);
  const router = new Router(registry, teams);

  registry.setTimeoutCleanup((fullName, agentTeams) => {
    for (const teamName of agentTeams) {
      teams.leave(teamName, fullName);
    }
  });

  setDashboardBroadcast(broadcastToDashboards);

  const eventLog = new EventLog(100);
  let app = new Elysia().use(
    apiPlugin({ registry, teams, router, startedAt, eventLog }),
  );
  app = wsPlugin(app, registry, teams, router, eventLog);
  app = wsDashboardPlugin(app, registry, teams);
  app.listen(0);

  return { app, registry, teams, router };
}

function connectDashboard(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/dashboard`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function connectAgent(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function waitForMessage(ws: WebSocket, timeout = 2000): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for message")),
      timeout,
    );
    ws.onmessage = (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(event.data as string) as Msg);
    };
  });
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 2000,
): Promise<Msg[]> {
  return new Promise((resolve, reject) => {
    const messages: Msg[] = [];
    const timer = setTimeout(
      () =>
        reject(new Error(`Timeout: got ${messages.length}/${count} messages`)),
      timeout,
    );
    ws.onmessage = (event) => {
      messages.push(JSON.parse(event.data as string) as Msg);
      if (messages.length >= count) {
        clearTimeout(timer);
        resolve(messages);
      }
    };
  });
}

/**
 * Wait for a specific event type, discarding any other events that arrive first.
 */
function waitForEvent(
  ws: WebSocket,
  eventType: string,
  timeout = 2000,
): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for event: ${eventType}`)),
      timeout,
    );
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as Msg;
      if (msg.event === eventType) {
        clearTimeout(timer);
        resolve(msg);
      }
      // else keep waiting (onmessage stays bound)
    };
  });
}

/**
 * Drain all messages that arrive within a short window (for consuming initial state).
 */
function drainMessages(ws: WebSocket, settleMs = 100): Promise<Msg[]> {
  return new Promise((resolve) => {
    const messages: Msg[] = [];
    let timer = setTimeout(() => resolve(messages), settleMs);
    ws.onmessage = (event) => {
      messages.push(JSON.parse(event.data as string) as Msg);
      clearTimeout(timer);
      timer = setTimeout(() => resolve(messages), settleMs);
    };
  });
}

async function registerAgent(ws: WebSocket, name: string): Promise<Msg[]> {
  const msgs = collectMessages(ws, 2); // registered + response
  ws.send(
    JSON.stringify({
      action: "register",
      name,
      channel_capable: true,
      requestId: `reg-${name}`,
    }),
  );
  return msgs;
}

describe("Dashboard WebSocket (/ws/dashboard)", () => {
  let hub: ReturnType<typeof createHub>;
  let port: number;
  const openSockets: WebSocket[] = [];

  beforeAll(() => {
    hub = createHub();
    port = hub.app.server?.port ?? 0;
  });

  afterEach(async () => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    openSockets.length = 0;
    // Allow close handlers to fire and clean up
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(() => {
    hub.app.stop();
  });

  async function dash(): Promise<WebSocket> {
    const ws = await connectDashboard(port);
    openSockets.push(ws);
    return ws;
  }

  async function agent(): Promise<WebSocket> {
    const ws = await connectAgent(port);
    openSockets.push(ws);
    return ws;
  }

  test("dashboard connects successfully", async () => {
    const d = await dash();
    expect(d.readyState).toBe(WebSocket.OPEN);
  });

  test("dashboard receives initial state with existing agents", async () => {
    const agentWs = await agent();
    await registerAgent(agentWs, "pre-exist:tester@host");

    const d = await dash();
    const msg = await waitForEvent(d, "agent:connected");

    expect(msg.full_name).toBe("pre-exist:tester@host");
    expect(msg.name).toBe("pre-exist");
  });

  test("dashboard receives initial state with existing teams", async () => {
    const agentWs = await agent();
    await registerAgent(agentWs, "team-pre:tester@host");

    const joinP = waitForMessage(agentWs);
    agentWs.send(
      JSON.stringify({
        action: "join_team",
        team: "preteam",
        requestId: "jt-pre",
      }),
    );
    await joinP;

    const d = await dash();
    // Should receive both agent:connected and team:changed initial events
    const msgs = await drainMessages(d, 200);

    const agentEvent = msgs.find(
      (m) =>
        m.event === "agent:connected" && m.full_name === "team-pre:tester@host",
    );
    expect(agentEvent).toBeTruthy();

    const teamEvent = msgs.find(
      (m) => m.event === "team:changed" && m.team === "preteam",
    );
    expect(teamEvent).toBeTruthy();
    expect(teamEvent?.action).toBe("created");
    expect(teamEvent?.members).toContain("team-pre:tester@host");
  });

  test("dashboard receives agent:connected when agent registers", async () => {
    const d = await dash();
    // Drain any initial state from leftover agents
    await drainMessages(d, 150);

    const eventP = waitForEvent(d, "agent:connected");
    const agentWs = await agent();
    await registerAgent(agentWs, "live-reg:tester@host");

    const event = await eventP;
    expect(event.full_name).toBe("live-reg:tester@host");
    expect(event.name).toBe("live-reg");
  });

  test("dashboard receives agent:disconnected when agent disconnects", async () => {
    const agentWs = await agent();
    await registerAgent(agentWs, "will-leave:tester@host");

    const d = await dash();
    await drainMessages(d, 150);

    const eventP = waitForEvent(d, "agent:disconnected");
    agentWs.close();
    const idx = openSockets.indexOf(agentWs);
    if (idx >= 0) openSockets.splice(idx, 1);

    const event = await eventP;
    expect(event.full_name).toBe("will-leave:tester@host");
  });

  test("dashboard receives message:routed on direct message", async () => {
    const wsA = await agent();
    const wsB = await agent();
    await registerAgent(wsA, "dm-sender:tester@host");
    await registerAgent(wsB, "dm-receiver:tester@host");

    const d = await dash();
    await drainMessages(d, 150);

    const eventP = waitForEvent(d, "message:routed");
    wsA.send(
      JSON.stringify({
        action: "send",
        to: "dm-receiver:tester@host",
        content: "hello dashboard",
        type: "message",
        requestId: "dm-1",
      }),
    );

    const event = await eventP;
    expect(event.from).toBe("dm-sender:tester@host");
    expect(event.to).toBe("dm-receiver:tester@host");
    expect(event.content).toBe("hello dashboard");
  });

  test("dashboard receives message:routed on broadcast", async () => {
    const wsA = await agent();
    const wsB = await agent();
    await registerAgent(wsA, "bc-sender:tester@host");
    await registerAgent(wsB, "bc-listener:tester@host");

    const d = await dash();
    await drainMessages(d, 150);

    const eventP = waitForEvent(d, "message:routed");
    wsA.send(
      JSON.stringify({
        action: "broadcast",
        content: "broadcast msg",
        requestId: "bc-1",
      }),
    );

    const event = await eventP;
    expect(event.from).toBe("bc-sender:tester@host");
    expect(event.to).toBe("broadcast");
    expect(event.content).toBe("broadcast msg");
  });

  test("dashboard receives team:changed on join and leave", async () => {
    const agentWs = await agent();
    await registerAgent(agentWs, "proj:tj@host");

    const d = await dash();
    await drainMessages(d, 150);

    // Join team
    const joinEventP = waitForEvent(d, "team:changed");
    agentWs.send(
      JSON.stringify({
        action: "join_team",
        team: "gamma",
        requestId: "jt-g",
      }),
    );
    await waitForMessage(agentWs);

    const joinEvent = await joinEventP;
    expect(joinEvent.team).toBe("gamma");
    expect(joinEvent.action).toBe("created");

    // Leave team
    const leaveEventP = waitForEvent(d, "team:changed");
    agentWs.send(
      JSON.stringify({
        action: "leave_team",
        team: "gamma",
        requestId: "lt-g",
      }),
    );
    await waitForMessage(agentWs);

    const leaveEvent = await leaveEventP;
    expect(leaveEvent.team).toBe("gamma");
    expect(leaveEvent.action).toBe("deleted");
    expect(leaveEvent.members).toEqual([]);
  });

  test("multiple dashboard connections receive same events", async () => {
    const d1 = await dash();
    const d2 = await dash();
    await drainMessages(d1, 150);
    await drainMessages(d2, 150);

    const event1P = waitForEvent(d1, "agent:connected");
    const event2P = waitForEvent(d2, "agent:connected");

    const agentWs = await agent();
    await registerAgent(agentWs, "multi-dash:tester@host");

    const [event1, event2] = await Promise.all([event1P, event2P]);

    expect(event1.full_name).toBe("multi-dash:tester@host");
    expect(event2.full_name).toBe("multi-dash:tester@host");
  });
});
