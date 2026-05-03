import * as fs from "node:fs";
import { Elysia } from "elysia";
import type { EventLog } from "./event-log";
import type { HostRegistry } from "./host-registry";
import { RateLimiter } from "./rate-limit";
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
const AGENT_LOG_DEFAULT_LINES = 200;
const AGENT_LOG_MAX_LINES = 2000;
// Tail-read cap: bounded so a long-lived agent on tmpfs doesn't load
// an arbitrarily large file into RAM per request.
const AGENT_LOG_TAIL_BYTES = 256_000;

// 5 crash reports per minute per remote IP.
const agentCrashLimiter = new RateLimiter({ max: 5, windowMs: 60_000 });

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function remoteKeyFor(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? "unknown";
  const host = request.headers.get("host") ?? "unknown";
  return host;
}

export function apiPlugin(deps: ApiDeps): Elysia {
  const { registry, teams, router, startedAt, hostRegistry, eventLog } = deps;

  return (
    new Elysia({ prefix: "/api" })
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
      })

      // ── Mirror-agent daemon health endpoints ─────────────────────────────
      // These are co-located here rather than in mirrorPlugin because they
      // interact with the EventLog and OS-level log files, not the
      // session-management layer in MirrorRegistry.

      // POST /api/mirror/agent-crash — called by the agent's crash handler
      // via a fire-and-forget curl. Writes to EventLog so the existing
      // EventLog→broadcastToDashboards pipeline surfaces it in the UI.
      .post("/mirror/agent-crash", ({ body, set, request }) => {
        const remote = remoteKeyFor(request);
        if (!agentCrashLimiter.allow(remote)) {
          const waitMs = agentCrashLimiter.retryAfterMs(remote);
          set.status = 429;
          set.headers["retry-after"] = String(
            Math.max(1, Math.ceil(waitMs / 1000)),
          );
          return { error: "Rate limit exceeded." };
        }
        const payload = body as Record<string, unknown>;
        if (!payload || typeof payload !== "object") {
          set.status = 400;
          return { error: "Expected JSON body" };
        }
        eventLog.push("mirror.agent.crash", {
          host_id:
            typeof payload.host_id === "string" ? payload.host_id : "unknown",
          kind: typeof payload.kind === "string" ? payload.kind : "unknown",
          message:
            typeof payload.message === "string"
              ? payload.message
              : String(payload.message ?? ""),
          stack: typeof payload.stack === "string" ? payload.stack : "",
          ts:
            typeof payload.ts === "string"
              ? payload.ts
              : new Date().toISOString(),
        });
        return { ok: true };
      })

      // GET /api/mirror/agent-log — serve the last N lines of the
      // mirror-agent log file on this host. Always reads the hub process's
      // own uid — hub and agent run as the same user on the same machine.
      // No uid param accepted to avoid letting callers enumerate other users.
      .get("/mirror/agent-log", ({ query }) => {
        const uid = process.getuid?.() ?? 0;
        const rawLines = Number.parseInt(
          String(
            (query as Record<string, string | undefined>).lines ??
              String(AGENT_LOG_DEFAULT_LINES),
          ),
          10,
        );
        const lines =
          Number.isNaN(rawLines) || rawLines <= 0
            ? AGENT_LOG_DEFAULT_LINES
            : Math.min(rawLines, AGENT_LOG_MAX_LINES);
        const logPath = `/tmp/claude-net/mirror-agent-${uid}.log`;
        let rawContent: Buffer;
        try {
          const stat = fs.statSync(logPath);
          const fd = fs.openSync(logPath, "r");
          try {
            const start = Math.max(0, stat.size - AGENT_LOG_TAIL_BYTES);
            const toRead = stat.size - start;
            rawContent = Buffer.allocUnsafe(toRead);
            fs.readSync(fd, rawContent, 0, toRead, start);
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return {
            uid,
            log_path: logPath,
            lines: [] as string[],
            error: "Log file not found",
          };
        }
        const all = rawContent
          .toString("utf8")
          .split("\n")
          .filter((l) => l.length > 0);
        return {
          uid,
          log_path: logPath,
          total_lines: all.length,
          lines: all.slice(-lines),
        };
      })
  );
}
