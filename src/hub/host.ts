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

// Rate limits keyed on host_id:
// - ls: generous, autocomplete hits it on every keystroke (post-debounce).
// - mkdir: low-frequency admin-ish op.
// - launch: dual-tier, same shape as inject.
const lsLimiter = new RateLimiter({ max: 20, windowMs: 1_000 });
const mkdirLimiter = new RateLimiter({ max: 5, windowMs: 60_000 });
const launchBurstLimiter = new RateLimiter({ max: 1, windowMs: 5_000 });
const launchHourLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60_000 });

const LS_TIMEOUT_MS = 5_000;
const MKDIR_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 10_000;

/** Session ids are UUIDs; constrain to safe chars before the value is
 *  interpolated into a shell command by the daemon's tmux send-keys path.
 *  First char must be alphanumeric so the value can't become a CLI flag
 *  (e.g. `-x`) when passed as `--resume <sid>`. */
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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

export function hostPlugin(deps: HostPluginDeps): Elysia {
  const { hostRegistry } = deps;

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
    });
}
