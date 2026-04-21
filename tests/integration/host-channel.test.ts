// End-to-end: the mirror-agent's host-channel opens /ws/host, sends
// host_register, the hub registers it, and disconnecting cleanly removes
// the entry. Also verifies host:connected / host:disconnected flow through
// /ws/dashboard.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HostRegistry } from "@/hub/host-registry";
import { Registry } from "@/hub/registry";
import { Teams } from "@/hub/teams";
import { broadcastToDashboards, wsDashboardPlugin } from "@/hub/ws-dashboard";
import { wsHostPlugin } from "@/hub/ws-host";
import { Elysia } from "elysia";

type Msg = Record<string, unknown>;

interface TestHub {
  port: number;
  stop(): void;
  hostRegistry: HostRegistry;
}

function startHub(): TestHub {
  const hostRegistry = new HostRegistry();
  hostRegistry.setDashboardBroadcast(broadcastToDashboards);
  const registry = new Registry();
  const teams = new Teams(registry);

  let app = new Elysia();
  app = wsDashboardPlugin(app, registry, teams, hostRegistry);
  app = wsHostPlugin(app, hostRegistry);
  app.listen(0);

  // biome-ignore lint/style/noNonNullAssertion: server is guaranteed after listen
  const port = app.server!.port;
  return { port, stop: () => app.stop(), hostRegistry };
}

interface WsConn {
  ws: WebSocket;
  messages: Msg[];
  waitFor: (pred: (m: Msg) => boolean, ms?: number) => Promise<Msg>;
  close: () => void;
}

function connectWs(url: string): Promise<WsConn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Msg[] = [];
    const waiters: Array<{
      pred: (m: Msg) => boolean;
      resolve: (m: Msg) => void;
    }> = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as Msg;
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w?.pred(msg)) {
          w.resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
    ws.addEventListener("open", () => {
      resolve({
        ws,
        messages,
        waitFor: (pred, ms = 2000) =>
          new Promise<Msg>((res, rej) => {
            const existing = messages.find(pred);
            if (existing) {
              res(existing);
              return;
            }
            const t = setTimeout(() => rej(new Error("waitFor timeout")), ms);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          }),
        close: () => ws.close(),
      });
    });
    ws.addEventListener("error", reject);
  });
}

describe("host channel e2e", () => {
  let hub: TestHub;

  beforeEach(() => {
    hub = startHub();
  });

  afterEach(() => {
    hub.stop();
  });

  test("daemon registers → dashboard sees host:connected; disconnect fires host:disconnected", async () => {
    const dashboard = await connectWs(
      `ws://localhost:${hub.port}/ws/dashboard`,
    );
    const host = await connectWs(`ws://localhost:${hub.port}/ws/host`);

    host.ws.send(
      JSON.stringify({
        action: "host_register",
        host_id: "alice@box",
        user: "alice",
        hostname: "box",
        home: "/home/alice",
        recent_cwds: ["/home/alice/projects/demo"],
        allow_dangerous_skip: true,
      }),
    );

    const connected = await dashboard.waitFor(
      (m) => m.event === "host:connected" && m.host_id === "alice@box",
    );
    expect(connected.user).toBe("alice");
    expect(connected.allow_dangerous_skip).toBe(true);
    expect(hub.hostRegistry.hosts.size).toBe(1);

    // Daemon-side ack.
    const ack = await host.waitFor((m) => m.event === "host_registered");
    expect(ack.host_id).toBe("alice@box");

    host.close();

    await dashboard.waitFor(
      (m) => m.event === "host:disconnected" && m.host_id === "alice@box",
    );
    expect(hub.hostRegistry.hosts.size).toBe(0);

    dashboard.close();
  });

  test("GET /api/hosts via the initial state push for a dashboard opened after register", async () => {
    const host = await connectWs(`ws://localhost:${hub.port}/ws/host`);
    host.ws.send(
      JSON.stringify({
        action: "host_register",
        host_id: "late@box",
        user: "late",
        hostname: "box",
        home: "/home/late",
        recent_cwds: [],
        allow_dangerous_skip: false,
      }),
    );
    // Wait until the hub has actually registered before opening the dashboard.
    await new Promise<void>((r) => {
      const tick = () => {
        if (hub.hostRegistry.get("late@box")) r();
        else setTimeout(tick, 10);
      };
      tick();
    });

    const dashboard = await connectWs(
      `ws://localhost:${hub.port}/ws/dashboard`,
    );
    const replay = await dashboard.waitFor(
      (m) => m.event === "host:connected" && m.host_id === "late@box",
    );
    expect(replay.allow_dangerous_skip).toBe(false);

    host.close();
    dashboard.close();
  });
});
