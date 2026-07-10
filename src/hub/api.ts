import * as fs from "node:fs";
import { Elysia } from "elysia";
import type { EventLog } from "./event-log";
import type { HostRegistry } from "./host-registry";
import type { MirrorRegistry } from "./mirror";
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
  /** Optional — used by the /mirror/api-error route to look up a
   *  session's owner_agent. When omitted (e.g. older tests) the route
   *  falls back to a body-supplied owner_agent. */
  mirrorRegistry?: MirrorRegistry;
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

// API-error reports from mirror-agents. Generous burst (the JSONL tail
// can replay a few records on a busy session) but capped so a runaway
// loop on the receiver doesn't fan out unbounded notifications.
const apiErrorLimiter = new RateLimiter({ max: 30, windowMs: 60_000 });

/**
 * Maximum age of a `message.sent` event we'll correlate to an incoming
 * api-error report. The receiver's CC makes its next API call within
 * seconds of receiving a message, so 60s is generous; older messages
 * almost certainly aren't the trigger.
 */
const API_ERROR_CORRELATION_WINDOW_MS = 60_000;

/**
 * Cooldown between system notifications routed to the same (sender,
 * recipient) pair for api-error reports. Without this, a receiver
 * stuck in an API-error loop would page the same sender for every
 * synthetic record they generate.
 */
const API_ERROR_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

/** Map of "sender|ownerAgent" → last-notify epoch ms. Used to enforce
 *  API_ERROR_NOTIFY_COOLDOWN_MS. Module-level so the cooldown survives
 *  per-request re-entry; bounded only by the universe of agent pairs
 *  on a given hub. */
const apiErrorNotifyCooldown = new Map<string, number>();

/**
 * Identify recent senders to `ownerAgent` worth notifying about an
 * api-error report. The event log stores `to` as the sender originally
 * passed it (full, partial, or plain), so we substring-match against the
 * canonical owner_agent and its three parts. Returns at most one
 * sender — the most recent — to keep the notification fan-out
 * deterministic and well-targeted.
 */
export function correlateRecentSender(
  eventLog: EventLog,
  ownerAgent: string,
  sinceMs: number,
): string[] {
  if (!ownerAgent) return [];
  const events = eventLog.query({ event: "message.sent", since: sinceMs });
  // Walk from most recent backwards; pick the latest delivered send to a
  // matching `to`. Skip NAKs (outcome === "nak") — those didn't actually
  // touch the recipient's CC, so they can't have triggered the error.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.data.outcome !== "delivered") continue;
    const toRaw = typeof ev.data.to === "string" ? ev.data.to : "";
    const fromRaw = typeof ev.data.from === "string" ? ev.data.from : "";
    if (!toRaw || !fromRaw) continue;
    if (toMatchesOwner(toRaw, ownerAgent)) {
      return [fromRaw];
    }
  }
  return [];
}

function toMatchesOwner(to: string, owner: string): boolean {
  if (to === owner) return true;
  const [sessionPart, rest] = owner.split(":", 2);
  if (!sessionPart || !rest) return false;
  const [userPart, hostPart] = rest.split("@", 2);
  // Canonical partial forms the sender might have used.
  if (to === `${sessionPart}:${userPart}`) return true;
  if (to === `${userPart}@${hostPart}`) return true;
  if (to === sessionPart || to === userPart || to === hostPart) return true;
  return false;
}

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
  const {
    registry,
    teams,
    router,
    startedAt,
    hostRegistry,
    eventLog,
    mirrorRegistry,
  } = deps;

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

      // POST /api/mirror/api-error — mirror-agent reports a receiver-side
      // Claude Code API error (the synthetic `isApiErrorMessage: true`
      // record CC writes when its upstream Anthropic call fails). Hub
      // correlates to the most recent inbound message routed to that
      // session's owner_agent and routes a system notification back to
      // the sender so they know their message wasn't processed.
      .post("/mirror/api-error", ({ body, set, request }) => {
        const remote = remoteKeyFor(request);
        if (!apiErrorLimiter.allow(remote)) {
          const waitMs = apiErrorLimiter.retryAfterMs(remote);
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
        const sid = typeof payload.sid === "string" ? payload.sid : "";
        const status =
          typeof payload.status === "number" ? payload.status : null;
        const text = typeof payload.text === "string" ? payload.text : "";
        const recUuid = typeof payload.uuid === "string" ? payload.uuid : "";
        const recTs =
          typeof payload.ts === "number" && Number.isFinite(payload.ts)
            ? payload.ts
            : Date.now();
        // owner_agent is supplied by the agent so we don't strictly need
        // mirrorRegistry to look it up, but we prefer the registry's view
        // when available — it reflects the latest rename.
        let ownerAgent =
          typeof payload.owner_agent === "string" ? payload.owner_agent : "";
        if (sid && mirrorRegistry) {
          const found = mirrorRegistry.getSession(sid);
          if (found.ok) ownerAgent = found.entry.ownerAgent;
        }

        eventLog.push("mirror.api_error", {
          sid,
          ownerAgent,
          status,
          text,
          uuid: recUuid,
          ts: recTs,
        });

        // Correlate to the most recent message.sent event delivered to
        // this owner_agent within the window. The event log stores the
        // unresolved `to` value the sender passed, so we filter by
        // substring against the canonical owner_agent rather than exact
        // match — catches "alice", "alice@laptop", and the full form.
        const candidates = correlateRecentSender(
          eventLog,
          ownerAgent,
          recTs - API_ERROR_CORRELATION_WINDOW_MS,
        );
        const cooldownNow = Date.now();
        for (const senderName of candidates) {
          const key = `${senderName}|${ownerAgent}`;
          const last = apiErrorNotifyCooldown.get(key) ?? 0;
          if (cooldownNow - last < API_ERROR_NOTIFY_COOLDOWN_MS) continue;
          apiErrorNotifyCooldown.set(key, cooldownNow);

          const summary =
            text.length > 0 ? text : `API error (status ${status ?? "?"})`;
          const notifyContent = `Your recent claude-net message to ${ownerAgent} may not have been processed: their Claude Code reported an upstream API error after receiving it.\n\nError text:\n${summary}\n\nThis is automated correlation by the hub; treat it as a strong signal rather than proof. The sender identity "system@claude-net" is reserved per the documented trust model.`;
          const outcome = router.routeSystemNotification(
            senderName,
            notifyContent,
          );
          eventLog.push("mirror.api_error.notified", {
            to: senderName,
            ownerAgent,
            outcome: outcome.outcome,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          });
        }
        return { ok: true, notified: candidates };
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
