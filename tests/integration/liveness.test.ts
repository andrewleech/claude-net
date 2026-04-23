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

function connectAgent(port: number, name: string): Promise<AgentConn> {
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
        JSON.stringify({ action: "register", name, requestId: `r-${name}` }),
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
    const initial = entry.lastPongAt.getTime();

    // Wait for multiple ping ticks to exchange a few pong frames.
    await waitMs(350);

    const advanced = entry.lastPongAt.getTime();
    expect(advanced).toBeGreaterThan(initial);
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
