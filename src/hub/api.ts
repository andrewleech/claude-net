import { Elysia } from "elysia";
import type { HostRegistry } from "./host-registry";
import type { Registry } from "./registry";
import type { Router } from "./router";
import type { Teams } from "./teams";

export interface ApiDeps {
  registry: Registry;
  teams: Teams;
  router: Router;
  startedAt: Date;
  hostRegistry?: HostRegistry;
}

export function apiPlugin(deps: ApiDeps): Elysia {
  const { registry, teams, router, startedAt, hostRegistry } = deps;

  return new Elysia({ prefix: "/api" })
    .get("/agents", () => registry.list())

    .get("/teams", () => teams.list())

    .get("/hosts", () => (hostRegistry ? hostRegistry.list() : []))

    .get("/status", () => {
      const agents = registry.list();
      const online = agents.filter((a) => a.status === "online").length;
      const offline = agents.filter((a) => a.status === "offline").length;
      return {
        uptime: (Date.now() - startedAt.getTime()) / 1000,
        agents: { online, offline },
        teams: teams.teams.size,
      };
    })

    .post("/send", ({ body, set }) => {
      const { to, content, reply_to } = body as Record<
        string,
        string | undefined
      >;
      if (!to || !content) {
        set.status = 400;
        return { error: "Missing required fields: to, content" };
      }

      const type = reply_to ? ("reply" as const) : ("message" as const);
      const result = router.routeDirect(
        "dashboard@hub",
        to,
        content,
        type,
        reply_to,
      );
      if (!result.ok) {
        set.status = 400;
        return {
          error: result.error,
          outcome: result.outcome,
          reason: result.reason,
        };
      }
      return {
        message_id: result.message_id,
        // `delivered: true` retained for backwards compatibility with
        // older dashboard code; the structured `outcome` field is the
        // canonical signal going forward. See FR4/FR5.
        delivered: true,
        outcome: result.outcome,
        ...(result.to_dashboard ? { to_dashboard: true } : {}),
      };
    })

    .post("/broadcast", ({ body, set }) => {
      const { content } = body as Record<string, string | undefined>;
      if (!content) {
        set.status = 400;
        return { error: "Missing required field: content" };
      }

      const result = router.routeBroadcast("dashboard@hub", content);
      return {
        message_id: result.message_id,
        delivered_to: result.delivered_to,
        skipped_no_channel: result.skipped_no_channel,
      };
    })

    .post("/send_team", ({ body, set }) => {
      const { team, content, reply_to } = body as Record<
        string,
        string | undefined
      >;
      if (!team || !content) {
        set.status = 400;
        return { error: "Missing required fields: team, content" };
      }

      const type = reply_to ? ("reply" as const) : ("message" as const);
      const result = router.routeTeam(
        "dashboard@hub",
        team,
        content,
        type,
        reply_to,
      );
      if (!result.ok) {
        set.status = 400;
        return { error: result.error };
      }
      return {
        message_id: result.message_id,
        delivered_to: result.delivered_to,
        skipped_no_channel: result.skipped_no_channel,
      };
    });
}
