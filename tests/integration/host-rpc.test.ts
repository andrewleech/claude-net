// End-to-end: open a host WS, register, then issue ls / mkdir / launch
// REST requests on the hub and assert the daemon-side handler is invoked
// (via a mock daemon — the WS echoes back _done frames).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hostPlugin } from "@/hub/host";
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

  let app = new Elysia().use(hostPlugin({ hostRegistry }));
  app = wsDashboardPlugin(app, registry, teams, hostRegistry);
  app = wsHostPlugin(app, hostRegistry);
  app.listen(0);

  // biome-ignore lint/style/noNonNullAssertion: server is guaranteed after listen
  const port = app.server!.port;
  return { port, stop: () => app.stop(), hostRegistry };
}

/**
 * Mock daemon. Opens /ws/host, registers, then listens for RPC frames
 * and responds via a test-provided handler.
 */
async function connectMockDaemon(
  port: number,
  opts: {
    hostId: string;
    allowDangerousSkip?: boolean;
    onRpc: (frame: Msg) => Msg | Promise<Msg>;
  },
): Promise<{ ws: WebSocket; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/host`);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          action: "host_register",
          host_id: opts.hostId,
          user: "alice",
          hostname: "box",
          home: "/home/alice",
          recent_cwds: [],
          allow_dangerous_skip: opts.allowDangerousSkip ?? true,
        }),
      );
      resolve({ ws, close: () => ws.close() });
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("message", async (e) => {
      const frame = JSON.parse(e.data as string) as Msg;
      if (frame.event === "host_registered") return;
      // It's an RPC request. Handler returns the response body.
      const response = await opts.onRpc(frame);
      ws.send(JSON.stringify(response));
    });
  });
}

async function waitForHost(
  hostRegistry: HostRegistry,
  hostId: string,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (hostRegistry.get(hostId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`host ${hostId} never registered`);
}

describe("host RPC e2e", () => {
  let hub: TestHub;

  beforeEach(() => {
    hub = startHub();
  });

  afterEach(() => {
    hub.stop();
  });

  test("GET /api/host/:id/ls relays and returns daemon entries", async () => {
    const daemon = await connectMockDaemon(hub.port, {
      hostId: "alice@a",
      onRpc: (frame) => {
        expect(frame.action).toBe("host_ls");
        expect(frame.path).toBe("/home/alice/projects");
        return {
          action: "host_ls_done",
          request_id: frame.request_id,
          entries: [
            { name: "demo", is_dir: true },
            { name: "app", is_dir: true },
          ],
        };
      },
    });
    await waitForHost(hub.hostRegistry, "alice@a");

    const resp = await fetch(
      `http://localhost:${hub.port}/api/host/alice@a/ls?path=/home/alice/projects`,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { entries: Array<{ name: string }> };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].name).toBe("demo");

    daemon.close();
  });

  test("ls surfaces daemon errors as 403", async () => {
    const daemon = await connectMockDaemon(hub.port, {
      hostId: "alice@a",
      onRpc: (frame) => ({
        action: "host_ls_done",
        request_id: frame.request_id,
        error: "path is outside allowed roots",
      }),
    });
    await waitForHost(hub.hostRegistry, "alice@a");

    const resp = await fetch(
      `http://localhost:${hub.port}/api/host/alice@a/ls?path=/etc`,
    );
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("outside");

    daemon.close();
  });

  test("POST /api/host/:id/mkdir relays the path", async () => {
    let received: Msg | null = null;
    const daemon = await connectMockDaemon(hub.port, {
      hostId: "alice@a",
      onRpc: (frame) => {
        received = frame;
        return {
          action: "host_mkdir_done",
          request_id: frame.request_id,
          ok: true,
        };
      },
    });
    await waitForHost(hub.hostRegistry, "alice@a");

    const resp = await fetch(
      `http://localhost:${hub.port}/api/host/alice@a/mkdir`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/home/alice/projects/new" }),
      },
    );
    expect(resp.status).toBe(200);
    expect(received).not.toBeNull();
    expect(received?.action).toBe("host_mkdir");
    expect(received?.path).toBe("/home/alice/projects/new");

    daemon.close();
  });

  test("POST /api/host/:id/launch rejects skip_permissions when not allowed", async () => {
    const daemon = await connectMockDaemon(hub.port, {
      hostId: "alice@a",
      allowDangerousSkip: false,
      onRpc: () => ({
        action: "host_launch_done",
        request_id: "should-not-reach",
      }),
    });
    await waitForHost(hub.hostRegistry, "alice@a");

    const resp = await fetch(
      `http://localhost:${hub.port}/api/host/alice@a/launch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd: "/home/alice/projects/demo",
          skip_permissions: true,
        }),
      },
    );
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("skip_permissions");

    daemon.close();
  });

  test("POST /api/host/:id/launch relays + returns tmux_session", async () => {
    let received: Msg | null = null;
    const daemon = await connectMockDaemon(hub.port, {
      hostId: "alice@a",
      onRpc: (frame) => {
        received = frame;
        return {
          action: "host_launch_done",
          request_id: frame.request_id,
          ok: true,
          tmux_session: "claude-channels-abc123",
        };
      },
    });
    await waitForHost(hub.hostRegistry, "alice@a");

    const resp = await fetch(
      `http://localhost:${hub.port}/api/host/alice@a/launch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd: "/home/alice/projects/demo",
          create_if_missing: true,
          skip_permissions: true,
        }),
      },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      tmux_session: string;
    };
    expect(body.ok).toBe(true);
    expect(body.tmux_session).toBe("claude-channels-abc123");
    expect(received?.cwd).toBe("/home/alice/projects/demo");
    expect(received?.create_if_missing).toBe(true);
    expect(received?.skip_permissions).toBe(true);

    daemon.close();
  });

  test("RPC to an unknown host returns 404", async () => {
    const resp = await fetch(
      `http://localhost:${hub.port}/api/host/ghost@nowhere/ls?path=/tmp`,
    );
    expect(resp.status).toBe(404);
  });
});
