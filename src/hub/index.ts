import { Elysia } from "elysia";
import { apiPlugin } from "./api";
import { binServerPlugin } from "./bin-server";
import { HostRegistry } from "./host-registry";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "./mirror";
import { createStoreFromEnv } from "./mirror-store";
import { Registry } from "./registry";
import { Router } from "./router";
import { setupPlugin } from "./setup";
import { Teams } from "./teams";
import { broadcastToDashboards, wsDashboardPlugin } from "./ws-dashboard";
import { wsHostPlugin } from "./ws-host";
import { setDashboardBroadcast, wsPlugin } from "./ws-plugin";

const port = Number(process.env.CLAUDE_NET_PORT) || 4815;
const startedAt = new Date();

const registry = new Registry();
const teams = new Teams(registry);
const router = new Router(registry, teams);
const mirrorStore = createStoreFromEnv();
const mirrorRegistry = new MirrorRegistry({ store: mirrorStore });
const hostRegistry = new HostRegistry();

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

// Resolve plugin.ts path relative to hub source directory
const pluginPath = `${import.meta.dir}/../plugin/plugin.ts`;
const dashboardPath = `${import.meta.dir}/dashboard.html`;
const dashboardParsersPath = `${import.meta.dir}/dashboard/parsers.js`;
let pluginCache: string | null = null;
let dashboardCache: string | null = null;
let dashboardParsersCache: string | null = null;

async function getDashboardHtml(): Promise<string> {
  if (!dashboardCache) {
    const file = Bun.file(dashboardPath);
    dashboardCache = await file.text();
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
  .use(apiPlugin({ registry, teams, router, startedAt, hostRegistry }))
  .use(mirrorPlugin({ mirrorRegistry }))
  .use(binServerPlugin({ repoRoot: `${import.meta.dir}/../..` }))
  .use(setupPlugin({ port }));

app = wsPlugin(app, registry, teams, router);
app = wsDashboardPlugin(app, registry, teams, hostRegistry);
app = wsMirrorPlugin(app, mirrorRegistry);
app = wsHostPlugin(app, hostRegistry);

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

export {
  app,
  registry,
  teams,
  router,
  mirrorRegistry,
  hostRegistry,
  startedAt,
};
