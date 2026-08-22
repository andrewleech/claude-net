// Tests for HubClient's reconnect guarantees. The failure that motivates
// them: a TCP connection that is accepted but whose WebSocket upgrade is
// never answered leaves `ws` in CONNECTING forever — no error, no close —
// so a client that only reconnects from the close event goes silent and
// the hub eventually ends the session as `agent_timeout`.

import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { HubClient } from "@/mirror-agent/hub-client";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** TCP listener that accepts connections and never answers the upgrade. */
async function startSilentServer(): Promise<{
  port: number;
  connections: number;
}> {
  const state = { port: 0, connections: 0 };
  const sockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    state.connections++;
    sockets.push(sock);
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  state.port = (server.address() as net.AddressInfo).port;
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return state;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

describe("HubClient stalled handshake", () => {
  test("abandons a socket whose upgrade never completes and retries", async () => {
    const server = await startSilentServer();
    const closes: Array<{ code: number; reason: string }> = [];

    const client = new HubClient({
      url: `ws://127.0.0.1:${server.port}/ws/mirror/test`,
      connectTimeoutMs: 100,
      onClose: (code, reason) => closes.push({ code, reason }),
    });
    cleanups.push(() => client.stop());
    client.start();

    // Two attempts proves the client keeps trying rather than wedging on
    // the first stalled handshake.
    await waitFor(() => closes.length >= 2);
    expect(closes[0]).toEqual({ code: 1006, reason: "connect timeout" });
    expect(server.connections).toBeGreaterThanOrEqual(2);
    expect(client.isOpen()).toBe(false);
  });

  test("stop() during a stalled handshake ends the retry loop", async () => {
    const server = await startSilentServer();
    const client = new HubClient({
      url: `ws://127.0.0.1:${server.port}/ws/mirror/test`,
      connectTimeoutMs: 100,
    });
    client.start();
    await waitFor(() => server.connections >= 1);
    client.stop();

    const seen = server.connections;
    await Bun.sleep(400);
    expect(server.connections).toBe(seen);
  });
});

describe("HubClient socket lifecycle", () => {
  test("a socket displaced by a second start() is closed, not stranded", async () => {
    // Nothing else would ever close a socket displaced by openOnce: the
    // handler guards make it inert, not closed, so it would sit ESTAB
    // holding an fd for the life of the process. The server observing a
    // close is the only proof the client let go of it.
    let opens = 0;
    let closes = 0;
    const hub = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("no");
      },
      websocket: {
        open() {
          opens++;
        },
        close() {
          closes++;
        },
        message() {},
      },
    });
    cleanups.push(() => hub.stop(true));

    const client = new HubClient({
      url: `ws://127.0.0.1:${hub.port}/ws/mirror/test`,
    });
    cleanups.push(() => client.stop());

    client.start();
    await waitFor(() => opens >= 1);
    client.start();

    // Second attempt connects, first is retired.
    await waitFor(() => opens >= 2);
    await waitFor(() => closes >= 1);
    await waitFor(() => client.isOpen());
    expect(closes).toBe(1);
  });
});

describe("HubClient reconnect", () => {
  test("reconnects after the hub drops the socket", async () => {
    let opens = 0;
    const hub = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("no");
      },
      websocket: {
        open(ws) {
          opens++;
          if (opens === 1) ws.close();
        },
        message() {},
      },
    });
    cleanups.push(() => hub.stop(true));

    const client = new HubClient({
      url: `ws://127.0.0.1:${hub.port}/ws/mirror/test`,
    });
    cleanups.push(() => client.stop());
    client.start();

    await waitFor(() => opens >= 2);
    await waitFor(() => client.isOpen());
  });
});
