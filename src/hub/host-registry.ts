import crypto from "node:crypto";
import type {
  DashboardEvent,
  HostLaunchDoneFrame,
  HostLsDoneFrame,
  HostMkdirDoneFrame,
  HostRegisterFrame,
  HostSummary,
} from "@/shared/types";

type HostRpcResponse =
  | HostLsDoneFrame
  | HostMkdirDoneFrame
  | HostLaunchDoneFrame;

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
interface PendingRpc {
  resolve: (response: HostRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostRegistry {
  readonly hosts = new Map<string, HostEntry>();
  private dashboardBroadcast: (event: DashboardEvent) => void = () => {};
  /** Keyed by `${host_id}:${request_id}`. */
  private pendingRpcs = new Map<string, PendingRpc>();

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
   * registration off the map. Any pending RPCs for this host are
   * rejected so callers don't hang until timeout.
   */
  unregisterByIdentity(wsIdentity: object): void {
    for (const [hostId, entry] of this.hosts) {
      if (entry.wsIdentity === wsIdentity) {
        this.hosts.delete(hostId);
        const prefix = `${hostId}:`;
        for (const [key, pending] of this.pendingRpcs) {
          if (key.startsWith(prefix)) {
            this.pendingRpcs.delete(key);
            clearTimeout(pending.timer);
            pending.reject(new Error(`host '${hostId}' disconnected`));
          }
        }
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

  /**
   * Send an RPC frame to a host and await its matching _done response.
   * The request_id is generated here. Rejects if the host is offline,
   * the send throws, or the response takes longer than timeoutMs.
   */
  async sendRpc(
    hostId: string,
    action: "host_ls" | "host_mkdir" | "host_launch",
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<HostRpcResponse> {
    const entry = this.hosts.get(hostId);
    if (!entry) throw new Error(`host '${hostId}' not connected`);
    const requestId = crypto.randomUUID();
    const key = `${hostId}:${requestId}`;
    return new Promise<HostRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(key);
        reject(new Error(`host RPC ${action} timed out`));
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.pendingRpcs.set(key, { resolve, reject, timer });
      try {
        entry.send(JSON.stringify({ action, request_id: requestId, ...args }));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRpcs.delete(key);
        reject(err as Error);
      }
    });
  }

  /** Called by the WS handler when a host_* _done frame arrives. */
  resolveRpc(hostId: string, response: HostRpcResponse): void {
    const key = `${hostId}:${response.request_id}`;
    const pending = this.pendingRpcs.get(key);
    if (!pending) return;
    this.pendingRpcs.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(response);
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
