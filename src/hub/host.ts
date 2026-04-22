// REST surface for host-scoped operations. All endpoints relay to the
// owning daemon over /ws/host and await the _done reply.
//
// Routes:
//   GET  /api/host/:id/ls?path=<abs>
//   POST /api/host/:id/mkdir { path }
//   POST /api/host/:id/launch { cwd, create_if_missing?, skip_permissions? }

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
      const hostId = params.id;
      const payload = body as {
        cwd?: string;
        create_if_missing?: boolean;
        skip_permissions?: boolean;
      };
      if (!payload.cwd) {
        set.status = 400;
        return { error: "Missing required field: cwd" };
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
      if (!launchBurstLimiter.allow(hostId)) {
        set.status = 429;
        set.headers["retry-after"] = "5";
        return { error: "Rate limit: launch bursts (1 per 5s)" };
      }
      if (!launchHourLimiter.allow(hostId)) {
        set.status = 429;
        const waitMs = launchHourLimiter.retryAfterMs(hostId);
        set.headers["retry-after"] = String(
          Math.max(1, Math.ceil(waitMs / 1000)),
        );
        return { error: "Rate limit: launch (10 per hour)" };
      }
      try {
        const resp = await hostRegistry.sendRpc(
          hostId,
          "host_launch",
          {
            cwd: payload.cwd,
            create_if_missing: payload.create_if_missing === true,
            skip_permissions: payload.skip_permissions === true,
          },
          LAUNCH_TIMEOUT_MS,
        );
        if (resp.action !== "host_launch_done") {
          set.status = 502;
          return { error: "Unexpected RPC response" };
        }
        if (resp.error) {
          set.status = 400;
          return { error: resp.error };
        }
        return { ok: true, tmux_session: resp.tmux_session };
      } catch (err) {
        set.status = 504;
        return { error: (err as Error).message };
      }
    });
}
