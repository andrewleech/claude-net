import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { EventLog } from "@/hub/event-log";
import { MirrorRegistry } from "@/hub/mirror";
import { Registry } from "@/hub/registry";
import { Router } from "@/hub/router";
import { Teams } from "@/hub/teams";
import { setDashboardBroadcast, wsPlugin } from "@/hub/ws-plugin";
import { Elysia } from "elysia";

// Generic record type for parsed WS messages in tests
type Msg = Record<string, unknown>;

function createHub() {
  const registry = new Registry({ disconnectTimeoutMs: 200 });
  const teams = new Teams(registry);
  const router = new Router(registry, teams);
  const mirror = new MirrorRegistry({ orphanCloseMs: 0 });

  registry.setTimeoutCleanup((fullName, agentTeams) => {
    for (const teamName of agentTeams) {
      teams.leave(teamName, fullName);
    }
  });

  // Forward half of the (host, cc_pid) join — same wiring as prod.
  mirror.setAgentLookup(
    (host, ccPid) => registry.findByHostPid(host, ccPid)?.fullName ?? null,
  );

  const eventLog = new EventLog(100);
  let app = new Elysia();
  app = wsPlugin(app, registry, teams, router, eventLog, mirror);
  app.listen(0); // random port

  return { app, registry, teams, router, mirror, eventLog };
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

  async function registerAgent(
    ws: WebSocket,
    name: string,
    channel_capable = true,
  ): Promise<Msg[]> {
    const msgs = collectMessages(ws, 2); // registered + response
    ws.send(
      JSON.stringify({
        action: "register",
        name,
        channel_capable,
        requestId: `reg-${name}`,
      }),
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
    expect((resp.data as Msg)?.mailbox).toBe(false);
    expect(teamMsg.from).toBe("proj:tmem1@host");
    expect(teamMsg.team).toBe("devs");
  });

  test("send_team success response reports mailbox:true when an offline member was deposited alongside a live delivery", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAgent(wsA, "proj:tmpartial1@host");
    await registerAgent(wsB, "proj:tmpartial2@host");

    const joinP1 = waitForMessage(wsA);
    wsA.send(
      JSON.stringify({
        action: "join_team",
        team: "partial-devs",
        requestId: "jtp-1",
      }),
    );
    await joinP1;
    const joinP2 = waitForMessage(wsB);
    wsB.send(
      JSON.stringify({
        action: "join_team",
        team: "partial-devs",
        requestId: "jtp-2",
      }),
    );
    await joinP2;

    // A third member joins then drops offline, leaving a stale team
    // membership that should still get a mailbox deposit.
    const wsC = await connect();
    await registerAgent(wsC, "proj:tmpartial3@host");
    const joinP3 = waitForMessage(wsC);
    wsC.send(
      JSON.stringify({
        action: "join_team",
        team: "partial-devs",
        requestId: "jtp-3",
      }),
    );
    await joinP3;
    wsC.close();
    await new Promise((r) => setTimeout(r, 50));

    const teamMsgP = waitForMessage(wsB);
    const respP = waitForMessage(wsA);
    wsA.send(
      JSON.stringify({
        action: "send_team",
        team: "partial-devs",
        content: "partial delivery",
        type: "message",
        requestId: "stp-1",
      }),
    );
    const [, resp] = await Promise.all([teamMsgP, respP]);
    expect(resp.ok).toBe(true);
    expect((resp.data as Msg)?.delivered_to).toBe(1);
    // A team send that live-delivers to only some members must surface
    // that the rest were still mailboxed, not just "delivered_to: 1"
    // with no signal about the others.
    expect((resp.data as Msg)?.mailbox).toBe(true);
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

  test("send NAK to a never-seen agent reports mailbox: false and says so in the error", async () => {
    const ws = await connect();
    await registerAgent(ws, "proj:mbnak1@host");

    const respP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "send",
        to: "proj:ghost@host",
        content: "hi",
        type: "message",
        requestId: "nak-1",
      }),
    );
    const resp = await respP;
    expect(resp.ok).toBe(false);
    expect((resp.data as Msg)?.mailbox).toBe(false);
    expect(resp.error).toContain("NOT recorded");
  });

  test("send NAK to a previously-seen offline agent reports mailbox: true", async () => {
    const wsA = await connect();
    const wsB = await connect();
    await registerAgent(wsA, "proj:mbnak2@host");
    await registerAgent(wsB, "proj:mbnak2target@host");
    wsB.close();
    await new Promise((r) => setTimeout(r, 50));

    const respP = waitForMessage(wsA);
    wsA.send(
      JSON.stringify({
        action: "send",
        to: "proj:mbnak2target@host",
        content: "hi",
        type: "message",
        requestId: "nak-2",
      }),
    );
    const resp = await respP;
    expect(resp.ok).toBe(false);
    expect((resp.data as Msg)?.mailbox).toBe(true);
    expect(resp.error).toContain("recorded to their mailbox");
  });

  test("a malformed field (wrong type) is rejected with an error, not a crashed connection", async () => {
    const ws = await connect();
    await registerAgent(ws, "proj:malformed@host");

    const respP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "send",
        to: 12345,
        content: "hi",
        type: "message",
        requestId: "bad-1",
      }),
    );
    const resp = await respP;
    expect(resp.ok).toBe(false);
    // The catch-all no longer brands every escaped exception "Malformed
    // frame" — a genuine internal bug should read the same way as a
    // client-side type error, since neither can be distinguished from
    // the caught error alone.
    expect(resp.error).toContain("Internal error handling 'send'");

    // The socket must still be usable afterward.
    const followupP = waitForMessage(ws);
    ws.send(JSON.stringify({ action: "list_agents", requestId: "bad-2" }));
    const followup = await followupP;
    expect(followup.ok).toBe(true);
  });

  test("a throw from the dispatch.error logging call itself does not crash the connection", async () => {
    // Force eventLog.push (invoked from the catch's own `emit` call) to
    // throw, simulating a broken listener — must not escape the outer
    // try/catch and take the WS message handler down with it.
    hub.eventLog.setListener(() => {
      throw new Error("listener boom");
    });

    const ws = await connect();
    await registerAgent(ws, "proj:dispatcherror@host");

    const respP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "send",
        to: 12345,
        content: "hi",
        type: "message",
        requestId: "dispatch-err-1",
      }),
    );
    const resp = await respP;
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Internal error handling 'send'");

    // The socket must still be usable afterward.
    const followupP = waitForMessage(ws);
    ws.send(
      JSON.stringify({ action: "list_agents", requestId: "dispatch-err-2" }),
    );
    const followup = await followupP;
    expect(followup.ok).toBe(true);

    // Restore — `hub` is shared across every test in this file.
    hub.eventLog.setListener(() => {});
  });

  test("a throw after a handler already sent a successful response does not send a second, contradictory one", async () => {
    const ws = await connect();
    setDashboardBroadcast(() => {
      throw new Error("boom");
    });
    try {
      const framesP = collectMessages(ws, 2);
      ws.send(
        JSON.stringify({
          action: "register",
          name: "proj:doublecheck@host",
          channel_capable: false,
          requestId: "dbl-1",
        }),
      );
      const frames = await framesP;
      expect(frames.some((f) => f.event === "registered")).toBe(true);
      expect(frames.some((f) => f.event === "response" && f.ok === true)).toBe(
        true,
      );
      // dashboardBroadcastFn throws after that response was already sent —
      // no further frame should follow for this request.
      await expect(waitForMessage(ws, 300)).rejects.toThrow();
    } finally {
      setDashboardBroadcast(() => {});
    }
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

  test("update_channel_capable flips the registry flag in place", async () => {
    const ws = await connect();
    // Register false (the wire default after the empirical detection
    // change) — the registry should reflect that.
    await registerAgent(ws, "proj:tester@host", false);
    expect(hub.registry.getByFullName("proj:tester@host")?.channelCapable).toBe(
      false,
    );

    const respP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "update_channel_capable",
        channel_capable: true,
        requestId: "upd-1",
      }),
    );
    const resp = await respP;
    expect(resp.ok).toBe(true);
    expect((resp.data as { channel_capable: boolean }).channel_capable).toBe(
      true,
    );
    expect(hub.registry.getByFullName("proj:tester@host")?.channelCapable).toBe(
      true,
    );
  });

  test("update_channel_capable rejects non-boolean values", async () => {
    const ws = await connect();
    await registerAgent(ws, "proj:badtype@host", false);

    const respP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "update_channel_capable",
        channel_capable: "yes",
        requestId: "upd-2",
      }),
    );
    const resp = await respP;
    expect(resp.ok).toBe(false);
    expect(typeof resp.error).toBe("string");
  });

  test("update_channel_capable requires registration", async () => {
    const ws = await connect();
    const respP = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "update_channel_capable",
        channel_capable: true,
        requestId: "upd-3",
      }),
    );
    const resp = await respP;
    expect(resp.ok).toBe(false);
  });

  test("register with matching cc_pid relabels mirror sessions via attachAgent", async () => {
    const ws = await connectWs(port);
    openSockets.push(ws);

    // Seed a mirror session tagged with the (host, cc_pid) the
    // plugin will announce below — back half of the join arrives
    // before the front half.
    hub.mirror.createSession(
      "skydeck:alice@host",
      "/work/skydeck",
      "sid-1",
      "host",
      4242,
    );

    // Register with cc_pid: attachAgent fires and rewrites the session.
    const p1 = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "register",
        name: "thisisnew:alice@host",
        channel_capable: true,
        cc_pid: 4242,
        requestId: "r1",
      }),
    );
    await p1;

    const g1 = hub.mirror.getSession("sid-1");
    expect(g1.ok && g1.entry.ownerAgent).toBe("thisisnew:alice@host");
    expect(hub.registry.agents.has("thisisnew:alice@host")).toBe(true);
  });

  test("register without cc_pid leaves mirror sessions alone (pre-rollout client)", async () => {
    const ws = await connectWs(port);
    openSockets.push(ws);

    hub.mirror.createSession(
      "skydeck:old@host",
      "/work/skydeck",
      "sid-noPid",
      "host",
      5555,
    );

    const p1 = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        action: "register",
        name: "renamed:old@host",
        channel_capable: true,
        requestId: "nopid-1",
      }),
    );
    await p1;

    const gNoPid = hub.mirror.getSession("sid-noPid");
    expect(gNoPid.ok && gNoPid.entry.ownerAgent).toBe("skydeck:old@host");
  });

  describe("get_mailbox", () => {
    test("self-read with no agent arg returns own entry and marks it read", async () => {
      const wsA = await connect();
      const wsB = await connect();
      await registerAgent(wsA, "proj:mbsender@host", false);
      await registerAgent(wsB, "proj:mbreceiver@host", false);

      // channel_capable=false so the send NAKs but still deposits.
      const sendRespP = waitForMessage(wsA);
      wsA.send(
        JSON.stringify({
          action: "send",
          to: "proj:mbreceiver@host",
          content: "for your mailbox",
          type: "message",
          requestId: "mb-send-1",
        }),
      );
      await sendRespP;

      const respP = waitForMessage(wsB);
      wsB.send(JSON.stringify({ action: "get_mailbox", requestId: "mb-1" }));
      const resp = await respP;
      expect(resp.ok).toBe(true);
      const data = resp.data as Msg;
      expect(data.found).toBe(true);
      const entry = data.entry as Msg;
      expect(entry.content).toBe("for your mailbox");
      expect(entry.from).toBe("proj:mbsender@host");
      expect(entry.outcome).toBe("nak");
      expect(entry.reason).toBe("no-channel");
      expect(entry.read_at).toBeNull();

      const resp2P = waitForMessage(wsB);
      wsB.send(JSON.stringify({ action: "get_mailbox", requestId: "mb-2" }));
      const resp2 = await resp2P;
      const entry2 = (resp2.data as Msg).entry as Msg;
      expect(entry2.read_at).not.toBeNull();
    });

    test("reading another agent's mailbox by name does not mark it read", async () => {
      const wsA = await connect();
      const wsB = await connect();
      const wsC = await connect();
      await registerAgent(wsA, "proj:mbsender2@host", false);
      await registerAgent(wsB, "proj:mbreceiver2@host", false);
      await registerAgent(wsC, "proj:mbwatcher@host", false);

      const sendRespP = waitForMessage(wsA);
      wsA.send(
        JSON.stringify({
          action: "send",
          to: "proj:mbreceiver2@host",
          content: "peekable",
          type: "message",
          requestId: "mb-send-2",
        }),
      );
      await sendRespP;

      const respP = waitForMessage(wsC);
      wsC.send(
        JSON.stringify({
          action: "get_mailbox",
          agent: "proj:mbreceiver2@host",
          requestId: "mb-3",
        }),
      );
      const resp = await respP;
      const entry = (resp.data as Msg).entry as Msg;
      expect(entry.content).toBe("peekable");
      expect(entry.read_at).toBeNull();

      const resp2P = waitForMessage(wsC);
      wsC.send(
        JSON.stringify({
          action: "get_mailbox",
          agent: "proj:mbreceiver2@host",
          requestId: "mb-4",
        }),
      );
      const resp2 = await resp2P;
      const entry2 = (resp2.data as Msg).entry as Msg;
      expect(entry2.read_at).toBeNull();
    });

    test("reading a mailbox with no entry returns found: false", async () => {
      const ws = await connect();
      await registerAgent(ws, "proj:mbempty@host", false);

      const respP = waitForMessage(ws);
      ws.send(JSON.stringify({ action: "get_mailbox", requestId: "mb-5" }));
      const resp = await respP;
      expect(resp.ok).toBe(true);
      expect((resp.data as Msg).found).toBe(false);
    });

    test("unregistered sender gets the standard not-registered rejection", async () => {
      const ws = await connect();
      const respP = waitForMessage(ws);
      ws.send(JSON.stringify({ action: "get_mailbox", requestId: "mb-6" }));
      const resp = await respP;
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("Not registered");
    });

    test("rejects a non-string agent field instead of hanging or throwing", async () => {
      const ws = await connect();
      await registerAgent(ws, "proj:mbtypecheck@host", false);

      const respP = waitForMessage(ws);
      ws.send(
        JSON.stringify({
          action: "get_mailbox",
          agent: 123,
          requestId: "mb-7",
        }),
      );
      const resp = await respP;
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("string");

      // The socket must still be usable afterward.
      const followupP = waitForMessage(ws);
      ws.send(JSON.stringify({ action: "get_mailbox", requestId: "mb-8" }));
      const followup = await followupP;
      expect(followup.ok).toBe(true);
    });

    test("resolves a disconnected recipient's mailbox by partial name", async () => {
      const wsA = await connect();
      const wsB = await connect();
      await registerAgent(wsA, "proj:mbsender3@host", false);
      await registerAgent(wsB, "proj:mbrecv3@host", false);

      const sendRespP = waitForMessage(wsA);
      wsA.send(
        JSON.stringify({
          action: "send",
          to: "proj:mbrecv3@host",
          content: "for offline recv3",
          type: "message",
          requestId: "mb-send-3",
        }),
      );
      await sendRespP;
      wsB.close();
      await new Promise((r) => setTimeout(r, 50));

      const respP = waitForMessage(wsA);
      wsA.send(
        JSON.stringify({
          action: "get_mailbox",
          agent: "mbrecv3",
          requestId: "mb-9",
        }),
      );
      const resp = await respP;
      expect(resp.ok).toBe(true);
      const data = resp.data as Msg;
      expect(data.found).toBe(true);
      expect((data.entry as Msg).content).toBe("for offline recv3");
    });

    test("an ambiguous partial agent name surfaces an error instead of a misleading found: false", async () => {
      const wsSender = await connect();
      const wsAmbig1 = await connect();
      const wsAmbig2 = await connect();
      await registerAgent(wsSender, "proj:mbsender5@host", false);
      await registerAgent(wsAmbig1, "proj:mbambig@host1", false);
      await registerAgent(wsAmbig2, "proj:mbambig@host2", false);

      const respP = waitForMessage(wsSender);
      wsSender.send(
        JSON.stringify({
          action: "get_mailbox",
          agent: "mbambig",
          requestId: "mb-11",
        }),
      );
      const resp = await respP;
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("Multiple agents match");
    });

    test("a plain name ambiguous among online agents surfaces an error rather than a different, seen-but-offline agent's mailbox", async () => {
      // Regression: registry.resolve("x") is ambiguous (two live matches),
      // but resolveSeenNameOrAmbiguous("x") matches by session tier and
      // collapses to a single unrelated seen-but-offline agent — get_mailbox
      // must report the live ambiguity, not that agent's mailbox.
      const wsOff = await connect();
      await registerAgent(wsOff, "x:someone@host3", false);
      wsOff.close();
      await new Promise((r) => setTimeout(r, 50));

      const wsSender = await connect();
      await registerAgent(wsSender, "proj:mbsender6@host", false);
      const sendResp = waitForMessage(wsSender);
      wsSender.send(
        JSON.stringify({
          action: "send",
          to: "x:someone@host3",
          content: "SECRET-FOR-SOMEONE",
          requestId: "mb-send-ambig",
        }),
      );
      await sendResp;

      const wsAmbig1 = await connect();
      const wsAmbig2 = await connect();
      await registerAgent(wsAmbig1, "s1:x@host1", false);
      await registerAgent(wsAmbig2, "s2:x@host2", false);

      const respP = waitForMessage(wsSender);
      wsSender.send(
        JSON.stringify({
          action: "get_mailbox",
          agent: "x",
          requestId: "mb-12",
        }),
      );
      const resp = await respP;
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("Multiple agents match");
      expect(resp.error).not.toContain("SECRET-FOR-SOMEONE");
    });

    test("a partial-name peek that resolves to the caller's own identity marks its entry read", async () => {
      const wsSender = await connect();
      const wsSibA = await connect();
      const wsSibB = await connect();
      await registerAgent(wsSender, "proj:mbsibsender@host", false);
      await registerAgent(wsSibA, "sessA:mbsib@laptop", true);
      await registerAgent(wsSibB, "sessB:mbsib@laptop", true);

      // Deposit an unread agent-to-agent message in sessB's mailbox
      // (channel_capable is true for sessB, so use a NAK-producing path:
      // sessA drops offline first, forcing an "offline" deposit).
      wsSibA.close();
      await new Promise((r) => setTimeout(r, 50));

      const sendRespP = waitForMessage(wsSender);
      wsSender.send(
        JSON.stringify({
          action: "send",
          to: "sessB:mbsib@laptop",
          content: "unread agent message",
          type: "message",
          requestId: "mb-sib-send",
        }),
      );
      await sendRespP;

      // sessB peeks at "mbsib@laptop" — with sessA already offline, the
      // only online match is sessB itself, so this resolves to the
      // caller's own identity even though the caller didn't name itself
      // verbatim. resolve() only lands on sessB's own fullName because
      // sessB genuinely is the sole referent, so this counts as a real
      // self-read, not a sibling's peek.
      const respP = waitForMessage(wsSibB);
      wsSibB.send(
        JSON.stringify({
          action: "get_mailbox",
          agent: "mbsib@laptop",
          requestId: "mb-sib-peek",
        }),
      );
      const resp = await respP;
      const entry = (resp.data as Msg).entry as Msg;
      expect(entry.content).toBe("unread agent message");
      // The response snapshot is taken before markRead runs, so it reads
      // null regardless — check the store's persisted state, which is
      // what a later routeSystemNotification's hasUnreadAgentMessage
      // check actually consults.
      expect(
        hub.router.mailbox.get("sessB:mbsib@laptop")?.read_at,
      ).not.toBeNull();
    });
  });

  describe("rename propagates the mailbox slot", () => {
    test("a mailbox entry deposited before a rename is readable under the new name", async () => {
      const wsSender = await connect();
      const wsRenamer = await connect();
      await registerAgent(wsSender, "proj:mbsender4@host", false);
      await registerAgent(wsRenamer, "old:mbrenamer@host", false);

      const sendRespP = waitForMessage(wsSender);
      wsSender.send(
        JSON.stringify({
          action: "send",
          to: "old:mbrenamer@host",
          content: "before rename",
          type: "message",
          requestId: "mb-send-4",
        }),
      );
      await sendRespP;

      // Re-register on the same socket under a new name — a rename.
      // Two frames come back (the "registered" event, then the response
      // to requestId) — wait for both before installing a fresh listener,
      // or the second could be mistaken for the get_mailbox reply below.
      const renameRespP = collectMessages(wsRenamer, 2);
      wsRenamer.send(
        JSON.stringify({
          action: "register",
          name: "new:mbrenamer@host",
          channel_capable: false,
          requestId: "mb-rename-1",
        }),
      );
      await renameRespP;

      const mbRespP = waitForMessage(wsRenamer);
      wsRenamer.send(
        JSON.stringify({ action: "get_mailbox", requestId: "mb-10" }),
      );
      const mbResp = await mbRespP;
      const data = mbResp.data as Msg;
      expect(data.found).toBe(true);
      expect((data.entry as Msg).content).toBe("before rename");
    });

    test("a team send after a rename delivers under the new name, not the dead one", async () => {
      const wsSender = await connect();
      const wsRenamer = await connect();
      await registerAgent(wsSender, "proj:teamsender@host");
      await registerAgent(wsRenamer, "old:teamrenamer@host");

      const joinSenderP = waitForMessage(wsSender);
      wsSender.send(
        JSON.stringify({
          action: "join_team",
          team: "rename-team",
          requestId: "jt-s",
        }),
      );
      await joinSenderP;
      const joinRenamerP = waitForMessage(wsRenamer);
      wsRenamer.send(
        JSON.stringify({
          action: "join_team",
          team: "rename-team",
          requestId: "jt-r",
        }),
      );
      await joinRenamerP;

      // Rename on the same socket — two frames come back (registered +
      // response), as above.
      const renameRespP = collectMessages(wsRenamer, 2);
      wsRenamer.send(
        JSON.stringify({
          action: "register",
          name: "new:teamrenamer@host",
          channel_capable: true,
          requestId: "team-rename-1",
        }),
      );
      await renameRespP;

      const teamMsgP = waitForMessage(wsRenamer);
      const sendRespP = waitForMessage(wsSender);
      wsSender.send(
        JSON.stringify({
          action: "send_team",
          team: "rename-team",
          content: "post-rename broadcast",
          type: "message",
          requestId: "team-send-1",
        }),
      );
      // Await both — resolves only if wsRenamer (now registered as
      // new:teamrenamer@host) actually received the frame, proving
      // delivery reached the live socket under its current name. Awaiting
      // the sender's own response too drains it before the next
      // waitForMessage(wsSender) call below, or that leftover response
      // could be mistaken for the get_mailbox reply.
      const [teamMsg, sendResp] = await Promise.all([teamMsgP, sendRespP]);
      expect(teamMsg.event).toBe("message");
      expect(teamMsg.team).toBe("rename-team");
      expect((sendResp.data as Msg)?.delivered_to).toBe(1);

      // Nothing should have landed in the dead name's mailbox slot.
      const mbRespP = waitForMessage(wsSender);
      wsSender.send(
        JSON.stringify({
          action: "get_mailbox",
          agent: "old:teamrenamer@host",
          requestId: "mb-dead-check",
        }),
      );
      const mbResp = await mbRespP;
      expect((mbResp.data as Msg).found).toBe(false);
    });
  });
});
