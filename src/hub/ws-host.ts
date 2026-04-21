import type { Elysia } from "elysia";
import type { HostRegistry } from "./host-registry";

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
export function wsHostPlugin(app: Elysia, hostRegistry: HostRegistry): Elysia {
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
        return;
      }

      // Phase B will handle host_ls_done / host_mkdir_done / host_launch_done
      // responses. For now, unknown frames are ignored.
    },

    close(ws: HostWs) {
      if (!connMeta.has(ws.raw)) return;
      connMeta.delete(ws.raw);
      hostRegistry.unregisterByIdentity(ws.raw);
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS handler typing requires flexible return
  }) as any;
}
