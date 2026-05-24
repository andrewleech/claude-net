import type {
  InboundMessageFrame,
  MessageType,
  SendNakReason,
} from "@/shared/types";
import type { Registry } from "./registry";
import type { Teams } from "./teams";
import {
  DASHBOARD_AGENT_NAME,
  DASHBOARD_SHORT_NAME,
  hasDashboardClients,
  routeToDashboard,
} from "./ws-dashboard";

export type RouteDirectResult =
  | {
      ok: true;
      message_id: string;
      outcome: "delivered";
      to_dashboard?: boolean;
    }
  | {
      ok: false;
      outcome: "nak";
      reason: SendNakReason;
      error: string;
    };

export type RouteBroadcastResult = {
  ok: true;
  message_id: string;
  delivered_to: number;
  skipped_no_channel: number;
};

export type RouteTeamResult =
  | {
      ok: true;
      message_id: string;
      delivered_to: number;
      skipped_no_channel: number;
    }
  | { ok: false; error: string };

export class Router {
  private registry: Registry;
  private teams: Teams;

  constructor(registry: Registry, teams: Teams) {
    this.registry = registry;
    this.teams = teams;
  }

  /**
   * Direct send. Returns a structured outcome so ws-plugin can translate
   * NAK reasons into a specific error field for the sender's LLM.
   */
  routeDirect(
    from: string,
    to: string,
    content: string,
    type: MessageType = "message",
    reply_to?: string,
  ): RouteDirectResult {
    // Dashboard virtual agent — route by presence of dashboard clients.
    if (to === DASHBOARD_AGENT_NAME || to === DASHBOARD_SHORT_NAME) {
      if (!hasDashboardClients()) {
        return {
          ok: false,
          outcome: "nak",
          reason: "no-dashboard",
          error: "Dashboard is not connected.",
        };
      }
      const message_id = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const frame: InboundMessageFrame = {
        event: "message",
        message_id,
        from,
        to: DASHBOARD_AGENT_NAME,
        type,
        content,
        timestamp,
        ...(reply_to ? { reply_to } : {}),
      };
      routeToDashboard(frame);
      return {
        ok: true,
        message_id,
        outcome: "delivered",
        to_dashboard: true,
      };
    }

    const resolved = this.registry.resolve(to);
    if (!resolved.ok) {
      return {
        ok: false,
        outcome: "nak",
        reason: "offline",
        error: resolved.error,
      };
    }

    if (!resolved.entry.channelCapable) {
      return {
        ok: false,
        outcome: "nak",
        reason: "no-channel",
        error: `Recipient '${resolved.entry.fullName}' does not have channels enabled and cannot receive messages. They need to run \`install-channels\` on their host.`,
      };
    }

    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const frame: InboundMessageFrame = {
      event: "message",
      message_id,
      from,
      to: resolved.entry.fullName,
      type,
      content,
      timestamp,
      ...(reply_to ? { reply_to } : {}),
    };

    try {
      resolved.entry.ws.send(JSON.stringify(frame));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        outcome: "nak",
        reason: "transport-error",
        error: `Failed to deliver to '${resolved.entry.fullName}': ${message}`,
      };
    }
    return { ok: true, message_id, outcome: "delivered" };
  }

  routeBroadcast(from: string, content: string): RouteBroadcastResult {
    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    let delivered_to = 0;
    let skipped_no_channel = 0;

    const frame: InboundMessageFrame = {
      event: "message",
      message_id,
      from,
      to: "broadcast",
      type: "message",
      content,
      timestamp,
    };
    const serialized = JSON.stringify(frame);

    for (const entry of this.registry.agents.values()) {
      if (entry.fullName === from) continue;
      if (!entry.channelCapable) {
        skipped_no_channel++;
        continue;
      }

      try {
        entry.ws.send(serialized);
        delivered_to++;
      } catch {
        // Half-open WS — the close handler will clean it up.
      }
    }

    return { ok: true, message_id, delivered_to, skipped_no_channel };
  }

  routeTeam(
    from: string,
    team: string,
    content: string,
    type: MessageType = "message",
    reply_to?: string,
  ): RouteTeamResult {
    const members = this.teams.getMembers(team);
    if (!members) {
      return { ok: false, error: `Team '${team}' does not exist.` };
    }

    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    let delivered_to = 0;
    let skipped_no_channel = 0;

    const frame: InboundMessageFrame = {
      event: "message",
      message_id,
      from,
      to: `team:${team}`,
      type,
      content,
      team,
      timestamp,
      ...(reply_to ? { reply_to } : {}),
    };
    const serialized = JSON.stringify(frame);

    for (const memberName of members) {
      if (memberName === from) continue;
      const entry = this.registry.getByFullName(memberName);
      if (!entry) continue;
      if (!entry.channelCapable) {
        skipped_no_channel++;
        continue;
      }

      try {
        entry.ws.send(serialized);
        delivered_to++;
      } catch {}
    }

    if (delivered_to === 0 && skipped_no_channel === 0) {
      return { ok: false, error: `No online members in team '${team}'.` };
    }

    return { ok: true, message_id, delivered_to, skipped_no_channel };
  }

  /**
   * Deliver a hub-originated notification to `to`. The from-field is the
   * reserved `system@claude-net` identity (structurally unforgeable —
   * isValidAgentName rejects it on register, see registry.ts), so a
   * receiving LLM that follows the documented trust model can
   * distinguish this from agent-to-agent traffic.
   *
   * Used today for the delivery-failure feedback path: when a recipient's
   * Claude Code reports an API error after receiving a message, the hub
   * routes a system notification back to the original sender so they
   * know their message may not have been processed. Unlike routeDirect
   * this does NOT NAK on no-channel — there is no caller to surface a
   * NAK to (the hub originates the message), so the outcome is just
   * "delivered" or "skipped" with no error path.
   */
  routeSystemNotification(
    to: string,
    content: string,
  ): { ok: true; outcome: "delivered" | "skipped"; reason?: string } {
    const resolved = this.registry.resolve(to);
    if (!resolved.ok) {
      return { ok: true, outcome: "skipped", reason: "offline" };
    }
    if (!resolved.entry.channelCapable) {
      return { ok: true, outcome: "skipped", reason: "no-channel" };
    }
    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const frame: InboundMessageFrame = {
      event: "message",
      message_id,
      from: "system@claude-net",
      to: resolved.entry.fullName,
      type: "message",
      content,
      timestamp,
    };
    try {
      resolved.entry.ws.send(JSON.stringify(frame));
    } catch {
      return { ok: true, outcome: "skipped", reason: "transport-error" };
    }
    return { ok: true, outcome: "delivered" };
  }
}
