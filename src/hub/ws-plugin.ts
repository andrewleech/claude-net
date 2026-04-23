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
          // FR3: plugin reports its MCP channel capability on register.
          // Missing field is treated as `false` (NG5) — old plugins that
          // haven't been updated are visibly broken at send time rather
          // than silently half-broken.
          const channelCapable =
            typeof data.channel_capable === "boolean"
              ? data.channel_capable
              : false;

          // Use ws itself as the sendable reference — it persists and can send.
          // Use ws.raw for identity comparison in registry.
          const result = registry.register(data.name, ws, ws.raw, {
            channelCapable,
          });
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

          // If this was a rename (same WS, new name), tell every
          // dashboard to drop the old name and propagate the rename
          // into mirror sessions so sidebar labels update in place.
          if (result.renamedFrom) {
            // Parse the shortName out of the old full_name (session portion
            // before `:`, falling back to the full string for legacy names).
            const renamedFromShortName =
              result.renamedFrom.split(":")[0] ?? result.renamedFrom;
            dashboardBroadcastFn({
              event: "agent:disconnected",
              name: renamedFromShortName,
              full_name: result.renamedFrom,
            });
            mirrorRegistry?.renameOwner(
              result.renamedFrom,
              result.entry.fullName,
            );
          }

          dashboardBroadcastFn({
            event: "agent:connected",
            name: result.entry.shortName,
            full_name: result.entry.fullName,
            channel_capable: result.entry.channelCapable,
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
            // FR5: structured NAK carries `outcome` + `reason` so
            // tools processing the response programmatically can
            // distinguish offline / no-channel / unknown / no-dashboard.
            sendResponse(
              ws,
              requestId,
              false,
              { outcome: "nak", reason: result.reason },
              result.error,
            );
          } else {
            // Keep `delivered: true` alongside the new `outcome` field
            // so existing dashboard parsers that only inspect `delivered`
            // continue to work.
            sendResponse(ws, requestId, true, {
              message_id: result.message_id,
              delivered: true,
              outcome: "delivered",
              ...(result.to_dashboard ? { to_dashboard: true } : {}),
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
            skipped_no_channel: result.skipped_no_channel,
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
              skipped_no_channel: result.skipped_no_channel,
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

    // Bun ServerWebSocket surfaces native WS pong frames here. The hub's
    // ping tick (see createHub in index.ts) sends periodic pings; the ws
    // npm library on the plugin side auto-responds with pongs. Advancing
    // lastPongAt here keeps the liveness check fresh — absence of pongs
    // for >staleThresholdMs triggers the tick to close the WS.
    //
    // NOTE: Elysia's Bun adapter invokes pong (and ping) with the raw
    // Bun ServerWebSocket directly — NOT wrapped in ElysiaWS as the
    // open/message/close handlers are. So the lookup key is `ws` here,
    // not `ws.raw`.
    pong(ws: object) {
      const fullName = wsToAgent.get(ws);
      if (!fullName) return;
      const entry = registry.getByFullName(fullName);
      if (entry) entry.lastPongAt = new Date();
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS handler typing requires flexible return
  }) as any;
}
