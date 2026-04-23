/**
 * Live smoke tests against the telie hub.
 * Run with: bun scripts/test-telie.ts [hub-url]
 */

import WebSocket from "ws";

const HUB = process.argv[2] ?? "http://telie:4815";
const WS_URL = HUB.replace(/^http/, "ws");

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, detail?: unknown) {
  console.error(
    `  ✗ ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`,
  );
  failed++;
}

function assert(condition: boolean, label: string, detail?: unknown) {
  if (condition) ok(label);
  else fail(label, detail);
}

async function get(path: string): Promise<unknown> {
  const r = await fetch(`${HUB}${path}`);
  return r.json();
}

async function post(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${HUB}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function connectDashboardWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws/dashboard`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForFrame(
  ws: WebSocket,
  predicate: (f: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      const f = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(f)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(f);
      }
    };
    ws.on("message", handler);
  });
}

async function registerAgent(
  ws: WebSocket,
  name: string,
  pluginVersion = "0.1.0",
): Promise<Record<string, unknown>> {
  const rid = `reg-${name}-${Date.now()}`;
  const resp = waitForFrame(
    ws,
    (f) => f.event === "response" && f.requestId === rid,
  );
  ws.send(
    JSON.stringify({
      action: "register",
      name,
      channel_capable: true,
      plugin_version: pluginVersion,
      requestId: rid,
    }),
  );
  return resp;
}

async function wsRequest(
  ws: WebSocket,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rid = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const resp = waitForFrame(
    ws,
    (f) => f.event === "response" && f.requestId === rid,
  );
  ws.send(JSON.stringify({ ...frame, requestId: rid }));
  return resp;
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testHealthAndStatus() {
  console.log("\n── Health & status ──");
  const h = (await get("/health")) as Record<string, unknown>;
  assert(h.status === "ok", "health endpoint returns ok");
  assert(typeof h.uptime === "number", "health has numeric uptime");
  assert(typeof h.agents === "number", "health reports agent count");

  const s = (await get("/api/status")) as Record<string, unknown>;
  assert(typeof s.uptime === "number", "api/status uptime present");
  const ag = s.agents as Record<string, number>;
  assert(typeof ag?.online === "number", "api/status has online count");
}

async function testEventLogRest() {
  console.log("\n── Event log REST ──");

  const all = (await get("/api/events")) as Record<string, unknown>;
  assert(Array.isArray(all.events), "GET /api/events returns events array");
  assert(typeof all.count === "number", "count field present");
  assert(typeof all.capacity === "number", "capacity field present");
  assert(
    (all.capacity as number) === 10000,
    `capacity is 10000 (got ${all.capacity})`,
  );
  assert(typeof all.oldest_ts === "number", "oldest_ts field present");

  // Prefix filter
  const agentOnly = (await get("/api/events?event=agent")) as Record<
    string,
    unknown
  >;
  const agentEvents = agentOnly.events as Array<{ event: string }>;
  assert(
    agentEvents.every((e) => e.event.startsWith("agent.")),
    "event=agent filter returns only agent.* events",
    agentEvents.find((e) => !e.event.startsWith("agent."))?.event,
  );

  // ping.tick events should be present
  const ticks = (await get("/api/events?event=ping.tick&limit=1")) as Record<
    string,
    unknown
  >;
  assert((ticks.count as number) >= 1, "ping.tick events recorded");

  // agent.registered events should be present
  const regs = (await get("/api/events?event=agent.registered")) as Record<
    string,
    unknown
  >;
  assert((regs.count as number) >= 1, "agent.registered events recorded");

  // agent.upgraded events visible (old plugin versions on telie)
  const upgrades = (await get("/api/events?event=agent.upgraded")) as Record<
    string,
    unknown
  >;
  assert(
    (upgrades.count as number) >= 1,
    "agent.upgraded events recorded for old-version plugins",
  );
  const upg = (upgrades.events as Array<Record<string, unknown>>)[0];
  assert(upg?.data !== undefined, "agent.upgraded has data payload");

  // since filter — future ts should return nothing
  const future = Date.now() + 60_000;
  const empty = (await get(`/api/events?since=${future}`)) as Record<
    string,
    unknown
  >;
  assert((empty.count as number) === 0, "since=future returns empty");

  // limit
  const limited = (await get("/api/events?limit=2")) as Record<string, unknown>;
  assert((limited.events as unknown[]).length <= 2, "limit=2 respected");

  // summary
  const summary = (await get("/api/events/summary")) as Record<string, unknown>;
  assert(typeof summary.window_ms === "number", "summary window_ms present");
  assert((summary.window_ms as number) > 0, "summary window_ms positive");
  assert(typeof summary.total === "number", "summary total present");
  const counts = summary.counts as Record<string, number>;
  assert((counts["ping.tick"] ?? 0) >= 1, "summary counts ping.tick");
  assert(
    (counts["agent.registered"] ?? 0) >= 1,
    "summary counts agent.registered",
  );

  // summary since=future → zero
  const emptySummary = (await get(
    `/api/events/summary?since=${future}`,
  )) as Record<string, unknown>;
  assert(
    (emptySummary.total as number) === 0,
    "summary since=future returns total=0",
  );
}

async function testAgentRegistrationAndEvents() {
  console.log("\n── Agent registration & events ──");
  const ws = connectWs();
  const agent = await ws;
  const name = `smoke-test-${Date.now()}:anl@telie-test`;

  // Register with current version — no upgrade event expected
  const resp = await registerAgent(agent, name, "0.1.0");
  assert(resp.ok === true, "register succeeds");

  await new Promise((r) => setTimeout(r, 200));

  // agent.registered in event log
  const regs = (await get(
    `/api/events?event=agent.registered&agent=${encodeURIComponent(name)}`,
  )) as Record<string, unknown>;
  assert(
    (regs.count as number) >= 1,
    "agent.registered recorded after connect",
  );
  const reg = (regs.events as Array<Record<string, unknown>>).at(-1);
  const regData = reg?.data as Record<string, unknown>;
  assert(regData?.fullName === name, "registered event has correct fullName");
  assert(
    regData?.channelCapable === true,
    "registered event records channelCapable=true",
  );
  assert(
    regData?.pluginVersion === "0.1.0",
    "registered event records pluginVersion",
  );
  assert(
    regData?.restored === false,
    "registered event records restored=false",
  );

  // No agent.upgraded — version matched
  const upgrades = (await get(
    `/api/events?event=agent.upgraded&agent=${encodeURIComponent(name)}`,
  )) as Record<string, unknown>;
  assert(
    (upgrades.count as number) === 0,
    "no agent.upgraded for current-version plugin",
  );

  // Old version triggers agent.upgraded
  const ws2 = connectWs();
  const agent2 = await ws2;
  const name2 = `smoke-old-${Date.now()}:anl@telie-test`;
  await registerAgent(agent2, name2, "0.0.0-old");
  await new Promise((r) => setTimeout(r, 200));
  const upgrades2 = (await get(
    `/api/events?event=agent.upgraded&agent=${encodeURIComponent(name2)}`,
  )) as Record<string, unknown>;
  assert(
    (upgrades2.count as number) >= 1,
    "agent.upgraded fires for old-version plugin",
  );
  const upgData = (upgrades2.events as Array<Record<string, unknown>>).at(-1)
    ?.data as Record<string, unknown>;
  assert(
    upgData?.reportedVersion === "0.0.0-old",
    "upgrade event records reportedVersion",
  );
  assert(
    typeof upgData?.currentVersion === "string",
    "upgrade event records currentVersion",
  );

  agent.close();
  agent2.close();
}

async function testDeliveryOutcomes() {
  console.log("\n── Delivery outcomes ──");
  const wsA = await connectWs();
  const wsB = await connectWs();
  const nameA = `smoke-sender-${Date.now()}:anl@telie-test`;
  const nameB = `smoke-recv-${Date.now()}:anl@telie-test`;

  await registerAgent(wsA, nameA);
  await registerAgent(wsB, nameB);

  // Successful direct send
  const inboundP = waitForFrame(wsB, (f) => f.event === "message");
  const sendResp = await wsRequest(wsA, {
    action: "send",
    to: nameB,
    content: "hello telie",
    type: "message",
  });
  assert(sendResp.ok === true, "send to online agent succeeds");
  const sendData = sendResp.data as Record<string, unknown>;
  assert(sendData?.outcome === "delivered", "send response outcome=delivered");
  assert(
    typeof sendData?.message_id === "string",
    "send response has message_id",
  );

  const inbound = await inboundP;
  assert(inbound.from === nameA, "inbound message has correct from");
  assert(
    inbound.content === "hello telie",
    "inbound message has correct content",
  );

  await new Promise((r) => setTimeout(r, 100));

  // message.sent event with outcome=delivered
  const sentEvents = (await get(
    `/api/events?event=message.sent&agent=${encodeURIComponent(nameA)}`,
  )) as Record<string, unknown>;
  const delivered = (sentEvents.events as Array<Record<string, unknown>>).find(
    (e) => (e.data as Record<string, unknown>).outcome === "delivered",
  );
  assert(
    delivered !== undefined,
    "message.sent event with outcome=delivered recorded",
  );
  assert(
    typeof (delivered?.data as Record<string, unknown>)?.elapsedMs === "number",
    "elapsedMs recorded on message.sent",
  );

  // NAK: offline recipient
  const nakResp = await wsRequest(wsA, {
    action: "send",
    to: `nobody-${Date.now()}:x@nowhere`,
    content: "ghost",
    type: "message",
  });
  assert(nakResp.ok === false, "send to offline agent returns ok=false");
  const nakData = nakResp.data as Record<string, unknown>;
  assert(nakData?.outcome === "nak", "NAK response has outcome=nak");
  assert(
    nakData?.reason === "offline",
    `NAK reason=offline (got ${nakData?.reason})`,
  );

  await new Promise((r) => setTimeout(r, 100));

  // message.sent event with outcome=nak
  const nakEvents = (await get(
    `/api/events?event=message.sent&agent=${encodeURIComponent(nameA)}`,
  )) as Record<string, unknown>;
  const nakEntry = (nakEvents.events as Array<Record<string, unknown>>).find(
    (e) => (e.data as Record<string, unknown>).outcome === "nak",
  );
  assert(nakEntry !== undefined, "message.sent NAK event recorded");
  assert(
    (nakEntry?.data as Record<string, unknown>)?.reason === "offline",
    "NAK event has reason=offline",
  );
  assert(
    (nakEntry?.data as Record<string, unknown>)?.messageId === null,
    "NAK event has messageId=null",
  );

  // REST /api/send also emits events
  const restResp = (await post("/api/send", {
    to: nameB,
    content: "from dashboard",
  })) as Record<string, unknown>;
  assert(
    restResp.delivered === true,
    "REST /api/send delivers to online agent",
  );
  await new Promise((r) => setTimeout(r, 100));
  const restSent = (await get(
    `/api/events?event=message.sent&agent=${encodeURIComponent("dashboard@hub")}`,
  )) as Record<string, unknown>;
  assert(
    (restSent.count as number) >= 1,
    "REST /api/send emits message.sent event",
  );

  wsA.close();
  wsB.close();
}

async function testQueryEventsWsFrame() {
  console.log("\n── query_events WS frame ──");
  const ws = await connectWs();
  const name = `smoke-qe-${Date.now()}:anl@telie-test`;
  await registerAgent(ws, name);

  // Successful query
  const resp = await wsRequest(ws, { action: "query_events" });
  assert(resp.ok === true, "query_events returns ok=true for registered agent");
  const data = resp.data as Record<string, unknown>;
  assert(Array.isArray(data.events), "query_events data has events array");
  assert(typeof data.count === "number", "query_events data has count");
  assert(typeof data.capacity === "number", "query_events data has capacity");
  assert(typeof data.oldest_ts === "number", "query_events data has oldest_ts");

  // Filter by event type
  const filteredResp = await wsRequest(ws, {
    action: "query_events",
    event: "message",
  });
  const filteredData = filteredResp.data as Record<string, unknown>;
  const filteredEvents = filteredData.events as Array<{ event: string }>;
  assert(
    filteredEvents.every((e) => e.event.startsWith("message.")),
    "query_events event filter returns only message.* events",
  );

  // Unregistered agent gets error
  const ws2 = await connectWs();
  const unregResp = await wsRequest(ws2, { action: "query_events" });
  assert(unregResp.ok === false, "query_events fails for unregistered agent");

  ws.close();
  ws2.close();
}

async function testPingLiveness() {
  console.log("\n── Ping / liveness ──");

  // ping.tick events are being emitted every 5s; at least one should exist
  const ticks = (await get("/api/events?event=ping.tick")) as Record<
    string,
    unknown
  >;
  assert((ticks.count as number) >= 1, "ping.tick events present in log");
  const tick = (ticks.events as Array<Record<string, unknown>>).at(-1);
  const tickData = tick?.data as Record<string, unknown>;
  assert(typeof tickData?.agentCount === "number", "ping.tick has agentCount");
  assert(
    typeof tickData?.evictedCount === "number",
    "ping.tick has evictedCount",
  );

  // Verify ping responds to a registered agent
  const ws = await connectWs();
  const name = `smoke-ping-${Date.now()}:anl@telie-test`;
  await registerAgent(ws, name);

  const pongP = waitForFrame(
    ws,
    (f) =>
      f.event === "message" &&
      typeof f.content === "string" &&
      (f.content as string).startsWith("claude-net channel active"),
  );
  const pingResp = await wsRequest(ws, { action: "ping" });
  assert(pingResp.ok === true, "ping returns ok=true");

  const pong = await pongP;
  assert(pong.from === "hub@claude-net", "ping echo comes from hub@claude-net");
  assert(
    (pong.content as string).includes(name),
    "ping echo content includes registered name",
  );

  ws.close();
}

async function testChannelCapabilityFlag() {
  console.log("\n── Channel capability flag ──");
  const ws = await connectWs();
  const name = `smoke-cap-${Date.now()}:anl@telie-test`;

  // Register with channel_capable: false
  const rid = `reg-cap-${Date.now()}`;
  const resp = waitForFrame(
    ws,
    (f) => f.event === "response" && f.requestId === rid,
  );
  ws.send(
    JSON.stringify({
      action: "register",
      name,
      channel_capable: false,
      plugin_version: "0.1.0",
      requestId: rid,
    }),
  );
  await resp;
  await new Promise((r) => setTimeout(r, 100));

  const regs = (await get(
    `/api/events?event=agent.registered&agent=${encodeURIComponent(name)}`,
  )) as Record<string, unknown>;
  const regData = (regs.events as Array<Record<string, unknown>>).at(-1)
    ?.data as Record<string, unknown>;
  assert(
    regData?.channelCapable === false,
    "channelCapable=false recorded when agent registers without channels",
  );

  // Broadcast should skip no-channel agents
  const wsB = await connectWs();
  const nameB = `smoke-bc-${Date.now()}:anl@telie-test`;
  await registerAgent(wsB, nameB);

  const bcResp = await wsRequest(wsB, {
    action: "broadcast",
    content: "test bc",
  });
  assert(bcResp.ok === true, "broadcast succeeds");
  const bcData = bcResp.data as Record<string, unknown>;
  // The no-channel agent should be counted in skipped
  assert(
    typeof bcData?.skipped_no_channel === "number",
    "broadcast response has skipped_no_channel",
  );

  ws.close();
  wsB.close();
}

async function testDashboardSystemEvent() {
  console.log("\n── Dashboard system:event broadcast ──");
  const dash = await connectDashboardWs();

  // Drain initial state
  await new Promise((r) => setTimeout(r, 200));

  // Listen for system:event with agent.registered
  const sysEventP = waitForFrame(
    dash,
    (f) => f.event === "system:event" && f.name === "agent.registered",
    4000,
  );

  const agentWs = await connectWs();
  const name = `smoke-dash-${Date.now()}:anl@telie-test`;
  await registerAgent(agentWs, name);

  const sysEvent = await sysEventP;
  assert(sysEvent.event === "system:event", "dashboard receives system:event");
  assert(
    sysEvent.name === "agent.registered",
    "system:event name is agent.registered",
  );
  assert(typeof sysEvent.ts === "number", "system:event has ts");
  const sysData = sysEvent.data as Record<string, unknown>;
  assert(
    sysData?.fullName === name,
    "system:event data.fullName matches registered agent",
  );
  assert(
    sysData?.channelCapable === true,
    "system:event data.channelCapable correct",
  );

  dash.close();
  agentWs.close();
}

async function testDisconnectEvent() {
  console.log("\n── Disconnect event ──");
  const ws = await connectWs();
  const name = `smoke-disc-${Date.now()}:anl@telie-test`;
  await registerAgent(ws, name);

  ws.close();
  await new Promise((r) => setTimeout(r, 300));

  const discs = (await get(
    `/api/events?event=agent.disconnected&agent=${encodeURIComponent(name)}`,
  )) as Record<string, unknown>;
  assert(
    (discs.count as number) >= 1,
    "agent.disconnected event recorded on close",
  );
  const disc = (discs.events as Array<Record<string, unknown>>).at(-1);
  const discData = disc?.data as Record<string, unknown>;
  assert(
    discData?.reason === "close",
    `disconnect reason=close (got ${discData?.reason})`,
  );
  assert(discData?.fullName === name, "disconnect event has correct fullName");
}

async function testAgentFilter() {
  console.log("\n── Agent filter in queries ──");
  const ws = await connectWs();
  const uniqueToken = `filter-${Date.now()}`;
  const name = `${uniqueToken}:anl@telie-test`;
  await registerAgent(ws, name);
  await new Promise((r) => setTimeout(r, 100));

  const filtered = (await get(
    `/api/events?agent=${encodeURIComponent(uniqueToken)}`,
  )) as Record<string, unknown>;
  assert(
    (filtered.count as number) >= 1,
    "agent filter returns events for that agent",
  );
  const events = filtered.events as Array<Record<string, unknown>>;
  assert(
    events.every((e) => {
      const d = e.data as Record<string, unknown>;
      return (
        (typeof d.fullName === "string" && d.fullName.includes(uniqueToken)) ||
        (typeof d.from === "string" && d.from.includes(uniqueToken)) ||
        (typeof d.to === "string" && d.to.includes(uniqueToken))
      );
    }),
    "agent filter only returns events mentioning that agent",
  );

  ws.close();
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Running live tests against ${HUB}\n`);

  const suites = [
    testHealthAndStatus,
    testEventLogRest,
    testAgentRegistrationAndEvents,
    testDeliveryOutcomes,
    testQueryEventsWsFrame,
    testPingLiveness,
    testChannelCapabilityFlag,
    testDashboardSystemEvent,
    testDisconnectEvent,
    testAgentFilter,
  ];

  for (const suite of suites) {
    try {
      await suite();
    } catch (err) {
      fail(
        `${suite.name} threw unexpectedly`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `\n${passed + failed} checks: ${passed} passed, ${failed} failed`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
