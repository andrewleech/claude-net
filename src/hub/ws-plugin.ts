import type {
  DashboardEvent,
  ErrorFrame,
  InboundMessageFrame,
  PluginFrame,
  RegisteredFrame,
  ResponseFrame,
} from "@/shared/types";
import type { Elysia } from "elysia";
import type { MirrorRegistry } from "./mirror";
import type { Registry } from "./registry";
import type { Router } from "./router";
import type { Teams } from "./teams";

// Elysia WS handler context — the wrapper object changes per callback,
// but ws.raw (the underlying ServerWebSocket) is stable across open/message/close.
interface ElysiaWs {
  send(data: string | object): void;
  raw: object;
  id: string;
}

// Map from raw ServerWebSocket reference to registered fullName
const wsToAgent = new WeakMap<object, string>();

let dashboardBroadcastFn: (event: DashboardEvent) => void = () => {};

export function setDashboardBroadcast(
  fn: (event: DashboardEvent) => void,
): void {
  dashboardBroadcastFn = fn;
}

function sendFrame(ws: ElysiaWs, frame: object): void {
  ws.send(JSON.stringify(frame));
}

function sendResponse(
  ws: ElysiaWs,
  requestId: string | undefined,
  ok: boolean,
  data?: unknown,
  error?: string,
): void {
  if (!requestId) return;
  const frame: ResponseFrame = { event: "response", requestId, ok };
  if (data !== undefined) frame.data = data;
  if (error !== undefined) frame.error = error;
  sendFrame(ws, frame);
}

function getSenderName(ws: ElysiaWs): string | undefined {
  return wsToAgent.get(ws.raw);
}

function requireRegistered(
  ws: ElysiaWs,
  requestId: string | undefined,
): string | null {
  const name = getSenderName(ws);
  if (!name) {
    sendResponse(
      ws,
      requestId,
      false,
      undefined,
      "Not registered. Send a register frame first.",
    );
    return null;
  }
  return name;
}

export function wsPlugin(
  app: Elysia,
  registry: Registry,
  teams: Teams,
  router: Router,
  mirrorRegistry?: MirrorRegistry,
): Elysia {
  return app.ws("/ws", {
    open(_ws: ElysiaWs) {
      // No action — agent must send register frame
    },

    message(ws: ElysiaWs, rawData: unknown) {
      let data: PluginFrame;

      // Elysia auto-parses JSON. Valid JSON arrives as object, invalid as string.
      if (typeof rawData === "string") {
        // Invalid JSON was sent (Elysia couldn't parse it)
        const errorFrame: ErrorFrame = {
          event: "error",
          message: "Invalid frame",
        };
        sendFrame(ws, errorFrame);
        return;
      }

      data = rawData as PluginFrame;

      if (!data || typeof data !== "object" || !("action" in data)) {
        const errorFrame: ErrorFrame = {
          event: "error",
          message: "Invalid frame",
        };
        sendFrame(ws, errorFrame);
        return;
      }

      const requestId =
        "requestId" in data
          ? (data.requestId as string | undefined)
          : undefined;

      switch (data.action) {
        case "register": {
          // Use ws itself as the sendable reference — it persists and can send.
          // Use ws.raw for identity comparison in registry.
          const ccPid =
            typeof data.cc_pid === "number" && Number.isFinite(data.cc_pid)
              ? data.cc_pid
              : null;
          const result = registry.register(data.name, ws, ws.raw, ccPid);
          if (!result.ok) {
            sendResponse(ws, requestId, false, undefined, result.error);
            return;
          }
          wsToAgent.set(ws.raw, data.name);

          const registeredFrame: RegisteredFrame = {
            event: "registered",
            name: result.entry.shortName,
            full_name: result.entry.fullName,
          };
          sendFrame(ws, registeredFrame);
          sendResponse(ws, requestId, true, {
            name: result.entry.shortName,
            full_name: result.entry.fullName,
          });

          // Drop the stale name on every dashboard if this was a rename
          // (same WS, new name). Propagation to mirror sessions is
          // handled below via the (host, ccPid) join — not keyed on the
          // old name — so that the join also fires on a fresh register
          // after hub restart, where `renamedFrom` is never set.
          if (result.renamedFrom) {
            dashboardBroadcastFn({
              event: "agent:disconnected",
              full_name: result.renamedFrom,
            });
          }

          // Forward half of the rename-propagation join: rewrite every
          // mirror session whose (host, ccPid) matches this agent to
          // use the newly-registered name. Silent no-op when ccPid is
          // null (pre-rollout client) or no sessions match yet.
          if (mirrorRegistry && ccPid !== null) {
            mirrorRegistry.attachAgent(
              result.entry.host,
              ccPid,
              result.entry.fullName,
            );
          }

          dashboardBroadcastFn({
            event: "agent:connected",
            name: result.entry.shortName,
            full_name: result.entry.fullName,
          });
          break;
        }

        case "send": {
          const senderName = requireRegistered(ws, requestId);
          if (!senderName) return;

          const result = router.routeDirect(
            senderName,
            data.to,
            data.content,
            data.type,
            data.reply_to,
          );
          if (!result.ok) {
            sendResponse(ws, requestId, false, undefined, result.error);
          } else {
            sendResponse(ws, requestId, true, {
              message_id: result.message_id,
              delivered: true,
            });
            dashboardBroadcastFn({
              event: "message:routed",
              message_id: result.message_id,
              from: senderName,
              to: data.to,
              type: data.type,
              content: data.content,
              reply_to: data.reply_to,
              timestamp: new Date().toISOString(),
            });
          }
          break;
        }

        case "broadcast": {
          const senderName = requireRegistered(ws, requestId);
          if (!senderName) return;

          const result = router.routeBroadcast(senderName, data.content);
          sendResponse(ws, requestId, true, {
            message_id: result.message_id,
            delivered_to: result.delivered_to,
          });
          dashboardBroadcastFn({
            event: "message:routed",
            message_id: result.message_id,
            from: senderName,
            to: "broadcast",
            type: "message",
            content: data.content,
            timestamp: new Date().toISOString(),
          });
          break;
        }

        case "send_team": {
          const senderName = requireRegistered(ws, requestId);
          if (!senderName) return;

          const result = router.routeTeam(
            senderName,
            data.team,
            data.content,
            data.type,
            data.reply_to,
          );
          if (!result.ok) {
            sendResponse(ws, requestId, false, undefined, result.error);
          } else {
            sendResponse(ws, requestId, true, {
              message_id: result.message_id,
              delivered_to: result.delivered_to,
            });
            dashboardBroadcastFn({
              event: "message:routed",
              message_id: result.message_id,
              from: senderName,
              to: `team:${data.team}`,
              type: data.type,
              content: data.content,
              team: data.team,
              reply_to: data.reply_to,
              timestamp: new Date().toISOString(),
            });
          }
          break;
        }

        case "join_team": {
          const senderName = requireRegistered(ws, requestId);
          if (!senderName) return;

          const members = teams.join(data.team, senderName);
          const agentEntry = registry.getByFullName(senderName);
          if (agentEntry) {
            agentEntry.teams.add(data.team);
          }
          sendResponse(ws, requestId, true, {
            team: data.team,
            members,
          });
          dashboardBroadcastFn({
            event: "team:changed",
            team: data.team,
            members,
            action: members.length === 1 ? "created" : "joined",
          });
          break;
        }

        case "leave_team": {
          const senderName = requireRegistered(ws, requestId);
          if (!senderName) return;

          const remaining = teams.leave(data.team, senderName);
          const agentEntry = registry.getByFullName(senderName);
          if (agentEntry) {
            agentEntry.teams.delete(data.team);
          }
          sendResponse(ws, requestId, true, {
            team: data.team,
            remaining_members: remaining,
          });
          dashboardBroadcastFn({
            event: "team:changed",
            team: data.team,
            members:
              remaining === 0 ? [] : [...(teams.getMembers(data.team) ?? [])],
            action: remaining === 0 ? "deleted" : "left",
          });
          break;
        }

        case "list_agents": {
          const agents = registry.list();
          sendResponse(ws, requestId, true, agents);
          break;
        }

        case "list_teams": {
          const teamList = teams.list();
          sendResponse(ws, requestId, true, teamList);
          break;
        }

        case "ping": {
          const senderName = requireRegistered(ws, requestId);
          if (!senderName) return;

          // Echo back as an inbound message so it arrives as a channel notification
          const pingFrame: InboundMessageFrame = {
            event: "message",
            message_id: crypto.randomUUID(),
            from: "hub@claude-net",
            to: senderName,
            type: "message",
            content: `claude-net channel active. Registered as ${senderName}.`,
            timestamp: new Date().toISOString(),
          };
          ws.send(JSON.stringify(pingFrame));
          sendResponse(ws, requestId, true, { pong: true });
          break;
        }

        default: {
          sendResponse(ws, requestId, false, undefined, "Unknown action");
        }
      }
    },

    close(ws: ElysiaWs) {
      const fullName = wsToAgent.get(ws.raw);
      if (!fullName) return;

      wsToAgent.delete(ws.raw);
      const entry = registry.getByFullName(fullName);
      registry.unregister(fullName);

      dashboardBroadcastFn({
        event: "agent:disconnected",
        name: entry?.shortName ?? fullName,
        full_name: fullName,
      });
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS handler typing requires flexible return
  }) as any;
}
