import { readFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { Elysia } from "elysia";
import { apiPlugin } from "./api";
import { binServerPlugin } from "./bin-server";
import { EventLog } from "./event-log";
import { hostPlugin } from "./host";
import { HostRegistry } from "./host-registry";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "./mirror";
import { createStoreFromEnv } from "./mirror-store";
import { Registry } from "./registry";
import { Router } from "./router";
import { setupPlugin } from "./setup";
import { Teams } from "./teams";
import { UploadsRegistry, uploadsPlugin } from "./uploads";
import { broadcastToDashboards, wsDashboardPlugin } from "./ws-dashboard";
import { wsHostPlugin } from "./ws-host";
import { markEvicting, setDashboardBroadcast, wsPlugin } from "./ws-plugin";

export interface CreateHubOptions {
  /** How often to send native WS pings to every registered plugin. */
  pingIntervalMs?: number;
  /**
   * Evict a registered WS whose last pong (or register time) is older
   * than this. 6× pingIntervalMs — wide enough to absorb a two-ping
   * miss during a bursty-latency window (Tailscale DERP hops, WSL2
   * network pauses, event-loop stalls) without churning the
   * connection, while still catching a dead socket in reasonable
   * time.
   */
  staleThresholdMs?: number;
  /**
   * Listen port, threaded through to the WS plugin so the upgrade-hint
   * text can reference a local fallback URL when `CLAUDE_NET_HOST` is
   * unset. Informational only — does not affect what port `app.listen`
   * actually binds to.
   */
  port?: number;
  /**
   * Max entries retained by the hub event log (ring buffer). Defaults
   * to 10_000 — enough for several hours of typical traffic without
   * bloating memory.
   */
  eventLogCapacity?: number;
}

export interface Hub {
  app: Elysia;
  registry: Registry;
  teams: Teams;
  router: Router;
  mirrorRegistry: MirrorRegistry;
  hostRegistry: HostRegistry;
  eventLog: EventLog;
  startedAt: Date;
  /** Stop the ping tick and the Elysia server. Idempotent. */
  stop: () => void;
}

export function createHub(options: CreateHubOptions = {}): Hub {
  const pingIntervalMs = options.pingIntervalMs ?? 5_000;
  const staleThresholdMs = options.staleThresholdMs ?? 30_000;
  const port = options.port ?? (Number(process.env.CLAUDE_NET_PORT) || 4815);
  const startedAt = new Date();

  const registry = new Registry();
  const teams = new Teams(registry);
  const router = new Router(registry, teams);
  const mirrorStore = createStoreFromEnv();
  const mirrorRegistry = new MirrorRegistry({ store: mirrorStore });
  const hostRegistry = new HostRegistry();
  const uploadsRegistry = new UploadsRegistry();
  const eventLog = new EventLog(options.eventLogCapacity);
  mirrorRegistry.onSessionClosed((sid) => {
    uploadsRegistry.purgeSession(sid).catch(() => {});
  });

  // Wire up disconnect timeout to clean up team memberships
  registry.setTimeoutCleanup((fullName, agentTeams) => {
    for (const teamName of agentTeams) {
      teams.leave(teamName, fullName);
    }
  });

  // Wire dashboard broadcast into ws-plugin and mirror-registry
  setDashboardBroadcast(broadcastToDashboards);
  mirrorRegistry.setDashboardBroadcast(broadcastToDashboards);
  hostRegistry.setDashboardBroadcast(broadcastToDashboards);

  // Forward half of the (host, cc_pid) join: when a mirror-agent opens
  // a session, the hub looks up whether an MCP agent has already
  // registered with that identity and uses its chosen name as the
  // session's owner label.
  mirrorRegistry.setAgentLookup(
    (host, ccPid) => registry.findByHostPid(host, ccPid)?.fullName ?? null,
  );

  // Broadcast every event log entry to dashboard clients in real-time.
  eventLog.setListener((entry) => {
    broadcastToDashboards({
      event: "system:event",
      ts: entry.ts,
      name: entry.event,
      data: entry.data,
    });
  });

  // Resolve plugin.ts path relative to hub source directory
  const pluginPath = `${import.meta.dir}/../plugin/plugin.ts`;
  const dashboardPath = `${import.meta.dir}/dashboard.html`;
  const dashboardParsersPath = `${import.meta.dir}/dashboard/parsers.js`;
  const pwaManifestPath = `${import.meta.dir}/pwa/manifest.webmanifest`;
  const pwaSwPath = `${import.meta.dir}/pwa/sw.js`;
  const pwaIconSvgPath = `${import.meta.dir}/pwa/icon.svg`;
  const pwaIcon192Path = `${import.meta.dir}/pwa/icon-192.png`;
  const pwaIcon512Path = `${import.meta.dir}/pwa/icon-512.png`;
  let pluginCache: string | null = null;
  let dashboardCache: string | null = null;
  let dashboardParsersCache: string | null = null;

  // Embedded at startup so the UI can confirm which build is running.
  // GIT_COMMIT is set by the deploy command before `docker compose restart`
  // so it's available even when git isn't installed in the container.
  const commitHash = (() => {
    // 1. Read .git/HEAD directly — works in dev when .git is mounted, no git binary needed.
    try {
      const head = readFileSync(".git/HEAD", "utf8").trim();
      const hash = head.startsWith("ref: ")
        ? (() => {
            const ref = head.slice(5);
            try {
              return readFileSync(`.git/${ref}`, "utf8").trim();
            } catch {
              const packed = readFileSync(".git/packed-refs", "utf8");
              return packed.match(new RegExp(`([0-9a-f]+) ${ref}`))?.[1] ?? null;
            }
          })()
        : head;
      if (hash && hash.length >= 7) return hash.slice(0, 7);
    } catch { /* .git not mounted */ }
    // 2. Env var — set at image build time for prod.
    return process.env.CLAUDE_NET_VERSION ?? "dev";
  })();

  async function getDashboardHtml(): Promise<string> {
    if (!dashboardCache) {
      const file = Bun.file(dashboardPath);
      dashboardCache = (await file.text()).replace("__COMMIT__", commitHash);
    }
    return dashboardCache;
  }

  async function getDashboardParsersJs(): Promise<string> {
    if (!dashboardParsersCache) {
      const file = Bun.file(dashboardParsersPath);
      dashboardParsersCache = await file.text();
    }
    return dashboardParsersCache;
  }

  let app = new Elysia()
    .get("/", async ({ set }) => {
      set.headers["content-type"] = "text/html";
      return await getDashboardHtml();
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
    .get("/dashboard/parsers.js", async ({ set }) => {
      set.headers["content-type"] = "application/javascript";
      return await getDashboardParsersJs();
    })
    // PWA assets. These are tiny (manifest/SW/icon total <30 KB) so
    // they're re-read on every request rather than cached in module
    // memory — that keeps `bun run dev --watch` honest: edits to the
    // PWA files take effect immediately on the next request instead of
    // silently no-opping until the hub restarts.
    .get("/manifest.webmanifest", async ({ set }) => {
      set.headers["content-type"] = "application/manifest+json";
      return await Bun.file(pwaManifestPath).text();
    })
    .get("/sw.js", async ({ set }) => {
      // `Cache-Control: no-cache` forces the browser to revalidate the
      // worker on every navigation so a bumped SHELL-version string
      // propagates to all clients within one page load.
      set.headers["content-type"] = "application/javascript";
      set.headers["cache-control"] = "no-cache";
      return await Bun.file(pwaSwPath).text();
    })
    .get("/icon.svg", async ({ set }) => {
      set.headers["content-type"] = "image/svg+xml";
      return await Bun.file(pwaIconSvgPath).text();
    })
    .get(
      "/icon-192.png",
      () =>
        new Response(Bun.file(pwaIcon192Path), {
          headers: { "content-type": "image/png" },
        }),
    )
    .get(
      "/icon-512.png",
      () =>
        new Response(Bun.file(pwaIcon512Path), {
          headers: { "content-type": "image/png" },
        }),
    )
    .use(
      apiPlugin({ registry, teams, router, startedAt, hostRegistry, eventLog }),
    )
    .use(mirrorPlugin({ mirrorRegistry }))
    .use(
      uploadsPlugin({
        mirrorRegistry,
        uploadsRegistry,
        externalHost: process.env.CLAUDE_NET_HOST,
        port: Number(process.env.CLAUDE_NET_PORT) || 4815,
      }),
    )
    .use(hostPlugin({ hostRegistry }))
    .use(binServerPlugin({ repoRoot: `${import.meta.dir}/../..` }))
    .use(setupPlugin({ port: Number(process.env.CLAUDE_NET_PORT) || 4815 }));

  app = wsPlugin(app, registry, teams, router, eventLog, mirrorRegistry, port);
  app = wsDashboardPlugin(app, registry, teams, hostRegistry);
  app = wsMirrorPlugin(app, mirrorRegistry);
  app = wsHostPlugin(app, hostRegistry);

  // Periodic native WS ping + stale-WS eviction. Reuses the existing
  // close handler in ws-plugin to unregister and broadcast
  // agent:disconnected — do not duplicate that here.
  const pingTick = setInterval(() => {
    const now = Date.now();
    const cutoff = now - staleThresholdMs;
    let evictedCount = 0;
    for (const entry of registry.agents.values()) {
      const raw = entry.wsIdentity as ServerWebSocket<unknown>;
      if (entry.lastPongAt < cutoff) {
        eventLog.push("agent.evicted", {
          fullName: entry.fullName,
          lastPongAt: entry.lastPongAt,
          silentForMs: now - entry.lastPongAt,
        });
        evictedCount++;
        markEvicting(entry.wsIdentity);
        try {
          raw.close();
        } catch {
          // Already closing/closed — the close handler will clean up,
          // or the entry was removed between the check and the call.
        }
        continue;
      }
      try {
        raw.ping();
      } catch {
        // WS is in a bad state. The stale check on a subsequent tick
        // will close it once the threshold elapses; no need to force
        // close here.
      }
    }
    eventLog.push("ping.tick", {
      agentCount: registry.agents.size,
      evictedCount,
    });
  }, pingIntervalMs);
  // Don't block process exit on the ping tick (relevant for tests that
  // forget to call stop()).
  if (pingTick && typeof pingTick === "object" && "unref" in pingTick) {
    (pingTick as { unref(): void }).unref();
  }

  let stopped = false;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(pingTick);
    try {
      app.stop();
    } catch {
      // app.stop() may throw if the server never started; best-effort.
    }
  }

  return {
    app,
    registry,
    teams,
    router,
    mirrorRegistry,
    hostRegistry,
    eventLog,
    startedAt,
    stop,
  };
}

// ── Module entrypoint (executed when `bun run src/hub/index.ts`) ─────────

const port = Number(process.env.CLAUDE_NET_PORT) || 4815;
const hub = createHub({ port });
const {
  app,
  registry,
  teams,
  router,
  mirrorRegistry,
  hostRegistry,
  eventLog,
  startedAt,
} = hub;

// Optional TLS. If CLAUDE_NET_TLS_CERT and CLAUDE_NET_TLS_KEY are both set,
// bind HTTPS/WSS. The existing message-bus endpoints (/ws, /api/*) work
// regardless; mirror URLs are generated with the right scheme via the
// request's X-Forwarded-Proto or url scheme.
const tlsCert = process.env.CLAUDE_NET_TLS_CERT;
const tlsKey = process.env.CLAUDE_NET_TLS_KEY;
if (tlsCert && tlsKey) {
  const fs = await import("node:fs");
  app.listen({
    port,
    tls: {
      cert: fs.readFileSync(tlsCert),
      key: fs.readFileSync(tlsKey),
    },
  });
  console.log(`claude-net hub listening on port ${port} (TLS enabled)`);
} else {
  app.listen(port);
  console.log(`claude-net hub listening on port ${port}`);
}

// Graceful shutdown clears the ping interval so the process can exit
// cleanly (otherwise the interval keeps the event loop alive even after
// app.stop()).
const shutdown = () => {
  hub.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export {
  app,
  registry,
  teams,
  router,
  mirrorRegistry,
  hostRegistry,
  eventLog,
  startedAt,
};
