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
import { setupPlugin } from "@/hub/setup";
import { Teams } from "@/hub/teams";
import { broadcastToDashboards, wsDashboardPlugin } from "@/hub/ws-dashboard";
import { setDashboardBroadcast, wsPlugin } from "@/hub/ws-plugin";
import { Elysia } from "elysia";

// ── Types ───────────────────────────────────────────────────────────────────

// Generic record type for parsed WS/JSON messages in tests
type Msg = Record<string, unknown>;

interface AgentConnection {
  ws: WebSocket;
  messages: Msg[];
  waitForMessage: (
    predicate: (msg: Msg) => boolean,
    timeout?: number,
  ) => Promise<Msg>;
  close: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function createHub(disconnectTimeoutMs = 200) {
  const registry = new Registry({ disconnectTimeoutMs });
  const teams = new Teams(registry);
  const router = new Router(registry, teams);
  const startedAt = new Date();

  registry.setTimeoutCleanup((fullName, agentTeams) => {
    for (const teamName of agentTeams) {
      teams.leave(teamName, fullName);
    }
  });

  setDashboardBroadcast(broadcastToDashboards);

  const pluginPath = `${import.meta.dir}/../../src/plugin/plugin.ts`;
  const dashboardPath = `${import.meta.dir}/../../src/hub/dashboard.html`;
  let pluginCache: string | null = null;
  let dashboardCache: string | null = null;

  let app = new Elysia()
    .get("/", async ({ set }) => {
      if (!dashboardCache) {
        const file = Bun.file(dashboardPath);
        dashboardCache = await file.text();
      }
      set.headers["content-type"] = "text/html";
      return dashboardCache;
    })
    .get("/health", () => ({
      status: "ok",
      version: "0.1.0",
      uptime: (Date.now() - startedAt.getTime()) / 1000,
      agents: registry.agents.size,
      teams: teams.teams.size,
    }))
    .get("/plugin.ts", async ({ set }) => {
      if (!pluginCache) {
        const file = Bun.file(pluginPath);
        pluginCache = await file.text();
      }
      set.headers["content-type"] = "text/typescript";
      return pluginCache;
    })
    .use(apiPlugin({ registry, teams, router, startedAt }))
    .use(setupPlugin({ port: 0 }));

  app = wsPlugin(app, registry, teams, router);
  app = wsDashboardPlugin(app, registry, teams);
  app.listen(0);

  // biome-ignore lint/style/noNonNullAssertion: server is guaranteed after listen
  const port = app.server!.port;
  return { app, registry, teams, router, port };
}

function connectWs(port: number, path: string): Promise<AgentConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}${path}`);
    const messages: Msg[] = [];
    const waiters: Array<{
      predicate: (msg: Msg) => boolean;
      resolve: (msg: Msg) => void;
      reject: (err: Error) => void;
    }> = [];

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as Msg;
      messages.push(msg);

      for (let i = waiters.length - 1; i >= 0; i--) {
        // biome-ignore lint/style/noNonNullAssertion: index check guarantees element exists
        const waiter = waiters[i]!;
        if (waiter.predicate(msg)) {
          waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
    });

    ws.addEventListener("open", () => {
      resolve({
        ws,
        messages,
        waitForMessage(predicate, timeout = 5000) {
          // Check existing messages first
          for (const msg of messages) {
            if (predicate(msg)) return Promise.resolve(msg);
          }
          return new Promise<Msg>((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx !== -1) waiters.splice(idx, 1);
              rej(
                new Error(
                  `Timed out waiting for message (${timeout}ms). Received: ${JSON.stringify(messages)}`,
                ),
              );
            }, timeout);
            waiters.push({
              predicate,
              resolve: (msg) => {
                clearTimeout(timer);
                res(msg);
              },
              reject: rej,
            });
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.addEventListener("error", (e) => reject(e));
  });
}

async function connectAgent(
  port: number,
  name: string,
): Promise<AgentConnection> {
  const conn = await connectWs(port, "/ws");
  const requestId = `reg-${name}`;
  conn.ws.send(JSON.stringify({ action: "register", name, requestId }));
  await conn.waitForMessage(
    (m) => m.event === "registered" && m.full_name === name,
  );
  // Also wait for response frame to avoid it mixing into later assertions
  await conn.waitForMessage(
    (m) => m.event === "response" && m.requestId === requestId && m.ok === true,
  );
  return conn;
}

function send(ws: WebSocket, frame: object): void {
  ws.send(JSON.stringify(frame));
}

// Small delay to let async operations propagate
function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("e2e integration", () => {
  let hub: ReturnType<typeof createHub>;
  const connections: AgentConnection[] = [];

  beforeAll(() => {
    hub = createHub(200);
  });

  afterEach(() => {
    for (const conn of connections) {
      try {
        conn.ws.close();
      } catch {
        // ignore close errors on already-closed connections
      }
    }
    connections.length = 0;
  });

  afterAll(() => {
    hub.app.stop();
  });

  function trackConnection(conn: AgentConnection): AgentConnection {
    connections.push(conn);
    return conn;
  }

  // ── Agent registration ──────────────────────────────────────────────────

  describe("agent registration", () => {
    test("two agents register and appear in list", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      trackConnection(await connectAgent(hub.port, "proj:bob@test"));

      send(alice.ws, { action: "list_agents", requestId: "list1" });
      const resp = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "list1",
      );

      expect(resp.ok).toBe(true);
      const agents = resp.data as Msg[];
      const names = agents.map((a) => a.name);
      expect(names).toContain("proj:alice@test");
      expect(names).toContain("proj:bob@test");
    });

    test("duplicate name is rejected", async () => {
      trackConnection(await connectAgent(hub.port, "proj:alice@test"));
      const dup = trackConnection(await connectWs(hub.port, "/ws"));

      send(dup.ws, {
        action: "register",
        name: "proj:alice@test",
        requestId: "dup1",
      });
      const resp = await dup.waitForMessage(
        (m) => m.event === "response" && m.requestId === "dup1" && !m.ok,
      );

      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("already registered");
    });
  });

  // ── Direct messaging ────────────────────────────────────────────────────

  describe("direct messaging", () => {
    test("message delivered with hub-stamped fields", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      const bob = trackConnection(
        await connectAgent(hub.port, "proj:bob@test"),
      );

      send(alice.ws, {
        action: "send",
        to: "proj:bob@test",
        content: "hello bob",
        type: "message",
        requestId: "send1",
      });

      const msg = await bob.waitForMessage(
        (m) => m.event === "message" && m.content === "hello bob",
      );

      expect(msg.from).toBe("proj:alice@test");
      expect(msg.message_id).toBeDefined();
      expect(msg.timestamp).toBeDefined();
      expect(msg.to).toBe("proj:bob@test");

      // Sender gets success response
      const resp = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "send1",
      );
      expect(resp.ok).toBe(true);
      const data = resp.data as Msg;
      expect(data.delivered).toBe(true);
    });

    test("sending to offline agent returns error", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );

      send(alice.ws, {
        action: "send",
        to: "proj:charlie@test",
        content: "hello",
        type: "message",
        requestId: "send2",
      });

      const resp = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "send2",
      );

      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("not online");
    });
  });

  // ── Short name addressing ──────────────────────────────────────────────

  describe("short name addressing", () => {
    test("unique session name resolves correctly", async () => {
      const proj = trackConnection(
        await connectAgent(hub.port, "myproject:alice@laptop"),
      );
      const other = trackConnection(
        await connectAgent(hub.port, "other:bob@desktop"),
      );

      send(other.ws, {
        action: "send",
        to: "myproject",
        content: "short name test",
        type: "message",
        requestId: "short1",
      });

      const msg = await proj.waitForMessage(
        (m) => m.event === "message" && m.content === "short name test",
      );

      expect(msg.from).toBe("other:bob@desktop");
      expect(msg.to).toBe("myproject:alice@laptop");
    });

    test("ambiguous session name returns error", async () => {
      trackConnection(await connectAgent(hub.port, "myproject:alice@laptop"));
      trackConnection(await connectAgent(hub.port, "myproject:bob@desktop"));
      const sender = trackConnection(
        await connectAgent(hub.port, "sender:carol@test"),
      );

      send(sender.ws, {
        action: "send",
        to: "myproject",
        content: "ambiguous",
        type: "message",
        requestId: "amb1",
      });

      const resp = await sender.waitForMessage(
        (m) => m.event === "response" && m.requestId === "amb1",
      );

      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("Multiple agents match");
      expect(resp.error).toContain("myproject:alice@laptop");
      expect(resp.error).toContain("myproject:bob@desktop");
    });

    test("resolve by user@host across sessions", async () => {
      const proj = trackConnection(
        await connectAgent(hub.port, "myproject:alice@laptop"),
      );
      const sender = trackConnection(
        await connectAgent(hub.port, "other:bob@desktop"),
      );

      send(sender.ws, {
        action: "send",
        to: "alice@laptop",
        content: "user@host test",
        type: "message",
        requestId: "uh1",
      });

      const msg = await proj.waitForMessage(
        (m) => m.event === "message" && m.content === "user@host test",
      );

      expect(msg.from).toBe("other:bob@desktop");
      expect(msg.to).toBe("myproject:alice@laptop");
    });

    test("resolve by session:user across hosts", async () => {
      const proj = trackConnection(
        await connectAgent(hub.port, "myproject:alice@laptop"),
      );
      const sender = trackConnection(
        await connectAgent(hub.port, "other:bob@desktop"),
      );

      send(sender.ws, {
        action: "send",
        to: "myproject:alice",
        content: "session:user test",
        type: "message",
        requestId: "su1",
      });

      const msg = await proj.waitForMessage(
        (m) => m.event === "message" && m.content === "session:user test",
      );

      expect(msg.from).toBe("other:bob@desktop");
      expect(msg.to).toBe("myproject:alice@laptop");
    });
  });

  // ── Broadcast ───────────────────────────────────────────────────────────

  describe("broadcast", () => {
    test("delivered to all except sender", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      const bob = trackConnection(
        await connectAgent(hub.port, "proj:bob@test"),
      );
      const charlie = trackConnection(
        await connectAgent(hub.port, "proj:charlie@test"),
      );

      // Clear any prior messages
      bob.messages.length = 0;
      charlie.messages.length = 0;
      alice.messages.length = 0;

      send(alice.ws, {
        action: "broadcast",
        content: "hello everyone",
        requestId: "bc1",
      });

      const bobMsg = await bob.waitForMessage(
        (m) => m.event === "message" && m.content === "hello everyone",
      );
      expect(bobMsg.from).toBe("proj:alice@test");

      const charlieMsg = await charlie.waitForMessage(
        (m) => m.event === "message" && m.content === "hello everyone",
      );
      expect(charlieMsg.from).toBe("proj:alice@test");

      // Sender gets response with delivered_to count
      const resp = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "bc1",
      );
      expect(resp.ok).toBe(true);
      const data = resp.data as Msg;
      expect(data.delivered_to).toBe(2);

      // Alice should NOT have received the broadcast message
      await tick();
      const aliceBroadcast = alice.messages.find(
        (m) => m.event === "message" && m.content === "hello everyone",
      );
      expect(aliceBroadcast).toBeUndefined();
    });
  });

  // ── Team operations ─────────────────────────────────────────────────────

  describe("team operations", () => {
    test("join, send to team, leave, team deleted", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      const bob = trackConnection(
        await connectAgent(hub.port, "proj:bob@test"),
      );

      // Alice joins backend
      send(alice.ws, {
        action: "join_team",
        team: "backend",
        requestId: "jt1",
      });
      const joinResp1 = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "jt1",
      );
      expect(joinResp1.ok).toBe(true);
      const joinData1 = joinResp1.data as Msg;
      expect(joinData1.members).toContain("proj:alice@test");

      // Bob joins backend
      send(bob.ws, {
        action: "join_team",
        team: "backend",
        requestId: "jt2",
      });
      const joinResp2 = await bob.waitForMessage(
        (m) => m.event === "response" && m.requestId === "jt2",
      );
      expect(joinResp2.ok).toBe(true);
      const joinData2 = joinResp2.data as Msg;
      expect(joinData2.members).toContain("proj:bob@test");

      // Alice sends to team
      bob.messages.length = 0;
      alice.messages.length = 0;
      send(alice.ws, {
        action: "send_team",
        team: "backend",
        content: "team msg",
        type: "message",
        requestId: "st1",
      });

      const bobTeamMsg = await bob.waitForMessage(
        (m) => m.event === "message" && m.content === "team msg",
      );
      expect(bobTeamMsg.team).toBe("backend");
      expect(bobTeamMsg.from).toBe("proj:alice@test");

      // Alice should NOT receive her own team message
      await tick();
      const aliceTeamMsg = alice.messages.find(
        (m) => m.event === "message" && m.content === "team msg",
      );
      expect(aliceTeamMsg).toBeUndefined();

      // Bob leaves
      send(bob.ws, {
        action: "leave_team",
        team: "backend",
        requestId: "lt1",
      });
      await bob.waitForMessage(
        (m) => m.event === "response" && m.requestId === "lt1",
      );

      // Alice leaves — team should be deleted
      send(alice.ws, {
        action: "leave_team",
        team: "backend",
        requestId: "lt2",
      });
      const leaveResp = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "lt2",
      );
      const leaveData = leaveResp.data as Msg;
      expect(leaveData.remaining_members).toBe(0);

      // Verify team is gone
      send(alice.ws, { action: "list_teams", requestId: "ltm1" });
      const teamsResp = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "ltm1",
      );
      expect(teamsResp.data).toHaveLength(0);
    });
  });

  // ── Team edge cases ─────────────────────────────────────────────────────

  describe("team edge cases", () => {
    test("send to nonexistent team returns error", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );

      send(alice.ws, {
        action: "send_team",
        team: "nonexistent",
        content: "hello",
        type: "message",
        requestId: "te1",
      });

      const resp = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "te1",
      );
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("does not exist");
    });

    test("send to team with only sender as member returns error", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );

      send(alice.ws, {
        action: "join_team",
        team: "solo",
        requestId: "js1",
      });
      await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "js1",
      );

      send(alice.ws, {
        action: "send_team",
        team: "solo",
        content: "lonely",
        type: "message",
        requestId: "te2",
      });

      const resp = await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "te2",
      );
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("No online members");
    });
  });

  // ── Disconnect and reconnect ──────────────────────────────────────────

  describe("disconnect and reconnect", () => {
    test("team membership preserved within timeout", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      const bob = trackConnection(
        await connectAgent(hub.port, "proj:bob@test"),
      );

      // Alice joins backend
      send(alice.ws, {
        action: "join_team",
        team: "backend",
        requestId: "jtr1",
      });
      await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "jtr1",
      );

      // Close Alice's connection
      alice.ws.close();
      await tick(100);

      // Verify Alice shows as offline via bob's list
      send(bob.ws, { action: "list_agents", requestId: "la1" });
      const listResp = await bob.waitForMessage(
        (m) => m.event === "response" && m.requestId === "la1",
      );
      const agents = listResp.data as Msg[];
      const aliceEntry = agents.find((a) => a.name === "proj:alice@test");
      expect(aliceEntry).toBeDefined();
      expect(aliceEntry?.status).toBe("offline");

      // Team still exists
      send(bob.ws, { action: "list_teams", requestId: "lt1" });
      const teamsResp = await bob.waitForMessage(
        (m) => m.event === "response" && m.requestId === "lt1",
      );
      const teamList = teamsResp.data as Msg[];
      const backendTeam = teamList.find((t) => t.name === "backend");
      expect(backendTeam).toBeDefined();

      // Reconnect as proj:alice@test
      const alice2 = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );

      // Verify alice is online again
      send(alice2.ws, { action: "list_agents", requestId: "la2" });
      const listResp2 = await alice2.waitForMessage(
        (m) => m.event === "response" && m.requestId === "la2",
      );
      const agents2 = listResp2.data as Msg[];
      const aliceEntry2 = agents2.find((a) => a.name === "proj:alice@test");
      expect(aliceEntry2).toBeDefined();
      expect(aliceEntry2?.status).toBe("online");
      expect(aliceEntry2?.teams).toContain("backend");
    });
  });

  // ── Disconnect timeout ────────────────────────────────────────────────

  describe("disconnect timeout", () => {
    test("agent fully removed after timeout expires", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      const bob = trackConnection(
        await connectAgent(hub.port, "proj:bob@test"),
      );

      // Alice joins backend
      send(alice.ws, {
        action: "join_team",
        team: "backend",
        requestId: "jt-to1",
      });
      await alice.waitForMessage(
        (m) => m.event === "response" && m.requestId === "jt-to1",
      );

      // Close Alice
      alice.ws.close();

      // Wait for timeout to expire (200ms configured + buffer)
      await tick(400);

      // Alice should be fully removed
      send(bob.ws, { action: "list_agents", requestId: "la-to1" });
      const listResp = await bob.waitForMessage(
        (m) => m.event === "response" && m.requestId === "la-to1",
      );
      const agents = listResp.data as Msg[];
      const aliceEntry = agents.find((a) => a.name === "proj:alice@test");
      expect(aliceEntry).toBeUndefined();

      // Team should be deleted
      send(bob.ws, { action: "list_teams", requestId: "lt-to1" });
      const teamsResp = await bob.waitForMessage(
        (m) => m.event === "response" && m.requestId === "lt-to1",
      );
      const teamList = teamsResp.data as Msg[];
      const backendTeam = teamList.find((t) => t.name === "backend");
      expect(backendTeam).toBeUndefined();
    });
  });

  // ── Dashboard events ──────────────────────────────────────────────────

  describe("dashboard events", () => {
    test("receives agent:connected, message:routed, team:changed, agent:disconnected", async () => {
      const dashboard = trackConnection(
        await connectWs(hub.port, "/ws/dashboard"),
      );

      // Give dashboard time to receive initial state
      await tick();
      dashboard.messages.length = 0;

      // Register an agent
      const agent = trackConnection(
        await connectAgent(hub.port, "dash-agent:tester@test"),
      );

      const connectedEvt = await dashboard.waitForMessage(
        (m) =>
          m.event === "agent:connected" &&
          m.full_name === "dash-agent:tester@test",
      );
      expect(connectedEvt.name).toBe("dash-agent");

      // Send a message (need a second agent to receive it)
      trackConnection(await connectAgent(hub.port, "dash-recv:tester@test"));
      // Clear dashboard messages after receiver connects
      await tick();
      dashboard.messages.length = 0;

      send(agent.ws, {
        action: "send",
        to: "dash-recv:tester@test",
        content: "dashboard test",
        type: "message",
        requestId: "ds1",
      });

      const routedEvt = await dashboard.waitForMessage(
        (m) => m.event === "message:routed",
      );
      expect(routedEvt.from).toBe("dash-agent:tester@test");
      expect(routedEvt.content).toBe("dashboard test");

      // Join a team
      dashboard.messages.length = 0;
      send(agent.ws, {
        action: "join_team",
        team: "dashteam",
        requestId: "djt1",
      });

      // Should get team:changed with "created" action
      const teamCreatedEvt = await dashboard.waitForMessage(
        (m) =>
          m.event === "team:changed" &&
          m.team === "dashteam" &&
          m.action === "created",
      );
      expect(teamCreatedEvt.members).toContain("dash-agent:tester@test");

      // Disconnect agent
      dashboard.messages.length = 0;
      agent.ws.close();

      const disconnectedEvt = await dashboard.waitForMessage(
        (m) =>
          m.event === "agent:disconnected" &&
          m.full_name === "dash-agent:tester@test",
      );
      expect(disconnectedEvt.name).toBe("dash-agent");
    });
  });

  // ── REST API integration ──────────────────────────────────────────────

  describe("REST API", () => {
    test("POST /api/send delivers to agent", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      alice.messages.length = 0;

      const resp = await fetch(`http://localhost:${hub.port}/api/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: "proj:alice@test",
          content: "hello from dashboard",
        }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Msg;
      expect(body.delivered).toBe(true);

      const msg = await alice.waitForMessage(
        (m) => m.event === "message" && m.content === "hello from dashboard",
      );
      expect(msg.from).toBe("dashboard@hub");
    });

    test("POST /api/broadcast delivers to all agents", async () => {
      const alice = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      const bob = trackConnection(
        await connectAgent(hub.port, "proj:bob@test"),
      );
      alice.messages.length = 0;
      bob.messages.length = 0;

      const resp = await fetch(`http://localhost:${hub.port}/api/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "broadcast from api" }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Msg;
      expect(body.delivered_to).toBe(2);

      await alice.waitForMessage(
        (m) => m.event === "message" && m.content === "broadcast from api",
      );
      await bob.waitForMessage(
        (m) => m.event === "message" && m.content === "broadcast from api",
      );
    });

    test("GET /api/agents returns correct list", async () => {
      trackConnection(await connectAgent(hub.port, "proj:alice@test"));

      const resp = await fetch(`http://localhost:${hub.port}/api/agents`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Msg[];
      const alice = body.find((a) => a.name === "proj:alice@test");
      expect(alice).toBeDefined();
      expect(alice?.status).toBe("online");
    });

    test("GET /api/teams returns correct list", async () => {
      const agent = trackConnection(
        await connectAgent(hub.port, "proj:alice@test"),
      );
      send(agent.ws, {
        action: "join_team",
        team: "apiteam",
        requestId: "apijt1",
      });
      await agent.waitForMessage(
        (m) => m.event === "response" && m.requestId === "apijt1",
      );

      const resp = await fetch(`http://localhost:${hub.port}/api/teams`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Msg[];
      const team = body.find((t) => t.name === "apiteam");
      expect(team).toBeDefined();
      const members = team?.members as Msg[];
      expect(members.length).toBeGreaterThan(0);
    });

    test("GET /api/status returns uptime and counts", async () => {
      trackConnection(await connectAgent(hub.port, "proj:alice@test"));

      const resp = await fetch(`http://localhost:${hub.port}/api/status`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Msg;
      expect(typeof body.uptime).toBe("number");
      expect(body.agents).toBeDefined();
      expect(typeof body.teams).toBe("number");
    });
  });

  // ── Setup endpoint ────────────────────────────────────────────────────

  describe("setup endpoint", () => {
    test("returns valid bash script with claude mcp add", async () => {
      const resp = await fetch(`http://localhost:${hub.port}/setup`);
      expect(resp.status).toBe(200);

      const script = await resp.text();
      expect(script).toContain("#!/bin/bash");
      expect(script).toContain("claude mcp add");
      expect(script).toContain("plugin.ts");
    });
  });

  // ── Plugin serving ────────────────────────────────────────────────────

  describe("plugin serving", () => {
    test("GET /plugin.ts returns TypeScript source", async () => {
      const resp = await fetch(`http://localhost:${hub.port}/plugin.ts`);
      expect(resp.status).toBe(200);

      const source = await resp.text();
      expect(source).toContain("@modelcontextprotocol/sdk");
    });
  });
});
