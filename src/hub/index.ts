import { Elysia } from "elysia";
import { apiPlugin } from "./api";
import { Registry } from "./registry";
import { Router } from "./router";
import { setupPlugin } from "./setup";
import { Teams } from "./teams";
import { wsPlugin } from "./ws-plugin";

const port = Number(process.env.CLAUDE_NET_PORT) || 4815;
const startedAt = new Date();

const registry = new Registry();
const teams = new Teams(registry);
const router = new Router(registry, teams);

// Wire up disconnect timeout to clean up team memberships
registry.setTimeoutCleanup((fullName, agentTeams) => {
  for (const teamName of agentTeams) {
    teams.leave(teamName, fullName);
  }
});

// Resolve plugin.ts path relative to hub source directory
const pluginPath = `${import.meta.dir}/../plugin/plugin.ts`;
let pluginCache: string | null = null;

let app = new Elysia()
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
  .use(apiPlugin({ registry, teams, router, startedAt }))
  .use(setupPlugin({ port }));

app = wsPlugin(app, registry, teams, router);
app.listen(port);

console.log(`claude-net hub listening on port ${port}`);

export { app, registry, teams, router, startedAt };
