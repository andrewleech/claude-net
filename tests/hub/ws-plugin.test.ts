import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Registry } from "@/hub/registry";
import { Router } from "@/hub/router";
import { Teams } from "@/hub/teams";
import { wsPlugin } from "@/hub/ws-plugin";
import { Elysia } from "elysia";

// Generic record type for parsed WS messages in tests
type Msg = Record<string, unknown>;

function createHub() {
  const registry = new Registry({ disconnectTimeoutMs: 200 });
  const teams = new Teams(registry);
  const router = new Router(registry, teams);

  registry.setTimeoutCleanup((fullName, agentTeams) => {
    for (const teamName of agentTeams) {
      teams.leave(teamName, fullName);
    }
  });

  let app = new Elysia();
  app = wsPlugin(app, registry, teams, router);
  app.listen(0); // random port

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

describe("WebSocket Plugin (integration)", () => {
  let hub: ReturnType<typeof createHub>;
  let port: number;
  const openSockets: WebSocket[] = [];

  beforeAll(() => {
    hub = createHub();
    port = hub.app.server?.port ?? 0;
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
    const msgs = collectMessages(ws, 2); // registered + response
    ws.send(
      JSON.stringify({ action: "register", name, requestId: `reg-${name}` }),
    );
    return msgs;
  }

  test("register agent and receive registered event", async () => {
    const ws = await connect();
    const messages = await registerAgent(ws, "proj:alice@host");

    const registered = messages.find((m) => m.event === "registered");
    expect(registered).toBeTruthy();
    expect(registered?.full_name).toBe("proj:alice@host");
    expect(registered?.name).toBe("proj");

    const response = messages.find((m) => m.event === "response");
    expect(response).toBeTruthy();
    expect(response?.ok).toBe(true);
    expect(response?.requestId).toBe("reg-proj:alice@host");
  });

  test("send message between two agents", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAgent(wsA, "proj:sender@host");
    await registerAgent(wsB, "proj:receiver@host");

    const inboundP = waitForMessage(wsB);
    const responseP = waitForMessage(wsA);

    wsA.send(
      JSON.stringify({
        action: "send",
        to: "proj:receiver@host",
        content: "hello there",
        type: "message",
        requestId: "msg-1",
      }),
    );

    const [inbound, response] = await Promise.all([inboundP, responseP]);

    expect(response.event).toBe("response");
    expect(response.ok).toBe(true);
    expect((response.data as Msg)?.delivered).toBe(true);

    expect(inbound.event).toBe("message");
    expect(inbound.from).toBe("proj:sender@host");
    expect(inbound.content).toBe("hello there");
    expect(inbound.message_id).toBeTruthy();
  });

  test("broadcast from one agent to others", async () => {
    const wsA = await connect();
    const wsB = await connect();
    const wsC = await connect();
    await registerAgent(wsA, "proj:broadcaster@host");
    await registerAgent(wsB, "proj:listener1@host");
    await registerAgent(wsC, "proj:listener2@host");

    const msgB = waitForMessage(wsB);
    const msgC = waitForMessage(wsC);
    const responseA = waitForMessage(wsA);

    wsA.send(
      JSON.stringify({
        action: "broadcast",
        content: "hey everyone",
        requestId: "bc-1",
      }),
    );

    const [bMsg, cMsg, aResp] = await Promise.all([msgB, msgC, responseA]);

    expect(aResp.ok).toBe(true);
    expect((aResp.data as Msg)?.delivered_to).toBe(2);
    expect(bMsg.from).toBe("proj:broadcaster@host");
    expect(cMsg.from).toBe("proj:broadcaster@host");
    expect(bMsg.to).toBe("broadcast");
  });

  test("join team, send team message, verify delivery", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAgent(wsA, "proj:tmem1@host");
    await registerAgent(wsB, "proj:tmem2@host");

    // Both join team
    const joinP1 = waitForMessage(wsA);
    wsA.send(
      JSON.stringify({ action: "join_team", team: "devs", requestId: "jt-1" }),
    );
    const join1 = await joinP1;
    expect(join1.ok).toBe(true);

    const joinP2 = waitForMessage(wsB);
    wsB.send(
      JSON.stringify({ action: "join_team", team: "devs", requestId: "jt-2" }),
    );
    const join2 = await joinP2;
    expect(join2.ok).toBe(true);
    expect((join2.data as Msg)?.members).toContain("proj:tmem1@host");
    expect((join2.data as Msg)?.members).toContain("proj:tmem2@host");

    // Send team message from A
    const teamMsgP = waitForMessage(wsB);
    const respP = waitForMessage(wsA);
    wsA.send(
      JSON.stringify({
        action: "send_team",
        team: "devs",
        content: "team update",
        type: "message",
        requestId: "st-1",
      }),
    );

    const [teamMsg, resp] = await Promise.all([teamMsgP, respP]);
    expect(resp.ok).toBe(true);
    expect((resp.data as Msg)?.delivered_to).toBe(1);
    expect(teamMsg.from).toBe("proj:tmem1@host");
    expect(teamMsg.team).toBe("devs");
  });

  test("disconnect triggers timeout behavior", async () => {
    const ws = await connect();
    await registerAgent(ws, "proj:disconnecter@host");

    // Join a team so disconnect tracking kicks in
    const joinP = waitForMessage(ws);
    ws.send(
      JSON.stringify({ action: "join_team", team: "temp", requestId: "j-1" }),
    );
    await joinP;

    ws.close();
    // Remove from tracking so afterEach doesn't try to close again
    const idx = openSockets.indexOf(ws);
    if (idx >= 0) openSockets.splice(idx, 1);

    // Wait a tick for close handler
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.registry.disconnected.has("proj:disconnecter@host")).toBe(true);

    // Wait for timeout (200ms configured)
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.registry.disconnected.has("proj:disconnecter@host")).toBe(false);
  });

  test("invalid JSON frame returns error event", async () => {
    const ws = await connect();
    const errP = waitForMessage(ws);
    ws.send("not json {{{");
    const err = await errP;
    expect(err.event).toBe("error");
    expect(err.message).toContain("Invalid frame");
  });

  test("unknown action returns error response", async () => {
    const ws = await connect();
    await registerAgent(ws, "proj:unknown@host");

    const respP = waitForMessage(ws);
    ws.send(JSON.stringify({ action: "foobar", requestId: "unk-1" }));
    const resp = await respP;
    expect(resp.event).toBe("response");
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Unknown action");
  });

  test("send without registering returns error", async () => {
    const ws = await connect();
    const respP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "send",
        to: "someone",
        content: "hi",
        type: "message",
        requestId: "noreg-1",
      }),
    );
    const resp = await respP;
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Not registered");
  });

  test("list_agents returns registered agents", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAgent(wsA, "proj:lister@host");
    await registerAgent(wsB, "proj:listed@host");

    const respP = waitForMessage(wsA);
    wsA.send(JSON.stringify({ action: "list_agents", requestId: "la-1" }));
    const resp = await respP;
    expect(resp.ok).toBe(true);
    const names = (resp.data as Msg[]).map((a) => a.name);
    expect(names).toContain("proj:lister@host");
    expect(names).toContain("proj:listed@host");
  });

  test("list_teams returns teams", async () => {
    const ws = await connect();
    await registerAgent(ws, "proj:teamer@host");

    const joinP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "join_team",
        team: "myteam",
        requestId: "jt-x",
      }),
    );
    await joinP;

    const respP = waitForMessage(ws);
    ws.send(JSON.stringify({ action: "list_teams", requestId: "lt-1" }));
    const resp = await respP;
    expect(resp.ok).toBe(true);
    const teamNames = (resp.data as Msg[]).map((t) => t.name);
    expect(teamNames).toContain("myteam");
  });
});
