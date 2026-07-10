// End-to-end for the reconnect feature: POST /api/mirror/:sid/reconnect
// routes a dead session to a `host_launch --resume <sid>` on the owning
// daemon, no-ops an attached session, and reports 503 when the host is
// offline. Also covers resume_sid validation in launchOnHost.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hostPlugin, launchOnHost } from "@/hub/host";
import { HostRegistry } from "@/hub/host-registry";
import { MirrorRegistry, mirrorPlugin } from "@/hub/mirror";
import { Registry } from "@/hub/registry";
import { Teams } from "@/hub/teams";
import { broadcastToDashboards, wsDashboardPlugin } from "@/hub/ws-dashboard";
import { wsHostPlugin } from "@/hub/ws-host";
import { Elysia } from "elysia";

type Msg = Record<string, unknown>;

function startHub() {
  const hostRegistry = new HostRegistry();
  hostRegistry.setDashboardBroadcast(broadcastToDashboards);
  const registry = new Registry();
  const teams = new Teams(registry);
  // Sweeps off so sessions stay exactly as the test sets them up.
  const mirrorRegistry = new MirrorRegistry({
    transcriptRing: 50,
    retentionMs: 60_000,
    orphanCloseMs: 0,
    neverActiveMs: 0,
  });

  let app = new Elysia()
    .use(mirrorPlugin({ mirrorRegistry, hostRegistry }))
    .use(hostPlugin({ hostRegistry }));
  app = wsDashboardPlugin(app, registry, teams, hostRegistry);
  app = wsHostPlugin(app, hostRegistry);
  app.listen(0);

  // biome-ignore lint/style/noNonNullAssertion: server is guaranteed after listen
  const port = app.server!.port;
  return {
    port,
    stop: () => {
      app.stop();
      mirrorRegistry.stop();
    },
    mirrorRegistry,
    hostRegistry,
  };
}

/**
 * Mock daemon that records host_launch RPCs and echoes a success _done.
 * Ignores any other frame (e.g. host_session_probe on register).
 */
async function connectMockDaemon(
  port: number,
  hostId: string,
): Promise<{ close: () => void; launches: Msg[] }> {
  const launches: Msg[] = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/host`);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          action: "host_register",
          host_id: hostId,
          user: hostId.split("@")[0],
          hostname: hostId.split("@")[1],
          home: "/home/x",
          recent_cwds: [],
          allow_dangerous_skip: true,
        }),
      );
      resolve({ close: () => ws.close(), launches });
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (e) => {
      const frame = JSON.parse(e.data as string) as Msg;
      if (frame.action !== "host_launch") return;
      launches.push(frame);
      ws.send(
        JSON.stringify({
          action: "host_launch_done",
          request_id: frame.request_id,
          ok: true,
          tmux_session: "foo",
        }),
      );
    });
  });
}

async function waitForHost(reg: HostRegistry, hostId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (reg.get(hostId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`host ${hostId} never registered`);
}

describe("POST /api/mirror/:sid/reconnect", () => {
  let hub: ReturnType<typeof startHub>;

  beforeEach(() => {
    hub = startHub();
  });
  afterEach(() => {
    hub.stop();
  });

  test("dead session relaunches with resume_sid on the owning host", async () => {
    // Unique host id per launching test — launchOnHost's burst rate limiter
    // is a module-level singleton shared across the whole test process.
    const daemon = await connectMockDaemon(hub.port, "recon1@rha");
    await waitForHost(hub.hostRegistry, "recon1@rha");

    const created = hub.mirrorRegistry.createSession(
      "proj:recon1@rha",
      "/home/alice/projects/foo",
      undefined,
      "rha",
      111,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sid = created.entry.sid;

    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/${sid}/reconnect?host=rha`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as Msg;
    expect(body.ok).toBe(true);

    expect(daemon.launches).toHaveLength(1);
    expect(daemon.launches[0]?.resume_sid).toBe(sid);
    expect(daemon.launches[0]?.cwd).toBe("/home/alice/projects/foo");
    daemon.close();
  });

  test("attached session is a no-op (already_attached), no launch RPC", async () => {
    const daemon = await connectMockDaemon(hub.port, "alice@box");
    await waitForHost(hub.hostRegistry, "alice@box");

    const created = hub.mirrorRegistry.createSession(
      "proj:alice@box",
      "/home/alice/projects/foo",
      undefined,
      "box",
      111,
    );
    if (!created.ok) return;
    // Simulate a bound mirror-agent WS.
    created.entry.agent = {
      ws: { send: () => {} },
      wsIdentity: {},
    } as unknown as typeof created.entry.agent;
    const sid = created.entry.sid;

    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/${sid}/reconnect?host=box`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as Msg;
    expect(body.status).toBe("already_attached");
    expect(daemon.launches).toHaveLength(0);
    daemon.close();
  });

  test("returns 503 when the owning host is offline", async () => {
    // No daemon for bob@ghost.
    const created = hub.mirrorRegistry.createSession(
      "proj:bob@ghost",
      "/home/bob/projects/bar",
      undefined,
      "ghost",
      222,
    );
    if (!created.ok) return;
    const sid = created.entry.sid;

    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/${sid}/reconnect?host=ghost`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(r.status).toBe(503);
    const body = (await r.json()) as Msg;
    expect(String(body.error)).toContain("offline");
  });

  test("derives host_id from an owner name containing a colon", async () => {
    // A /rename title like "feat: x" makes owner_agent "feat: x:carol@box".
    // host_id must be the last-colon suffix (carol@box), not a greedy match.
    // Distinct host from the other launching tests: launchOnHost's burst
    // rate limiter is module-level and keyed by host_id.
    const daemon = await connectMockDaemon(hub.port, "recon2@rhb");
    await waitForHost(hub.hostRegistry, "recon2@rhb");

    const created = hub.mirrorRegistry.createSession(
      "feat: x:recon2@rhb",
      "/home/carol/projects/foo",
      undefined,
      "rhb",
      333,
    );
    if (!created.ok) return;
    const sid = created.entry.sid;

    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/${sid}/reconnect?host=rhb`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(r.status).toBe(200);
    expect(daemon.launches).toHaveLength(1);
    expect(daemon.launches[0]?.resume_sid).toBe(sid);
    daemon.close();
  });

  test("unknown sid returns 404", async () => {
    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/does-not-exist/reconnect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(r.status).toBe(404);
  });
});

describe("launchOnHost resume_sid validation", () => {
  test("rejects a resume_sid with unsafe characters", async () => {
    const reg = new HostRegistry();
    const r = await launchOnHost(reg, "alice@box", {
      cwd: "/home/alice",
      resume_sid: "abc; rm -rf /",
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("resume_sid");
  });

  test("rejects a resume_sid that starts with a dash (argv injection)", async () => {
    const reg = new HostRegistry();
    const r = await launchOnHost(reg, "alice@box", {
      cwd: "/home/alice",
      resume_sid: "-x",
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("resume_sid");
  });

  test("accepts a uuid-shaped resume_sid (host lookup then fails cleanly)", async () => {
    const reg = new HostRegistry();
    // No host registered → validation passes, host lookup 404s.
    const r = await launchOnHost(reg, "alice@box", {
      cwd: "/home/alice",
      resume_sid: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(r.status).toBe(404);
  });
});
