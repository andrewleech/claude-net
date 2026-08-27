import type {
  DashboardEvent,
  ErrorFrame,
  GetMailboxResponseData,
  InboundMessageFrame,
  PluginFrame,
  RegisterResponseData,
  RegisteredFrame,
  ResponseFrame,
} from "@/shared/types";
import type { Elysia } from "elysia";
import type { EventLog } from "./event-log";
import type { HostRegistry } from "./host-registry";
import type { MirrorRegistry } from "./mirror";
import { type Registry, parseName } from "./registry";
import type { Router } from "./router";
import type { Teams } from "./teams";
import { PLUGIN_VERSION_CURRENT, buildUpgradeHint } from "./version";

// Elysia WS handler context — the wrapper object changes per callback,
// but ws.raw (the underlying ServerWebSocket) is stable across open/message/close.
interface ElysiaWs {
  send(data: string | object): void;
  raw: object;
  id: string;
}

// Map from raw ServerWebSocket reference to registered fullName
const wsToAgent = new WeakMap<object, string>();

// WS references the ping tick is closing due to stale-pong eviction.
// The close handler checks membership to distinguish `reason: "evicted"`
// from `reason: "close"`.
const evictingWs = new WeakSet<object>();

export function markEvicting(ws: object): void {
  evictingWs.add(ws);
}

let dashboardBroadcastFn: (event: DashboardEvent) => void = () => {};

export function setDashboardBroadcast(
  fn: (event: DashboardEvent) => void,
): void {
  dashboardBroadcastFn = fn;
}

function sendFrame(ws: ElysiaWs, frame: object): void {
  ws.send(JSON.stringify(frame));
}

function sendResponseFrame(
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
    sendResponseFrame(
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

/**
 * Compute the informational hub URL embedded in the upgrade hint.
 * Prefers `CLAUDE_NET_HOST` (the same env var the setup route consults),
 * falling back to `http://localhost:<port>`. This is *not* authoritative —
 * a remote user reading the hint can correct the URL locally if needed.
 *
 * Kept deliberately simple: the WS register path has no request context,
 * so `resolveCanonicalHubUrl` (which inspects `Host` / `X-Forwarded-*`
 * headers) is not applicable here.
 */
function resolveHubUrlForHint(port: number): string {
  const envHost = process.env.CLAUDE_NET_HOST;
  if (envHost && envHost.length > 0) {
    if (/^https?:\/\//i.test(envHost)) return envHost.replace(/\/$/, "");
    return `http://${envHost.replace(/\/$/, "")}`;
  }
  return `http://localhost:${port}`;
}

export function wsPlugin(
  app: Elysia,
  registry: Registry,
  teams: Teams,
  router: Router,
  eventLog: EventLog,
  mirrorRegistry?: MirrorRegistry,
  /**
   * Listen port, used only to build the upgrade-hint URL fallback
   * when `CLAUDE_NET_HOST` is unset. Defaults to the same value the
   * setup plugin uses so behavior is consistent across routes.
   */
  port: number = Number(process.env.CLAUDE_NET_PORT) || 4815,
  hostRegistry?: HostRegistry,
): Elysia {
  const emit = (event: string, data: Record<string, unknown>): void => {
    eventLog.push(event, data);
  };
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

      // Tracks whether a handler already sent a response for this frame,
      // so the catch below never sends a second, contradictory one (e.g.
      // a throw from `emit`/`dashboardBroadcastFn` after a case already
      // reported success). Shadows the module-level sendResponseFrame —
      // every call inside `dispatch` resolves to this wrapper.
      let responded = false;
      const sendResponse = (
        wsArg: ElysiaWs,
        reqId: string | undefined,
        ok: boolean,
        respData?: unknown,
        error?: string,
      ): void => {
        responded = true;
        sendResponseFrame(wsArg, reqId, ok, respData, error);
      };

      // A field a handler assumes is a given type (e.g. `to`/`agent`
      // being a string) can throw when the client sends something else,
      // and that must not crash the whole WS connection — catch here and
      // answer with an error response instead of letting it propagate
      // out of the WS callback. The label is deliberately generic: this
      // catches both malformed client input and genuine handler bugs,
      // and callers can't distinguish the two from the message alone.
      try {
        dispatch(data, requestId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // sendResponse is a no-op without a requestId (fire-and-forget
        // frames get no reply) — log to the event log too, or a thrown
        // handler error on one of those frames would vanish with no
        // trace anywhere. Guarded on its own: a throw from eventLog.push
        // here must not escape this catch — that would defeat the very
        // guard this try/catch exists to provide.
        try {
          emit("dispatch.error", { action: data.action, error: message });
        } catch {
          // best-effort logging only
        }
        if (!responded) {
          sendResponse(
            ws,
            requestId,
            false,
            undefined,
            `Internal error handling '${data.action}': ${message}`,
          );
        }
      }

      function dispatch(data: PluginFrame, requestId: string | undefined) {
        switch (data.action) {
          case "register": {
            // Missing channel_capable field is treated as `false` — old plugins
            // are visibly broken at send time rather than silently half-broken.
            const channelCapable =
              typeof data.channel_capable === "boolean"
                ? data.channel_capable
                : false;

            // Plugins from before the (host, cc_pid) join landed don't
            // send `cc_pid`. Treat as null — the rename-join silently
            // no-ops for that session until the plugin upgrades.
            const ccPid =
              typeof data.cc_pid === "number" && Number.isFinite(data.cc_pid)
                ? data.cc_pid
                : null;

            const cwd =
              typeof data.cwd === "string" && data.cwd.length > 0
                ? data.cwd
                : null;

            // Use ws itself as the sendable reference — it persists and can send.
            // Use ws.raw for identity comparison in registry.
            const result = registry.register(data.name, ws, ws.raw, {
              channelCapable,
              ccPid,
              cwd,
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

            // Compare plugin's self-reported version against the hub's
            // canonical version. On mismatch or missing field, include an
            // upgrade_hint the plugin will surface on the next tool result.
            const reportedVersion =
              typeof data.plugin_version === "string"
                ? data.plugin_version
                : undefined;
            const registerResponse: RegisterResponseData = {
              name: result.entry.shortName,
              full_name: result.entry.fullName,
            };
            if (reportedVersion !== PLUGIN_VERSION_CURRENT) {
              registerResponse.upgrade_hint = buildUpgradeHint(
                resolveHubUrlForHint(port),
                reportedVersion,
              );
              emit("agent.upgraded", {
                fullName: result.entry.fullName,
                reportedVersion: reportedVersion ?? null,
                currentVersion: PLUGIN_VERSION_CURRENT,
              });
            }
            sendResponse(ws, requestId, true, registerResponse);

            emit("agent.registered", {
              fullName: result.entry.fullName,
              channelCapable: result.entry.channelCapable,
              pluginVersion: reportedVersion ?? null,
              restored: result.restored,
              ...(result.renamedFrom
                ? { renamedFrom: result.renamedFrom }
                : {}),
            });

            // If this was a rename (same WS, new name), tell every
            // dashboard to drop the old agent name. Mirror-session
            // relabel happens via the (host, cc_pid) join below — the
            // old wsIdentity-based renameOwner path is gone because it
            // matched by ownerAgent string and would broad-rename fork
            // siblings sharing a cwd-derived owner.
            if (result.renamedFrom) {
              // Carry any mailbox slot deposited under the old name
              // forward, the same way team memberships and mirror-session
              // labels already follow a rename.
              router.mailbox.rekey(result.renamedFrom, result.entry.fullName);
              // AgentEntry.teams (which team names this agent is in) was
              // already carried forward by registry.register(); this
              // updates the other side — each team's *membership set*,
              // which otherwise would still list the dead name.
              teams.renameMember(result.renamedFrom, result.entry.fullName);
              // Tell dashboards about the membership-key swap on every team
              // the renamed agent belongs to, the same as join_team/
              // leave_team do — otherwise a live dashboard keeps showing
              // the dead name in that team's member list.
              for (const teamName of result.entry.teams) {
                const members = teams.getMembers(teamName);
                if (!members) continue;
                dashboardBroadcastFn({
                  event: "team:changed",
                  team: teamName,
                  members: [...members],
                  action: "renamed",
                });
              }
              dashboardBroadcastFn({
                event: "agent:disconnected",
                name: parseName(result.renamedFrom).session,
                full_name: result.renamedFrom,
              });
              emit("agent.disconnected", {
                fullName: result.renamedFrom,
                reason: "renamed",
              });
            }

            // (host, cc_pid) join: rewrite every mirror session whose
            // identity matches this agent's, so a rename via register()
            // propagates to the dashboard's mirror-row label even after
            // a hub restart (where wsIdentity-based rename detection
            // can't fire). Silent no-op when ccPid is null.
            if (mirrorRegistry && ccPid !== null) {
              mirrorRegistry.attachAgent(
                result.entry.host,
                ccPid,
                result.entry.fullName,
              );
              // If no mirror session exists yet for this (host, ccPid),
              // probe the mirror-agent daemon to create one. Covers the
              // common case where the mirror-agent restarted and lost its
              // in-memory sessions while Claude Code was still running.
              if (
                cwd !== null &&
                !mirrorRegistry.hasSessionForHostPid(result.entry.host, ccPid)
              ) {
                const hostEntry = hostRegistry?.get(
                  `${result.entry.user}@${result.entry.host}`,
                );
                if (hostEntry) {
                  hostEntry.send(
                    JSON.stringify({
                      action: "host_session_probe",
                      cc_pid: ccPid,
                      cwd,
                    }),
                  );
                }
              }
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

            const startedAt = Date.now();
            const result = router.routeDirect(
              senderName,
              data.to,
              data.content,
              data.type,
              data.reply_to,
            );
            const elapsedMs = Date.now() - startedAt;
            if (!result.ok) {
              // Structured NAK carries `outcome` + `reason` + `mailbox` so
              // tools processing the response programmatically can
              // distinguish offline / no-channel / transport-error /
              // no-dashboard / ambiguous / invalid-content, and tell
              // whether the content actually landed in the recipient's
              // mailbox slot rather than nowhere at all.
              sendResponse(
                ws,
                requestId,
                false,
                {
                  outcome: "nak",
                  reason: result.reason,
                  mailbox: result.mailbox,
                },
                result.error,
              );
              emit("message.sent", {
                from: senderName,
                to: data.to,
                messageId: null,
                outcome: "nak",
                reason: result.reason,
                mailbox: result.mailbox,
                elapsedMs,
              });
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
              emit("message.sent", {
                from: senderName,
                to: data.to,
                messageId: result.message_id,
                outcome: "delivered",
                elapsedMs,
              });
            }
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
              sendResponse(
                ws,
                requestId,
                false,
                { mailbox: result.mailbox },
                result.error,
              );
            } else {
              sendResponse(ws, requestId, true, {
                message_id: result.message_id,
                delivered_to: result.delivered_to,
                skipped_no_channel: result.skipped_no_channel,
                mailbox: result.mailbox,
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
              emit("message.team", {
                from: senderName,
                team: data.team,
                messageId: result.message_id,
                deliveredTo: result.delivered_to,
                skippedNoChannel: result.skipped_no_channel,
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

          case "query_events": {
            const senderName = requireRegistered(ws, requestId);
            if (!senderName) return;

            const events = eventLog.query({
              event: data.event,
              since: data.since,
              limit: data.limit,
              agent: data.agent,
            });
            sendResponse(ws, requestId, true, {
              events,
              count: events.length,
              oldest_ts: eventLog.oldestTs(),
              capacity: eventLog.capacity,
            });
            break;
          }

          case "get_mailbox": {
            const senderName = requireRegistered(ws, requestId);
            if (!senderName) return;

            let targetFullName = senderName;
            // Whether the caller named a target at all — as opposed to
            // the implicit "my own mailbox" default. Used below to gate
            // markRead: a *resolved* match against the caller's own name
            // doesn't mean the caller *asked* for their own name (e.g. a
            // partial address whose only remaining match happens to be
            // the caller itself after a sibling session went offline).
            const explicitAgent =
              data.agent !== undefined && data.agent !== null;
            if (explicitAgent) {
              if (typeof data.agent !== "string") {
                sendResponse(
                  ws,
                  requestId,
                  false,
                  undefined,
                  "agent must be a string",
                );
                return;
              }
              const resolved = registry.resolve(data.agent);
              if (resolved.ok) {
                targetFullName = resolved.entry.fullName;
              } else if (resolved.ambiguous) {
                // Multiple *online* agents match `data.agent` right now —
                // report the live collision directly, the same as
                // routeDirect does. Falling through to
                // resolveSeenNameOrAmbiguous here would apply a different
                // match priority over a different (all-time-seen)
                // population and could silently collapse to a third,
                // unrelated agent's mailbox.
                sendResponse(ws, requestId, false, undefined, resolved.error);
                return;
              } else {
                const seen = registry.resolveSeenNameOrAmbiguous(data.agent);
                // An ambiguous partial name (matches >1 seen fullName) must
                // surface as an error, not a silent `found: false` — that
                // would be indistinguishable from "this agent exists and
                // has an empty mailbox".
                if (seen && "error" in seen) {
                  sendResponse(ws, requestId, false, undefined, seen.error);
                  return;
                }
                targetFullName = seen ? seen.fullName : data.agent;
              }
            }

            const entry = router.mailbox.get(targetFullName);
            const response: GetMailboxResponseData = entry
              ? { found: true, entry: { ...entry } }
              : { found: false };
            // Mark read whenever the resolved target IS the caller,
            // regardless of what address form they used to name
            // themselves — resolve()/resolveSeenNameOrAmbiguous only land
            // on senderName when the caller's own identity is the sole
            // referent, so this is never a sibling's peek landing on the
            // caller by coincidence.
            if (entry && targetFullName === senderName) {
              router.mailbox.markRead(targetFullName);
            }
            sendResponse(ws, requestId, true, response);
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

          case "update_channel_capable": {
            const senderName = requireRegistered(ws, requestId);
            if (!senderName) return;
            if (typeof data.channel_capable !== "boolean") {
              sendResponse(
                ws,
                requestId,
                false,
                undefined,
                "channel_capable must be a boolean",
              );
              return;
            }
            const ok = registry.setChannelCapable(
              senderName,
              data.channel_capable,
            );
            if (!ok) {
              sendResponse(ws, requestId, false, undefined, "Agent not found");
              return;
            }
            emit("agent.channel_capable_changed", {
              fullName: senderName,
              channelCapable: data.channel_capable,
            });
            sendResponse(ws, requestId, true, {
              channel_capable: data.channel_capable,
            });
            break;
          }

          default: {
            sendResponse(ws, requestId, false, undefined, "Unknown action");
          }
        }
      }
    },

    close(ws: ElysiaWs) {
      const fullName = wsToAgent.get(ws.raw);
      if (!fullName) return;

      const evicted = evictingWs.has(ws.raw);
      evictingWs.delete(ws.raw);
      wsToAgent.delete(ws.raw);
      const entry = registry.getByFullName(fullName);
      // Stale close: if a same-session reconnect already reclaimed this
      // name on a fresh socket, `entry` now belongs to that socket. Our
      // own map bookkeeping is cleaned up above, but don't unregister or
      // announce a disconnect for the live owner.
      if (entry && entry.wsIdentity !== ws.raw) return;
      registry.unregister(fullName, ws.raw);

      dashboardBroadcastFn({
        event: "agent:disconnected",
        name: entry?.shortName ?? fullName,
        full_name: fullName,
      });
      emit("agent.disconnected", {
        fullName,
        reason: evicted ? "evicted" : "close",
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
      if (entry) entry.lastPongAt = Date.now();
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS handler typing requires flexible return
  }) as any;
}
