import type { AgentInfo } from "@/shared/types";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export interface AgentEntry {
  fullName: string;
  shortName: string;
  user: string;
  host: string;
  ws: { send(data: string): void };
  /** Stable identity reference for WS comparison (e.g. Elysia's ws.raw). */
  wsIdentity: object;
  teams: Set<string>;
  connectedAt: Date;
  lastPongAt: number;
  channelCapable: boolean;
}

export interface DisconnectedEntry {
  fullName: string;
  teams: Set<string>;
  disconnectedAt: Date;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface RegistryOptions {
  disconnectTimeoutMs?: number;
}

export class Registry {
  readonly agents = new Map<string, AgentEntry>();
  readonly disconnected = new Map<string, DisconnectedEntry>();
  private disconnectTimeoutMs: number;
  private onTimeoutCleanup?: (fullName: string, teams: Set<string>) => void;

  constructor(options?: RegistryOptions) {
    this.disconnectTimeoutMs = options?.disconnectTimeoutMs ?? TWO_HOURS_MS;
  }

  /** Set a callback invoked when a disconnect timeout fires, before the entry is removed. */
  setTimeoutCleanup(fn: (fullName: string, teams: Set<string>) => void): void {
    this.onTimeoutCleanup = fn;
  }

  /**
   * Register an agent.
   * @param fullName - Agent name in `session:user@host` format (or legacy `name@host`)
   * @param ws - WebSocket-like object with send() method
   * @param wsIdentity - Stable identity reference for same-connection detection.
   *   Defaults to `ws` itself. For Elysia, pass `ws.raw` since the wrapper changes per callback.
   *
   * Rename: if this WS identity is already registered under a different
   * name, that's treated as a rename. The old entry is dropped and its
   * team memberships are carried forward onto the new name. The caller
   * gets the dropped name back in `renamedFrom` so it can broadcast an
   * `agent:disconnected` for it and propagate the rename to other
   * subsystems (mirror sessions, etc.).
   */
  register(
    fullName: string,
    ws: { send(data: string): void },
    wsIdentity?: object,
    options: { channelCapable?: boolean } = {},
  ):
    | {
        ok: true;
        entry: AgentEntry;
        restored: boolean;
        renamedFrom?: string;
      }
    | { ok: false; error: string } {
    const identity = wsIdentity ?? ws;
    const channelCapable = options.channelCapable ?? false;

    // Detect rename: same wsIdentity, different name. At most one match
    // is possible because register() maintains the invariant.
    let renamedFrom: string | undefined;
    let inheritedTeams: Set<string> | null = null;
    for (const [existingName, entry] of this.agents) {
      if (entry.wsIdentity === identity && existingName !== fullName) {
        renamedFrom = existingName;
        inheritedTeams = new Set(entry.teams);
        this.agents.delete(existingName);
        break;
      }
    }

    const existing = this.agents.get(fullName);
    if (existing && existing.wsIdentity !== identity) {
      return {
        ok: false,
        error: `Name '${fullName}' is already registered. Choose a different name.`,
      };
    }

    if (existing && existing.wsIdentity === identity) {
      // Update ws reference (Elysia wrapper may change). Keep
      // channelCapable coherent — in practice it won't change across a
      // single plugin process, but a silent plugin restart sharing the
      // same WS identity (test fixture edge case) should reflect the
      // newest value. lastPongAt is deliberately NOT reset here —
      // liveness is a property of the transport, not of a re-register.
      existing.ws = ws;
      existing.channelCapable = channelCapable;
      return { ok: true, entry: existing, restored: false };
    }

    const { session, user, host } = parseName(fullName);

    // Check disconnected — restore team memberships
    const disc = this.disconnected.get(fullName);
    let restoredTeams: Set<string>;
    let restored = false;
    if (disc) {
      clearTimeout(disc.timeoutId);
      restoredTeams = disc.teams;
      restored = true;
      this.disconnected.delete(fullName);
    } else {
      restoredTeams = new Set();
    }

    const entry: AgentEntry = {
      fullName,
      shortName: session,
      user,
      host,
      ws,
      wsIdentity: identity,
      // Rename wins over disconnected-restore if both apply (unlikely).
      teams: inheritedTeams ?? restoredTeams,
      connectedAt: new Date(),
      lastPongAt: Date.now(),
      channelCapable,
    };
    this.agents.set(fullName, entry);
    return { ok: true, entry, restored, renamedFrom };
  }

  unregister(fullName: string): void {
    const entry = this.agents.get(fullName);
    if (!entry) return;

    this.agents.delete(fullName);

    // Only track in disconnected if the agent has team memberships
    if (entry.teams.size > 0) {
      const timeoutId = setTimeout(() => {
        const disc = this.disconnected.get(fullName);
        if (disc) {
          this.onTimeoutCleanup?.(fullName, disc.teams);
          this.disconnected.delete(fullName);
        }
      }, this.disconnectTimeoutMs);

      // Allow the timer to not block process exit in tests
      if (timeoutId && typeof timeoutId === "object" && "unref" in timeoutId) {
        timeoutId.unref();
      }

      this.disconnected.set(fullName, {
        fullName,
        teams: new Set(entry.teams),
        disconnectedAt: new Date(),
        timeoutId,
      });
    }
  }

  resolve(
    name: string,
  ): { ok: true; entry: AgentEntry } | { ok: false; error: string } {
    const hasColon = name.includes(":");
    const hasAt = name.includes("@");

    // Level 1: full name exact match (contains both : and @)
    if (hasColon && hasAt) {
      const entry = this.agents.get(name);
      if (!entry) {
        return { ok: false, error: `Agent '${name}' is not online.` };
      }
      return { ok: true, entry };
    }

    if (hasColon && !hasAt) {
      const [session, user] = name.split(":");
      return this.resolveMatches(
        name,
        this.filterAgents((e) => e.shortName === session && e.user === user),
      );
    }

    if (!hasColon && hasAt) {
      const [user, host] = name.split("@");
      return this.resolveMatches(
        name,
        this.filterAgents((e) => e.user === user && e.host === host),
      );
    }

    // Plain string: single pass collecting session, user, and host matches
    // with priority order (session > user > host)
    const bySession: AgentEntry[] = [];
    const byUser: AgentEntry[] = [];
    const byHost: AgentEntry[] = [];
    for (const entry of this.agents.values()) {
      if (entry.shortName === name) bySession.push(entry);
      else if (entry.user === name) byUser.push(entry);
      else if (entry.host === name) byHost.push(entry);
    }

    const matches =
      bySession.length > 0 ? bySession : byUser.length > 0 ? byUser : byHost;
    return this.resolveMatches(name, matches);
  }

  private filterAgents(
    predicate: (entry: AgentEntry) => boolean,
  ): AgentEntry[] {
    const result: AgentEntry[] = [];
    for (const entry of this.agents.values()) {
      if (predicate(entry)) result.push(entry);
    }
    return result;
  }

  private resolveMatches(
    name: string,
    matches: AgentEntry[],
  ): { ok: true; entry: AgentEntry } | { ok: false; error: string } {
    if (matches.length === 0) {
      return { ok: false, error: `Agent '${name}' is not online.` };
    }
    if (matches.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: length check guarantees index 0 exists
      return { ok: true, entry: matches[0]! };
    }
    return this.ambiguousError(name, matches);
  }

  private ambiguousError(
    name: string,
    matches: AgentEntry[],
  ): { ok: false; error: string } {
    const names = matches.map((e) => e.fullName).join(", ");
    return {
      ok: false,
      error: `Multiple agents match '${name}': ${names}. Use the full name.`,
    };
  }

  getByFullName(fullName: string): AgentEntry | null {
    return this.agents.get(fullName) ?? null;
  }

  list(): AgentInfo[] {
    const result: AgentInfo[] = [];

    for (const entry of this.agents.values()) {
      result.push({
        name: entry.fullName,
        fullName: entry.fullName,
        shortName: entry.shortName,
        user: entry.user,
        host: entry.host,
        status: "online",
        teams: [...entry.teams],
        connectedAt: entry.connectedAt.toISOString(),
      });
    }

    for (const entry of this.disconnected.values()) {
      const { session, user, host } = parseName(entry.fullName);
      result.push({
        name: entry.fullName,
        fullName: entry.fullName,
        shortName: session,
        user,
        host,
        status: "offline",
        teams: [...entry.teams],
        connectedAt: entry.disconnectedAt.toISOString(),
      });
    }

    return result;
  }
}

export function parseName(fullName: string): {
  session: string;
  user: string;
  host: string;
} {
  // Full format: "session:user@host"
  // Legacy/dashboard format: "name@host" (no colon — treated as session with no user)
  const colonIdx = fullName.indexOf(":");
  const atIdx = fullName.indexOf("@");

  if (colonIdx !== -1 && atIdx !== -1 && colonIdx < atIdx) {
    return {
      session: fullName.slice(0, colonIdx),
      user: fullName.slice(colonIdx + 1, atIdx),
      host: fullName.slice(atIdx + 1),
    };
  }

  if (atIdx !== -1) {
    return {
      session: fullName.slice(0, atIdx),
      user: "",
      host: fullName.slice(atIdx + 1),
    };
  }

  return { session: fullName, user: "", host: "" };
}
