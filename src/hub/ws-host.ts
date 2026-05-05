import type { Elysia } from "elysia";
import type { HostRegistry } from "./host-registry";
import type { MirrorRegistry } from "./mirror";
import type { Registry } from "./registry";

interface HostWs {
  send(data: string | object): void;
  raw: object;
  close(code?: number, reason?: string): void;
}

/**
 * Per-connection metadata keyed by ws.raw. We avoid mutating ws.raw so
 * the object stays a plain ServerWebSocket.
 */
interface HostConnMeta {
  hostId: string;
}

const connMeta = new WeakMap<object, HostConnMeta>();

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Long-lived WebSocket served to mirror-agent daemons. Each daemon
 * opens one of these on startup and keeps it open for its lifetime.
 *
 * Phase A: handle host_register + close. Phase B adds host_ls /
 * host_mkdir / host_launch response handling.
 */
export function wsHostPlugin(
  app: Elysia,
  hostRegistry: HostRegistry,
  registry?: Registry,
  mirrorRegistry?: MirrorRegistry,
): Elysia {
  return app.ws("/ws/host", {
    open(ws: HostWs) {
      // Wait for the daemon to send host_register before adding to the
      // registry — we can't advertise a host we don't have an identity for.
    },

    message(ws: HostWs, rawData: unknown) {
      const data =
        typeof rawData === "string" ? safeJsonParse(rawData) : rawData;
      if (!data || typeof data !== "object" || !("action" in data)) return;

      const frame = data as { action: string } & Record<string, unknown>;

      if (frame.action === "host_register") {
        if (
          typeof frame.host_id !== "string" ||
          typeof frame.user !== "string" ||
          typeof frame.hostname !== "string" ||
          typeof frame.home !== "string"
        ) {
          ws.send(
            JSON.stringify({
              event: "error",
              message: "host_register missing required fields",
            }),
          );
          return;
        }
        const entry = hostRegistry.register(
          {
            action: "host_register",
            host_id: frame.host_id,
            user: frame.user,
            hostname: frame.hostname,
            home: frame.home,
            recent_cwds: Array.isArray(frame.recent_cwds)
              ? (frame.recent_cwds as string[])
              : [],
            allow_dangerous_skip: Boolean(frame.allow_dangerous_skip),
          },
          {
            send: (payload) => {
              ws.send(payload);
            },
            wsIdentity: ws.raw,
            close: () => {
              try {
                ws.close();
              } catch {
                // ignore
              }
            },
          },
        );
        connMeta.set(ws.raw, { hostId: entry.hostId });
        ws.send(
          JSON.stringify({ event: "host_registered", host_id: entry.hostId }),
        );

        // Probe for any plugins already registered on this host that
        // don't have a mirror session. Handles the mirror-agent restart
        // case: Claude Code is still running (plugin is connected) but the
        // daemon has no session state.
        if (registry && mirrorRegistry) {
          for (const agent of registry.agents.values()) {
            if (
              agent.ccPid === null ||
              agent.cwd === null ||
              `${agent.user}@${agent.host}` !== entry.hostId
            ) {
              continue;
            }
            if (!mirrorRegistry.hasSessionForHostPid(agent.host, agent.ccPid)) {
              entry.send(
                JSON.stringify({
                  action: "host_session_probe",
                  cc_pid: agent.ccPid,
                  cwd: agent.cwd,
                }),
              );
            }
          }
        }

        return;
      }

      // RPC responses from the daemon — forward to pending resolvers.
      if (
        frame.action === "host_ls_done" ||
        frame.action === "host_mkdir_done" ||
        frame.action === "host_launch_done"
      ) {
        const meta = connMeta.get(ws.raw);
        if (meta && typeof frame.request_id === "string") {
          // biome-ignore lint/suspicious/noExplicitAny: validated at runtime by resolveRpc's key check
          hostRegistry.resolveRpc(meta.hostId, frame as any);
        }
        return;
      }

      // Unknown frames from the daemon are ignored — tolerates version skew.
    },

    close(ws: HostWs) {
      if (!connMeta.has(ws.raw)) return;
      connMeta.delete(ws.raw);
      hostRegistry.unregisterByIdentity(ws.raw);
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS handler typing requires flexible return
  }) as any;
}
