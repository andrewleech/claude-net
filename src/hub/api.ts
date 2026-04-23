import { Elysia } from "elysia";
import type { EventLog } from "./event-log";
import type { HostRegistry } from "./host-registry";
import type { Registry } from "./registry";
import type { Router } from "./router";
import type { Teams } from "./teams";

export interface ApiDeps {
  registry: Registry;
  teams: Teams;
  router: Router;
  startedAt: Date;
  eventLog: EventLog;
  hostRegistry?: HostRegistry;
}

const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 1000;
const SUMMARY_DEFAULT_WINDOW_MS = 60 * 60 * 1000;

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function apiPlugin(deps: ApiDeps): Elysia {
  const { registry, teams, router, startedAt, hostRegistry, eventLog } = deps;

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
      const startedAt = Date.now();
      const result = router.routeDirect(
        "dashboard@hub",
        to,
        content,
        type,
        reply_to,
      );
      const elapsedMs = Date.now() - startedAt;
      if (!result.ok) {
        eventLog.push("message.sent", {
          from: "dashboard@hub",
          to,
          messageId: null,
          outcome: result.outcome,
          reason: result.reason,
          elapsedMs,
        });
        set.status = 400;
        return {
          error: result.error,
          outcome: result.outcome,
          reason: result.reason,
        };
      }
      eventLog.push("message.sent", {
        from: "dashboard@hub",
        to,
        messageId: result.message_id,
        outcome: result.outcome,
        elapsedMs,
      });
      return {
        message_id: result.message_id,
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
      eventLog.push("message.broadcast", {
        from: "dashboard@hub",
        messageId: result.message_id,
        deliveredTo: result.delivered_to,
        skippedNoChannel: result.skipped_no_channel,
      });
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
      eventLog.push("message.team", {
        from: "dashboard@hub",
        team,
        messageId: result.message_id,
        deliveredTo: result.delivered_to,
        skippedNoChannel: result.skipped_no_channel,
      });
      return {
        message_id: result.message_id,
        delivered_to: result.delivered_to,
        skipped_no_channel: result.skipped_no_channel,
      };
    })

    .get("/events", ({ query }) => {
      const q = query as Record<string, string | undefined>;
      const event = q.event;
      const since = parseOptionalNumber(q.since);
      const agent = q.agent;
      const rawLimit = parseOptionalNumber(q.limit);
      const limit = Math.min(
        EVENTS_MAX_LIMIT,
        Math.max(1, rawLimit ?? EVENTS_DEFAULT_LIMIT),
      );

      const events = eventLog.query({ event, since, agent, limit });
      return {
        events,
        count: events.length,
        oldest_ts: eventLog.oldestTs(),
        capacity: eventLog.capacity,
      };
    })

    .get("/events/summary", ({ query }) => {
      const q = query as Record<string, string | undefined>;
      const sinceParam = parseOptionalNumber(q.since);
      const now = Date.now();
      const since = sinceParam ?? now - SUMMARY_DEFAULT_WINDOW_MS;
      const window_ms = now - since;
      const { counts, total } = eventLog.summary(since);
      return { counts, window_ms, total };
    });
}
