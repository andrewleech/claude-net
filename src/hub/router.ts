import type { InboundMessageFrame, MessageType } from "@/shared/types";
import type { Registry } from "./registry";
import type { Teams } from "./teams";
import {
  DASHBOARD_AGENT_NAME,
  DASHBOARD_SHORT_NAME,
  hasDashboardClients,
  routeToDashboard,
} from "./ws-dashboard";

export class Router {
  private registry: Registry;
  private teams: Teams;

  constructor(registry: Registry, teams: Teams) {
    this.registry = registry;
    this.teams = teams;
  }

  routeDirect(
    from: string,
    to: string,
    content: string,
    type: MessageType = "message",
    reply_to?: string,
  ):
    | { ok: true; message_id: string; delivered: true }
    | { ok: false; error: string } {
    // Handle dashboard@hub as a virtual agent
    if (to === DASHBOARD_AGENT_NAME || to === DASHBOARD_SHORT_NAME) {
      if (!hasDashboardClients()) {
        return { ok: false, error: "Dashboard is not connected." };
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
      return { ok: true, message_id, delivered: true };
    }

    const resolved = this.registry.resolve(to);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
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

    resolved.entry.ws.send(JSON.stringify(frame));
    return { ok: true, message_id, delivered: true };
  }

  routeBroadcast(
    from: string,
    content: string,
  ): { ok: true; message_id: string; delivered_to: number } {
    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    let count = 0;

    for (const entry of this.registry.agents.values()) {
      if (entry.fullName === from) continue;

      const frame: InboundMessageFrame = {
        event: "message",
        message_id,
        from,
        to: "broadcast",
        type: "message",
        content,
        timestamp,
      };
      entry.ws.send(JSON.stringify(frame));
      count++;
    }

    return { ok: true, message_id, delivered_to: count };
  }

  routeTeam(
    from: string,
    team: string,
    content: string,
    type: MessageType = "message",
    reply_to?: string,
  ):
    | { ok: true; message_id: string; delivered_to: number }
    | { ok: false; error: string } {
    const members = this.teams.getMembers(team);
    if (!members) {
      return { ok: false, error: `Team '${team}' does not exist.` };
    }

    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    let count = 0;

    for (const memberName of members) {
      if (memberName === from) continue;
      const entry = this.registry.getByFullName(memberName);
      if (!entry) continue; // offline member

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
      entry.ws.send(JSON.stringify(frame));
      count++;
    }

    if (count === 0) {
      return { ok: false, error: `No online members in team '${team}'.` };
    }

    return { ok: true, message_id, delivered_to: count };
  }
}
