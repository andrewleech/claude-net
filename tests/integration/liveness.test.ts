import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes } from "node:crypto";
import { type Socket, connect } from "node:net";
import { type Hub, createHub } from "@/hub/index";
import { PLUGIN_VERSION_CURRENT } from "@/hub/version";
import WebSocket from "ws";

// ── Helpers ─────────────────────────────────────────────────────────────────

type Msg = Record<string, unknown>;

interface AgentConn {
  ws: WebSocket;
  messages: Msg[];
  fullName: string;
  close: () => void;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function connectAgent(
  port: number,
  name: string,
  channel_capable = true,
): Promise<AgentConn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: Msg[] = [];

    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()) as Msg);
      } catch {
        // ignore non-JSON frames
      }
    });

    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          action: "register",
          name,
          channel_capable,
          requestId: `r-${name}`,
        }),
      );
      const onReg = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString()) as Msg;
        if (msg.event === "registered" && msg.full_name === name) {
          ws.off("message", onReg);
          resolve({
            ws,
            messages,
            fullName: name,
            close: () => {
              try {
                ws.close();
              } catch {
                // ignore
              }
            },
          });
        }
      };
      ws.on("message", onReg);
    });

    ws.once("error", (err) => reject(err));
  });
}

/**
 * Open a raw TCP connection, perform the WS handshake manually, send a
 * single register frame, then do nothing. Crucially: does NOT respond
 * to server-sent ping frames. This is the cleanest half-open
 * simulation available from inside the same process (Bun's ws library
 * does not implement pause(); see the warning emitted on pause()).
 */
function connectSilentAgent(
  port: number,
  name: string,
): Promise<{ socket: Socket; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "localhost");
    socket.once("error", reject);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      const handshake = `GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      socket.write(handshake);

      let buf = Buffer.alloc(0);
      const onHandshake = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const hdrEnd = buf.indexOf("\r\n\r\n");
        if (hdrEnd === -1) return;
        socket.off("data", onHandshake);
        // Discard any frames after the handshake — we don't care about
        // them and will drop everything including pings.
        socket.on("data", () => {});
        // Send the register frame.
        const payload = Buffer.from(
          JSON.stringify({
            action: "register",
            name,
            requestId: `silent-${name}`,
          }),
        );
        if (payload.length > 125) {
          reject(new Error("register payload too large for short-frame form"));
          return;
        }
        const mask = randomBytes(4);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          // Buffer indexed access returns number|undefined in strict
          // TS; the ?? 0 is a no-op at runtime (bounds guaranteed by
          // the for-loop) but keeps the lint rule happy.
          masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
        }
        const frame = Buffer.concat([
          Buffer.from([0x81, 0x80 | payload.length]),
          mask,
          masked,
        ]);
        socket.write(frame);
        resolve({
          socket,
          close: () => {
            try {
              socket.destroy();
            } catch {
              // ignore
            }
          },
        });
      };
      socket.on("data", onHandshake);
    });
  });
}

/**
 * Connect and register, returning the register-response data payload
 * verbatim. Used by FR8 tests that assert the hub emits/omits
 * `upgrade_hint` based on the plugin-reported `plugin_version`.
 *
 * Pass `plugin_version: null` to simulate an old plugin that predates
 * FR8 and omits the field entirely (the JSON.stringify below will
 * drop null values of the shape we set).
 */
function connectAgentWithVersion(
  port: number,
  name: string,
  opts: { plugin_version?: string | null; channel_capable?: boolean } = {},
): Promise<{
  ws: WebSocket;
  messages: Msg[];
  fullName: string;
  registerResponse: Msg;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: Msg[] = [];
    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()) as Msg);
      } catch {
        // ignore
      }
    });
    ws.once("open", () => {
      const reqId = `r-${name}`;
      // Build register frame; omit plugin_version entirely when caller
      // passes null (L9 missing-field simulation).
      const frame: Record<string, unknown> = {
        action: "register",
        name,
        channel_capable: opts.channel_capable ?? true,
        requestId: reqId,
      };
      if (opts.plugin_version !== null) {
        frame.plugin_version = opts.plugin_version ?? PLUGIN_VERSION_CURRENT;
      }
      ws.send(JSON.stringify(frame));
      const onMsg = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString()) as Msg;
        if (msg.event === "response" && msg.requestId === reqId) {
          ws.off("message", onMsg);
          resolve({
            ws,
            messages,
            fullName: name,
            registerResponse: msg,
            close: () => {
              try {
                ws.close();
              } catch {
                // ignore
              }
            },
          });
        }
      };
      ws.on("message", onMsg);
    });
    ws.once("error", reject);
  });
}

function connectDashboard(port: number): Promise<AgentConn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/dashboard`);
    const messages: Msg[] = [];
    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()) as Msg);
      } catch {
        // ignore
      }
    });
    ws.once("open", () =>
      resolve({
        ws,
        messages,
        fullName: "dashboard",
        close: () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      }),
    );
    ws.once("error", (err) => reject(err));
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("channel liveness — hub WS ping/pong", () => {
  let hub: Hub;
  let port: number;
  const conns: AgentConn[] = [];

  beforeAll(() => {
    // 100ms tick, 400ms stale threshold (4 ticks of slack).
    hub = createHub({ pingIntervalMs: 100, staleThresholdMs: 400 });
    hub.app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: server is up after listen
    port = hub.app.server!.port;
  });

  afterAll(() => {
    for (const c of conns) c.close();
    hub.stop();
  });

  afterEach(() => {
    while (conns.length > 0) {
      const c = conns.pop();
      c?.close();
    }
  });

  test("L1 — pong advances lastPongAt", async () => {
    const conn = await connectAgent(port, "live1:alice@test");
    conns.push(conn);

    const entry = hub.registry.getByFullName("live1:alice@test");
    expect(entry).toBeDefined();
    if (!entry) return;
    const initial = entry.lastPongAt;

    await waitMs(350);

    const advanced = entry.lastPongAt;
    expect(advanced).toBeGreaterThan(initial);
  });

  test("L3 — direct send succeeds when both agents are channel-capable", async () => {
    const a = await connectAgent(port, "l3a:alice@test", true);
    const b = await connectAgent(port, "l3b:bob@test", true);
    conns.push(a, b);

    // Wait a moment so both registers settle at the hub.
    await waitMs(30);
    a.messages.length = 0;
    b.messages.length = 0;

    a.ws.send(
      JSON.stringify({
        action: "send",
        to: "l3b:bob@test",
        content: "hello bob",
        type: "message",
        requestId: "l3-send",
      }),
    );

    await waitMs(50);

    const resp = a.messages.find(
      (m) => m.event === "response" && m.requestId === "l3-send",
    );
    expect(resp).toBeDefined();
    expect(resp?.ok).toBe(true);
    const data = resp?.data as Record<string, unknown> | undefined;
    expect(data?.outcome).toBe("delivered");
    expect(data?.message_id).toBeTruthy();

    const inbound = b.messages.find(
      (m) => m.event === "message" && m.from === "l3a:alice@test",
    );
    expect(inbound).toBeDefined();
    expect(inbound?.content).toBe("hello bob");
  });

  test("L4 — direct send NAKs with reason=no-channel when recipient incapable", async () => {
    const a = await connectAgent(port, "l4a:alice@test", true);
    const b = await connectAgent(port, "l4b:bob@test", false);
    conns.push(a, b);

    await waitMs(30);
    a.messages.length = 0;
    b.messages.length = 0;

    a.ws.send(
      JSON.stringify({
        action: "send",
        to: "l4b:bob@test",
        content: "should not arrive",
        type: "message",
        requestId: "l4-send",
      }),
    );

    await waitMs(50);

    const resp = a.messages.find(
      (m) => m.event === "response" && m.requestId === "l4-send",
    );
    expect(resp).toBeDefined();
    expect(resp?.ok).toBe(false);
    const data = resp?.data as Record<string, unknown> | undefined;
    expect(data?.outcome).toBe("nak");
    expect(data?.reason).toBe("no-channel");
    expect(typeof resp?.error).toBe("string");
    expect((resp?.error as string).toLowerCase()).toContain("channel");

    // Recipient must NOT have received an InboundMessageFrame.
    const inbound = b.messages.find((m) => m.event === "message");
    expect(inbound).toBeUndefined();
  });

  test("L5 — broadcast with mixed capability reports skipped_no_channel", async () => {
    const a = await connectAgent(port, "l5a:alice@test", true);
    const b = await connectAgent(port, "l5b:bob@test", true);
    const c = await connectAgent(port, "l5c:carol@test", false);
    conns.push(a, b, c);

    await waitMs(30);
    a.messages.length = 0;
    b.messages.length = 0;
    c.messages.length = 0;

    a.ws.send(
      JSON.stringify({
        action: "broadcast",
        content: "hello team",
        requestId: "l5-bcast",
      }),
    );

    await waitMs(50);

    const resp = a.messages.find(
      (m) => m.event === "response" && m.requestId === "l5-bcast",
    );
    expect(resp).toBeDefined();
    expect(resp?.ok).toBe(true);
    const data = resp?.data as Record<string, unknown> | undefined;
    // Sender excluded (existing behavior). Bob capable → 1 delivered.
    // Carol incapable → 1 skipped.
    expect(data?.delivered_to).toBe(1);
    expect(data?.skipped_no_channel).toBe(1);

    expect(
      b.messages.find((m) => m.event === "message" && m.to === "broadcast"),
    ).toBeDefined();
    expect(
      c.messages.find((m) => m.event === "message" && m.to === "broadcast"),
    ).toBeUndefined();
  });

  test("L6 — dashboard agent:connected event carries channel_capable", async () => {
    const dashboard = await connectDashboard(port);
    conns.push(dashboard);
    // Drain any initial-state frames.
    await waitMs(50);
    dashboard.messages.length = 0;

    const capable = await connectAgent(port, "l6a:alice@test", true);
    conns.push(capable);
    await waitMs(50);

    const connected = dashboard.messages.find(
      (m) => m.event === "agent:connected" && m.full_name === "l6a:alice@test",
    );
    expect(connected).toBeDefined();
    expect(connected?.channel_capable).toBe(true);

    // Disconnect and reconnect with channel_capable=false.
    capable.close();
    await waitMs(50);
    const disconnected = dashboard.messages.find(
      (m) =>
        m.event === "agent:disconnected" && m.full_name === "l6a:alice@test",
    );
    expect(disconnected).toBeDefined();

    dashboard.messages.length = 0;
    const incapable = await connectAgent(port, "l6a:alice@test", false);
    conns.push(incapable);
    await waitMs(50);

    const reconnected = dashboard.messages.find(
      (m) => m.event === "agent:connected" && m.full_name === "l6a:alice@test",
    );
    expect(reconnected).toBeDefined();
    expect(reconnected?.channel_capable).toBe(false);
  });

  test("L7 — plugin_version matches: no upgrade_hint in register response", async () => {
    const conn = await connectAgentWithVersion(port, "l7:alice@test", {
      plugin_version: PLUGIN_VERSION_CURRENT,
    });
    conns.push({
      ws: conn.ws,
      messages: conn.messages,
      fullName: conn.fullName,
      close: conn.close,
    });

    expect(conn.registerResponse.ok).toBe(true);
    const data = conn.registerResponse.data as Record<string, unknown>;
    expect(data.name).toBeDefined();
    expect(data.full_name).toBe("l7:alice@test");
    // Exact match → hub omits the hint entirely.
    expect(data.upgrade_hint).toBeUndefined();
  });

  test("L8 — plugin_version mismatch: upgrade_hint present with versions + install URL", async () => {
    const conn = await connectAgentWithVersion(port, "l8:alice@test", {
      plugin_version: "0.0.1",
    });
    conns.push({
      ws: conn.ws,
      messages: conn.messages,
      fullName: conn.fullName,
      close: conn.close,
    });

    expect(conn.registerResponse.ok).toBe(true);
    const data = conn.registerResponse.data as Record<string, unknown>;
    const hint = data.upgrade_hint;
    expect(typeof hint).toBe("string");
    // Must reference BOTH versions so the user knows what's stale and
    // what they'd be moving to.
    expect(hint).toContain("0.0.1");
    expect(hint).toContain(PLUGIN_VERSION_CURRENT);
    // Must include the curl install command so the fix is self-serve.
    expect(hint).toContain("curl -fsSL");
    expect(hint).toContain("/setup");
    expect(hint).toContain("bash");
  });

  test("L9 — missing plugin_version field: upgrade_hint uses 'unknown'", async () => {
    const conn = await connectAgentWithVersion(port, "l9:alice@test", {
      plugin_version: null, // omit the field from the register frame entirely
    });
    conns.push({
      ws: conn.ws,
      messages: conn.messages,
      fullName: conn.fullName,
      close: conn.close,
    });

    expect(conn.registerResponse.ok).toBe(true);
    const data = conn.registerResponse.data as Record<string, unknown>;
    const hint = data.upgrade_hint;
    expect(typeof hint).toBe("string");
    // The stand-in when the plugin didn't tell us its version.
    expect(hint).toContain("unknown");
    expect(hint).toContain(PLUGIN_VERSION_CURRENT);
    // Rest of the hint is still well-formed.
    expect(hint).toContain("curl -fsSL");
    expect(hint).toContain("/setup");
  });

  test("L2 — stale WS is evicted via the close handler", async () => {
    const dashboard = await connectDashboard(port);
    conns.push(dashboard);

    // Let any dashboard init frames settle, then clear.
    await waitMs(50);
    dashboard.messages.length = 0;

    // Raw TCP socket with manual handshake — never responds to pings.
    const silent = await connectSilentAgent(port, "live2:bob@test");

    // Wait a tick for the register frame to reach the hub.
    await waitMs(50);
    expect(hub.registry.getByFullName("live2:bob@test")).not.toBeNull();

    // pingInterval=100ms, staleThreshold=400ms → eviction fires on the
    // tick after lastPongAt drifts past the threshold (around 500ms).
    // 900ms covers the eviction + close-handler propagation.
    await waitMs(900);

    expect(hub.registry.getByFullName("live2:bob@test")).toBeNull();

    const disconnected = dashboard.messages.find(
      (m) =>
        m.event === "agent:disconnected" && m.full_name === "live2:bob@test",
    );
    expect(disconnected).toBeDefined();

    silent.close();
  });
});
