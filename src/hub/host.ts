// REST surface for host-scoped operations. All endpoints relay to the
// owning daemon over /ws/host and await the _done reply.
//
// Routes:
//   GET  /api/host/:id/ls?path=<abs>
//   POST /api/host/:id/mkdir { path }
//   POST /api/host/:id/launch { cwd, create_if_missing?, skip_permissions?, continue_session?, resume_sid? }

import { Elysia } from "elysia";
import type { HostRegistry } from "./host-registry";
import { RateLimiter } from "./rate-limit";

export interface HostPluginDeps {
  hostRegistry: HostRegistry;
}

// Rate limits are keyed on host_id, and sized per operation:
// - ls: generous, autocomplete hits it on every keystroke (post-debounce).
// - mkdir: low-frequency admin-ish op.
// - launch: dual-tier, same shape as inject.
// - recoverable: a read the dashboard polls on host connect and focus.
// - restore: batch semantics make the per-launch tiers the wrong shape;
//   repeated clicking is the failure mode worth damping.
const LS_TIMEOUT_MS = 5_000;
const MKDIR_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 10_000;
const RECOVERABLE_TIMEOUT_MS = 15_000;
// The daemon replies once every tmux session has been spawned, staggering
// spawns ~400ms apart and never blocking on trust-prompt detection. The
// ceiling is a fixed floor for RPC dispatch overhead plus a per-session
// slice covering stagger delay and tmux spawn latency.
const RESTORE_BASE_TIMEOUT_MS = 5_000;
const RESTORE_PER_SESSION_TIMEOUT_MS = 1_000;

/** Mirrors the daemon-side ceiling so oversized batches fail before the RPC. */
const MAX_RESTORE_BATCH = 20;

/** Session ids are UUIDs; constrain to safe chars before the value is
 *  interpolated into a shell command by the daemon's tmux send-keys path.
 *  First char must be alphanumeric so the value can't become a CLI flag
 *  (e.g. `-x`) when passed as `--resume <sid>`. */
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const launchBurstLimiter = new RateLimiter({ max: 1, windowMs: 5_000 });
const launchHourLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60_000 });

export interface LaunchOnHostOpts {
  cwd: string;
  create_if_missing?: boolean;
  skip_permissions?: boolean;
  continue_session?: boolean;
  resume_sid?: string;
}

export interface LaunchOnHostResult {
  status: number;
  body: Record<string, unknown>;
  /** Value for the `Retry-After` header, when status is 429. */
  retryAfter?: string;
}

/**
 * Relay a `host_launch` to the owning daemon, applying the gates and rate
 * limits. Shared by `POST /api/host/:id/launch` and the mirror reconnect
 * endpoint so the two paths can't drift. Returns a status + body the caller
 * maps onto its response; never throws.
 */
export async function launchOnHost(
  hostRegistry: HostRegistry,
  hostId: string,
  opts: LaunchOnHostOpts,
): Promise<LaunchOnHostResult> {
  if (!opts.cwd) {
    return { status: 400, body: { error: "Missing required field: cwd" } };
  }
  if (opts.resume_sid !== undefined && !SID_RE.test(opts.resume_sid)) {
    return { status: 400, body: { error: "Invalid resume_sid" } };
  }
  const host = hostRegistry.get(hostId);
  if (!host) {
    return { status: 404, body: { error: `host '${hostId}' not connected` } };
  }
  if (opts.skip_permissions && !host.allowDangerousSkip) {
    return {
      status: 403,
      body: { error: "skip_permissions not allowed on this host" },
    };
  }
  if (!launchBurstLimiter.allow(hostId)) {
    return {
      status: 429,
      body: { error: "Rate limit: launch bursts (1 per 5s)" },
      retryAfter: "5",
    };
  }
  if (!launchHourLimiter.allow(hostId)) {
    const waitMs = launchHourLimiter.retryAfterMs(hostId);
    return {
      status: 429,
      body: { error: "Rate limit: launch (10 per hour)" },
      retryAfter: String(Math.max(1, Math.ceil(waitMs / 1000))),
    };
  }
  try {
    const resp = await hostRegistry.sendRpc(
      hostId,
      "host_launch",
      {
        cwd: opts.cwd,
        create_if_missing: opts.create_if_missing === true,
        skip_permissions: opts.skip_permissions === true,
        continue_session: opts.continue_session === true,
        ...(opts.resume_sid ? { resume_sid: opts.resume_sid } : {}),
      },
      LAUNCH_TIMEOUT_MS,
    );
    if (resp.action !== "host_launch_done") {
      return { status: 502, body: { error: "Unexpected RPC response" } };
    }
    if (resp.error) {
      return { status: 400, body: { error: resp.error } };
    }
    return { status: 200, body: { ok: true, tmux_session: resp.tmux_session } };
  } catch (err) {
    return { status: 504, body: { error: (err as Error).message } };
  }
}

/** Matches the dashboard's own upper bound on the recoverable-scan window. */
const MAX_RECOVERABLE_WITHIN_HOURS = 8760;

export function hostPlugin(deps: HostPluginDeps): Elysia {
  const { hostRegistry } = deps;

  // Per-instance so limiter state belongs to the hub that owns the routes
  // rather than to the module. The launch limiters are the exception: they
  // sit at module scope because launchOnHost is shared with the mirror
  // reconnect route.
  const lsLimiter = new RateLimiter({ max: 20, windowMs: 1_000 });
  const mkdirLimiter = new RateLimiter({ max: 5, windowMs: 60_000 });
  const recoverableLimiter = new RateLimiter({ max: 10, windowMs: 10_000 });
  const restoreLimiter = new RateLimiter({ max: 3, windowMs: 5 * 60_000 });

  return new Elysia({ prefix: "/api/host" })
    .get("/:id/ls", async ({ params, query, set }) => {
      const hostId = params.id;
      const path = (query as Record<string, string | undefined>).path;
      if (!path) {
        set.status = 400;
        return { error: "Missing required query: path" };
      }
      if (!hostRegistry.get(hostId)) {
        set.status = 404;
        return { error: `host '${hostId}' not connected` };
      }
      if (!lsLimiter.allow(hostId)) {
        set.status = 429;
        set.headers["retry-after"] = "1";
        return { error: "Rate limit: ls" };
      }
      try {
        const resp = await hostRegistry.sendRpc(
          hostId,
          "host_ls",
          { path },
          LS_TIMEOUT_MS,
        );
        if (resp.action !== "host_ls_done") {
          set.status = 502;
          return { error: "Unexpected RPC response" };
        }
        if (resp.error) {
          set.status = 403;
          return { error: resp.error };
        }
        return { entries: resp.entries ?? [] };
      } catch (err) {
        set.status = 504;
        return { error: (err as Error).message };
      }
    })

    .post("/:id/mkdir", async ({ params, body, set }) => {
      const hostId = params.id;
      const payload = body as { path?: string };
      if (!payload.path) {
        set.status = 400;
        return { error: "Missing required field: path" };
      }
      if (!hostRegistry.get(hostId)) {
        set.status = 404;
        return { error: `host '${hostId}' not connected` };
      }
      if (!mkdirLimiter.allow(hostId)) {
        set.status = 429;
        const waitMs = mkdirLimiter.retryAfterMs(hostId);
        set.headers["retry-after"] = String(
          Math.max(1, Math.ceil(waitMs / 1000)),
        );
        return { error: "Rate limit: mkdir" };
      }
      try {
        const resp = await hostRegistry.sendRpc(
          hostId,
          "host_mkdir",
          { path: payload.path },
          MKDIR_TIMEOUT_MS,
        );
        if (resp.action !== "host_mkdir_done") {
          set.status = 502;
          return { error: "Unexpected RPC response" };
        }
        if (resp.error) {
          set.status = 403;
          return { error: resp.error };
        }
        return { ok: true };
      } catch (err) {
        set.status = 504;
        return { error: (err as Error).message };
      }
    })

    .post("/:id/launch", async ({ params, body, set }) => {
      const payload = body as {
        cwd?: string;
        create_if_missing?: boolean;
        skip_permissions?: boolean;
        continue_session?: boolean;
        resume_sid?: string;
      };
      const r = await launchOnHost(hostRegistry, params.id, {
        cwd: payload.cwd ?? "",
        create_if_missing: payload.create_if_missing === true,
        skip_permissions: payload.skip_permissions === true,
        continue_session: payload.continue_session === true,
        resume_sid: payload.resume_sid,
      });
      set.status = r.status;
      if (r.retryAfter) set.headers["retry-after"] = r.retryAfter;
      return r.body;
    })

    .get("/:id/recoverable", async ({ params, query, set }) => {
      const hostId = params.id;
      const rawHours = (query as Record<string, string | undefined>)
        .within_hours;
      const withinHours = rawHours === undefined ? undefined : Number(rawHours);
      if (
        withinHours !== undefined &&
        (!Number.isFinite(withinHours) ||
          withinHours <= 0 ||
          withinHours > MAX_RECOVERABLE_WITHIN_HOURS)
      ) {
        set.status = 400;
        return {
          error: `within_hours must be a positive number up to ${MAX_RECOVERABLE_WITHIN_HOURS}`,
        };
      }
      const host = hostRegistry.get(hostId);
      if (!host) {
        set.status = 404;
        return { error: `host '${hostId}' not connected` };
      }
      if (!recoverableLimiter.allow(hostId)) {
        set.status = 429;
        const waitMs = recoverableLimiter.retryAfterMs(hostId);
        set.headers["retry-after"] = String(
          Math.max(1, Math.ceil(waitMs / 1000)),
        );
        return { error: "Rate limit: recoverable (10 per 10s)" };
      }
      try {
        const resp = await hostRegistry.sendRpc(
          hostId,
          "host_recoverable",
          withinHours === undefined ? {} : { within_hours: withinHours },
          RECOVERABLE_TIMEOUT_MS,
        );
        if (resp.action !== "host_recoverable_done") {
          set.status = 502;
          return { error: "Unexpected RPC response" };
        }
        if (resp.error) {
          set.status = 400;
          return { error: resp.error };
        }
        return { sessions: resp.sessions ?? [] };
      } catch (err) {
        set.status = 504;
        return { error: (err as Error).message };
      }
    })

    .post("/:id/restore", async ({ params, body, set }) => {
      const hostId = params.id;
      const payload = body as {
        session_ids?: unknown;
        skip_permissions?: boolean;
        auto_trust?: boolean;
      };
      const rawIds = payload.session_ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        set.status = 400;
        return { error: "Missing required field: session_ids" };
      }
      if (!rawIds.every((id) => typeof id === "string" && id.length > 0)) {
        set.status = 400;
        return { error: "session_ids must be non-empty strings" };
      }
      // Preserve first-seen order; a client resubmitting the same id
      // repeatedly should resume it once, not spawn one process per copy.
      const ids = Array.from(new Set(rawIds as string[]));
      if (ids.length > MAX_RESTORE_BATCH) {
        set.status = 400;
        return { error: `at most ${MAX_RESTORE_BATCH} sessions per restore` };
      }
      const host = hostRegistry.get(hostId);
      if (!host) {
        set.status = 404;
        return { error: `host '${hostId}' not connected` };
      }
      if (payload.skip_permissions && !host.allowDangerousSkip) {
        set.status = 403;
        return { error: "skip_permissions not allowed on this host" };
      }
      if (!restoreLimiter.allow(hostId)) {
        set.status = 429;
        const waitMs = restoreLimiter.retryAfterMs(hostId);
        set.headers["retry-after"] = String(
          Math.max(1, Math.ceil(waitMs / 1000)),
        );
        return { error: "Rate limit: restore (3 per 5 min)" };
      }
      try {
        const resp = await hostRegistry.sendRpc(
          hostId,
          "host_restore",
          {
            session_ids: ids,
            skip_permissions: payload.skip_permissions === true,
            // Defaults on when omitted, but an explicit value must be a real
            // boolean: a JSON string is not consent to answer a trust prompt.
            auto_trust:
              payload.auto_trust === undefined
                ? true
                : payload.auto_trust === true,
          },
          RESTORE_BASE_TIMEOUT_MS + ids.length * RESTORE_PER_SESSION_TIMEOUT_MS,
        );
        if (resp.action !== "host_restore_done") {
          set.status = 502;
          return { error: "Unexpected RPC response" };
        }
        if (resp.error) {
          set.status = 400;
          return { error: resp.error };
        }
        return { results: resp.results ?? [] };
      } catch (err) {
        set.status = 504;
        return { error: (err as Error).message };
      }
    });
}
