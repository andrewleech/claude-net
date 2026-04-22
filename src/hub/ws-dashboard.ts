import type { DashboardEvent, InboundMessageFrame } from "@/shared/types";
import type { Elysia } from "elysia";
import type { HostRegistry } from "./host-registry";
import type { Registry } from "./registry";
import type { Teams } from "./teams";

interface DashboardWs {
  send(data: string | object): void;
  raw: object;
}

const dashboardClients = new Set<DashboardWs>();

export const DASHBOARD_AGENT_NAME = "dashboard@hub";
export const DASHBOARD_SHORT_NAME = "dashboard";

export function broadcastToDashboards(event: DashboardEvent): void {
  const payload = JSON.stringify(event);
  for (const client of dashboardClients) {
    try {
      client.send(payload);
    } catch {
      // Client may have disconnected; remove on next close event
    }
  }
}

/**
 * Route a message addressed to dashboard@hub to all connected dashboard clients.
 * Returns true if at least one dashboard client received the message.
 */
export function routeToDashboard(frame: InboundMessageFrame): boolean {
  if (dashboardClients.size === 0) return false;
  const payload = JSON.stringify({
    event: "dashboard:message",
    ...frame,
  });
  for (const client of dashboardClients) {
    try {
      client.send(payload);
    } catch {
      // ignore
    }
  }
  return true;
}

export function hasDashboardClients(): boolean {
  return dashboardClients.size > 0;
}

function pushInitialState(
  ws: DashboardWs,
  registry: Registry,
  teams: Teams,
  hostRegistry?: HostRegistry,
): void {
  // Send current agents as agent:connected events
  for (const agent of registry.agents.values()) {
    ws.send(
      JSON.stringify({
        event: "agent:connected",
        name: agent.shortName,
        full_name: agent.fullName,
      }),
    );
  }

  // Send current teams as team:changed created events
  for (const [teamName, members] of teams.teams) {
    ws.send(
      JSON.stringify({
        event: "team:changed",
        team: teamName,
        members: [...members],
        action: "created",
      }),
    );
  }

  // Send currently-connected hosts so a reloaded dashboard immediately
  // knows which hosts are online without waiting for a daemon to reconnect.
  if (hostRegistry) {
    for (const host of hostRegistry.list()) {
      ws.send(JSON.stringify({ event: "host:connected", ...host }));
    }
  }
}

export function wsDashboardPlugin(
  app: Elysia,
  registry: Registry,
  teams: Teams,
  hostRegistry?: HostRegistry,
): Elysia {
  return app.ws("/ws/dashboard", {
    open(ws: DashboardWs) {
      dashboardClients.add(ws);
      pushInitialState(ws, registry, teams, hostRegistry);
    },

    message(_ws: DashboardWs, _data: unknown) {
      // Dashboard sends messages via REST API, not WebSocket
      // Reserved for future extensibility
    },

    close(ws: DashboardWs) {
      dashboardClients.delete(ws);
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS handler typing requires flexible return
  }) as any;
}
