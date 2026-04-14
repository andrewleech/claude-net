import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { apiPlugin } from "@/hub/api";
import { Registry } from "@/hub/registry";
import { Router } from "@/hub/router";
import { Teams } from "@/hub/teams";
import { wsPlugin } from "@/hub/ws-plugin";
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

  let app = new Elysia().use(apiPlugin({ registry, teams, router, startedAt }));
  app = wsPlugin(app, registry, teams, router);
  app.listen(0);

  return { app, registry, teams, router };
}

function connectWs(port: number): Promise<WebSocket> {
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

describe("REST API endpoints", () => {
  let hub: ReturnType<typeof createHub>;
  let port: number;
  let baseUrl: string;
  const openSockets: WebSocket[] = [];

  beforeAll(() => {
    hub = createHub();
    port = hub.app.server?.port ?? 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    openSockets.length = 0;
  });

  afterAll(() => {
    hub.app.stop();
  });

  async function connect(): Promise<WebSocket> {
    const ws = await connectWs(port);
    openSockets.push(ws);
    return ws;
  }

  async function registerAgent(ws: WebSocket, name: string): Promise<Msg[]> {
    const msgs = collectMessages(ws, 2);
    ws.send(
      JSON.stringify({ action: "register", name, requestId: `reg-${name}` }),
    );
    return msgs;
  }

  test("GET /api/agents returns empty list initially", async () => {
    const resp = await fetch(`${baseUrl}/api/agents`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/agents returns registered agents", async () => {
    const ws = await connect();
    await registerAgent(ws, "api-agent1@host");

    const resp = await fetch(`${baseUrl}/api/agents`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Msg[];
    const names = body.map((a) => a.name);
    expect(names).toContain("api-agent1@host");
  });

  test("GET /api/teams returns team list", async () => {
    const ws = await connect();
    await registerAgent(ws, "api-teamer@host");

    const joinP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "join_team",
        team: "api-team",
        requestId: "jt-api",
      }),
    );
    await joinP;

    const resp = await fetch(`${baseUrl}/api/teams`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Msg[];
    const teamNames = body.map((t) => t.name);
    expect(teamNames).toContain("api-team");
  });

  test("GET /api/status returns uptime and counts", async () => {
    const resp = await fetch(`${baseUrl}/api/status`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Msg;
    expect(typeof body.uptime).toBe("number");
    expect(body.agents).toBeTruthy();
    expect(typeof body.teams).toBe("number");
  });

  test("POST /api/send delivers message to connected agent", async () => {
    const ws = await connect();
    await registerAgent(ws, "api-recv@host");

    const inboundP = waitForMessage(ws);

    const resp = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "api-recv@host", content: "hello from api" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Msg;
    expect(body.message_id).toBeTruthy();
    expect(body.delivered).toBe(true);

    const inbound = await inboundP;
    expect(inbound.from).toBe("dashboard@hub");
    expect(inbound.content).toBe("hello from api");
  });

  test("POST /api/send with offline agent returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "nonexistent@host", content: "hello" }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Msg;
    expect(body.error).toBeTruthy();
  });

  test("POST /api/send with missing fields returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "someone" }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Msg;
    expect(body.error).toContain("Missing required fields");
  });

  test("POST /api/broadcast delivers to all connected agents", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAgent(wsA, "api-bc1@host");
    await registerAgent(wsB, "api-bc2@host");

    const msgA = waitForMessage(wsA);
    const msgB = waitForMessage(wsB);

    const resp = await fetch(`${baseUrl}/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "broadcast from api" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Msg;
    expect(body.message_id).toBeTruthy();
    expect(typeof body.delivered_to).toBe("number");

    const [a, b] = await Promise.all([msgA, msgB]);
    expect(a.from).toBe("dashboard@hub");
    expect(b.from).toBe("dashboard@hub");
  });

  test("POST /api/send_team delivers to team members", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAgent(wsA, "api-tm1@host");
    await registerAgent(wsB, "api-tm2@host");

    // Both join team
    const j1 = waitForMessage(wsA);
    wsA.send(
      JSON.stringify({
        action: "join_team",
        team: "api-devs",
        requestId: "j1",
      }),
    );
    await j1;

    const j2 = waitForMessage(wsB);
    wsB.send(
      JSON.stringify({
        action: "join_team",
        team: "api-devs",
        requestId: "j2",
      }),
    );
    await j2;

    const msgA = waitForMessage(wsA);
    const msgB = waitForMessage(wsB);

    const resp = await fetch(`${baseUrl}/api/send_team`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: "api-devs", content: "team msg from api" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Msg;
    expect(body.message_id).toBeTruthy();
    expect(body.delivered_to).toBe(2);

    const [a, b] = await Promise.all([msgA, msgB]);
    expect(a.from).toBe("dashboard@hub");
    expect(b.from).toBe("dashboard@hub");
  });

  test("POST /api/send_team with nonexistent team returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/send_team`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: "no-such-team", content: "hello" }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Msg;
    expect(body.error).toBeTruthy();
  });

  test("POST /api/broadcast with missing content returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Msg;
    expect(body.error).toContain("Missing required field");
  });

  test("POST /api/send_team with missing fields returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/send_team`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: "someteam" }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Msg;
    expect(body.error).toContain("Missing required fields");
  });
});
