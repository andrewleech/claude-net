// End-to-end for host_session_orphan: a mirror-agent daemon that confirms
// (via kill(pid, 0) -> ESRCH in real life) that a plugin's ccPid no longer
// exists on its host reports that back over /ws/host, and the hub drops the
// matching zombie plugin registration instead of re-probing it forever on
// every future host_register.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventLog } from "@/hub/event-log";
import { HostRegistry } from "@/hub/host-registry";
import { MirrorRegistry } from "@/hub/mirror";
import { Registry } from "@/hub/registry";
import { Router } from "@/hub/router";
import { Teams } from "@/hub/teams";
import { broadcastToDashboards, wsDashboardPlugin } from "@/hub/ws-dashboard";
import { setHostWsDashboardBroadcast, wsHostPlugin } from "@/hub/ws-host";
import { setDashboardBroadcast, wsPlugin } from "@/hub/ws-plugin";
import { Elysia } from "elysia";

type Msg = Record<string, unknown>;

function startHub() {
  const registry = new Registry();
  const teams = new Teams(registry);
  const router = new Router(registry, teams);
  const eventLog = new EventLog(100);
  const hostRegistry = new HostRegistry();
  // Sweeps off — nothing in this test should self-heal via mirror's own
  // orphan/retention timers, only via the host_session_orphan path.
  const mirrorRegistry = new MirrorRegistry({
    transcriptRing: 50,
    retentionMs: 60_000,
    orphanCloseMs: 0,
    neverActiveMs: 0,
  });

  setDashboardBroadcast(broadcastToDashboards);
  setHostWsDashboardBroadcast(broadcastToDashboards);
  hostRegistry.setDashboardBroadcast(broadcastToDashboards);

  let app = new Elysia();
  app = wsDashboardPlugin(app, registry, teams, hostRegistry);
  app = wsPlugin(
    app,
    registry,
    teams,
    router,
    eventLog,
    mirrorRegistry,
    0,
    hostRegistry,
  );
  app = wsHostPlugin(
    app,
    hostRegistry,
    registry,
    mirrorRegistry,
    undefined,
    eventLog,
  );
  app.listen(0);

  // biome-ignore lint/style/noNonNullAssertion: server is guaranteed after listen
  const port = app.server!.port;
  return {
    port,
    registry,
    hostRegistry,
    stop: () => {
      app.stop();
      mirrorRegistry.stop();
    },
  };
}

async function connectPlugin(
  port: number,
  name: string,
  ccPid: number,
  cwd: string,
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          action: "register",
          name,
          channel_capable: false,
          cc_pid: ccPid,
          cwd,
          requestId: "reg-1",
        }),
      );
    });
    ws.addEventListener("message", (e) => {
      const frame = JSON.parse(e.data as string) as Msg;
      if (frame.event === "registered") resolve({ close: () => ws.close() });
    });
    ws.addEventListener("error", reject);
  });
}

/** Mock daemon: records every frame the hub sends it. */
async function connectDaemon(
  port: number,
  hostId: string,
): Promise<{ ws: WebSocket; frames: Msg[]; close: () => void }> {
  const frames: Msg[] = [];
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
    });
    ws.addEventListener("message", (e) => {
      const frame = JSON.parse(e.data as string) as Msg;
      frames.push(frame);
      if (frame.event === "host_registered")
        resolve({ ws, frames, close: () => ws.close() });
    });
    ws.addEventListener("error", reject);
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("host_session_orphan", () => {
  let hub: ReturnType<typeof startHub>;

  beforeEach(() => {
    hub = startHub();
  });
  afterEach(() => {
    hub.stop();
  });

  test("daemon-confirmed-dead ccPid drops the zombie plugin registration", async () => {
    const hostId = "orphanuser@orphanhost";
    const agentName = "orphantest:orphanuser@orphanhost";
    const ccPid = 999999;

    const plugin = await connectPlugin(
      hub.port,
      agentName,
      ccPid,
      "/home/orphanuser/proj",
    );
    expect(hub.registry.getByFullName(agentName)).not.toBeNull();

    const daemon = await connectDaemon(hub.port, hostId);
    // The hub probes for this ccPid immediately on host_register since no
    // mirror session exists for it yet.
    await waitFor(
      () =>
        daemon.frames.some(
          (f) => f.action === "host_session_probe" && f.cc_pid === ccPid,
        ),
      "initial host_session_probe",
    );

    // The daemon confirms (via its own /proc check) that the pid is gone.
    daemon.ws.send(
      JSON.stringify({ action: "host_session_orphan", cc_pid: ccPid }),
    );

    await waitFor(
      () => hub.registry.getByFullName(agentName) === null,
      "registration removed",
    );

    daemon.close();
    plugin.close();
  });

  test("a since-removed ccPid is never re-probed on a later host_register", async () => {
    const hostId = "orphanuser2@orphanhost2";
    const agentName = "orphantest2:orphanuser2@orphanhost2";
    const ccPid = 888888;

    const plugin = await connectPlugin(
      hub.port,
      agentName,
      ccPid,
      "/home/orphanuser2/proj",
    );
    const daemon1 = await connectDaemon(hub.port, hostId);
    await waitFor(
      () =>
        daemon1.frames.some(
          (f) => f.action === "host_session_probe" && f.cc_pid === ccPid,
        ),
      "initial host_session_probe",
    );
    daemon1.ws.send(
      JSON.stringify({ action: "host_session_orphan", cc_pid: ccPid }),
    );
    await waitFor(
      () => hub.registry.getByFullName(agentName) === null,
      "registration removed",
    );
    daemon1.close();

    // Reconnect — the scenario that used to re-trigger the probe loop
    // forever (ws-host.ts's host_register handler re-scans registry.agents
    // for this host on every reconnect).
    const daemon2 = await connectDaemon(hub.port, hostId);
    await new Promise((r) => setTimeout(r, 200));
    expect(daemon2.frames.some((f) => f.action === "host_session_probe")).toBe(
      false,
    );

    daemon2.close();
    plugin.close();
  });
});
