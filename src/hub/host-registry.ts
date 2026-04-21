import type {
  DashboardEvent,
  HostRegisterFrame,
  HostSummary,
} from "@/shared/types";

/**
 * An entry in the host registry. Each connected mirror-agent daemon
 * holds exactly one of these while its /ws/host socket is open.
 */
export interface HostEntry {
  hostId: string;
  user: string;
  hostname: string;
  home: string;
  recentCwds: string[];
  allowDangerousSkip: boolean;
  connectedAt: Date;
  /** Send a frame to the daemon. Thin wrapper over ws.send. */
  send(data: string): void;
  /** Identity token used to match disconnects to entries. */
  wsIdentity: object;
  /** Close the underlying WS (used when a duplicate registration arrives). */
  close?: () => void;
}

/**
 * Registry of connected mirror-agent daemons.
 *
 * The hub keeps one long-lived WS per daemon (distinct from the
 * per-session /ws/mirror/:sid sockets). The registry tracks which hosts
 * are online and fans connect/disconnect events out to dashboard
 * sockets so the sidebar can group sessions under their host.
 */
export class HostRegistry {
  readonly hosts = new Map<string, HostEntry>();
  private dashboardBroadcast: (event: DashboardEvent) => void = () => {};

  setDashboardBroadcast(fn: (event: DashboardEvent) => void): void {
    this.dashboardBroadcast = fn;
  }

  /**
   * Accept a new host connection. If an entry already exists for the
   * same host_id the existing connection is closed — the fresh
   * registration is authoritative (covers the "stale TCP half-open +
   * new connect arrived" case).
   */
  register(
    frame: HostRegisterFrame,
    conn: { send(data: string): void; wsIdentity: object; close?: () => void },
  ): HostEntry {
    const existing = this.hosts.get(frame.host_id);
    if (existing) {
      try {
        existing.close?.();
      } catch {
        // ignore
      }
      this.hosts.delete(frame.host_id);
    }

    const entry: HostEntry = {
      hostId: frame.host_id,
      user: frame.user,
      hostname: frame.hostname,
      home: frame.home,
      recentCwds: Array.isArray(frame.recent_cwds)
        ? frame.recent_cwds.slice(0, 20)
        : [],
      allowDangerousSkip: Boolean(frame.allow_dangerous_skip),
      connectedAt: new Date(),
      send: conn.send,
      wsIdentity: conn.wsIdentity,
      close: conn.close,
    };
    this.hosts.set(entry.hostId, entry);

    this.dashboardBroadcast({
      event: "host:connected",
      host_id: entry.hostId,
      user: entry.user,
      hostname: entry.hostname,
      home: entry.home,
      recent_cwds: entry.recentCwds,
      allow_dangerous_skip: entry.allowDangerousSkip,
      connected_at: entry.connectedAt.toISOString(),
    });

    return entry;
  }

  /**
   * Remove an entry identified by the WS object. Idempotent. Only
   * matches on wsIdentity so stale disconnects don't knock a newer
   * registration off the map.
   */
  unregisterByIdentity(wsIdentity: object): void {
    for (const [hostId, entry] of this.hosts) {
      if (entry.wsIdentity === wsIdentity) {
        this.hosts.delete(hostId);
        this.dashboardBroadcast({
          event: "host:disconnected",
          host_id: hostId,
        });
        return;
      }
    }
  }

  /** Look up a connected host by id. */
  get(hostId: string): HostEntry | undefined {
    return this.hosts.get(hostId);
  }

  /** Summary of every currently-connected host, for GET /api/hosts. */
  list(): HostSummary[] {
    return [...this.hosts.values()].map((h) => ({
      host_id: h.hostId,
      user: h.user,
      hostname: h.hostname,
      home: h.home,
      recent_cwds: h.recentCwds,
      allow_dangerous_skip: h.allowDangerousSkip,
      connected_at: h.connectedAt.toISOString(),
    }));
  }
}
