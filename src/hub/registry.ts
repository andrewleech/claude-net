import type { AgentInfo } from "@/shared/types";
import {
  DASHBOARD_AGENT_NAME,
  DASHBOARD_SHORT_NAME,
  hasDashboardClients,
} from "./ws-dashboard";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export interface AgentEntry {
  fullName: string;
  shortName: string;
  host: string;
  ws: { send(data: string): void };
  /** Stable identity reference for WS comparison (e.g. Elysia's ws.raw). */
  wsIdentity: object;
  teams: Set<string>;
  connectedAt: Date;
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
   * @param fullName - Agent name in `name@host` format
   * @param ws - WebSocket-like object with send() method
   * @param wsIdentity - Stable identity reference for same-connection detection.
   *   Defaults to `ws` itself. For Elysia, pass `ws.raw` since the wrapper changes per callback.
   */
  register(
    fullName: string,
    ws: { send(data: string): void },
    wsIdentity?: object,
  ):
    | { ok: true; entry: AgentEntry; restored: boolean }
    | { ok: false; error: string } {
    const identity = wsIdentity ?? ws;
    const existing = this.agents.get(fullName);
    if (existing && existing.wsIdentity !== identity) {
      return {
        ok: false,
        error: `Name '${fullName}' is already registered. Choose a different name.`,
      };
    }

    if (existing && existing.wsIdentity === identity) {
      // Update ws reference (Elysia wrapper may change)
      existing.ws = ws;
      return { ok: true, entry: existing, restored: false };
    }

    const [shortName, host] = parseName(fullName);

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
      shortName,
      host,
      ws,
      wsIdentity: identity,
      teams: restoredTeams,
      connectedAt: new Date(),
    };
    this.agents.set(fullName, entry);
    return { ok: true, entry, restored };
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
    if (name.includes("@")) {
      const entry = this.agents.get(name);
      if (!entry) {
        return { ok: false, error: `Agent '${name}' is not online.` };
      }
      return { ok: true, entry };
    }

    // Short name scan
    const matches: AgentEntry[] = [];
    for (const entry of this.agents.values()) {
      if (entry.shortName === name) {
        matches.push(entry);
      }
    }

    if (matches.length === 0) {
      return { ok: false, error: `Agent '${name}' is not online.` };
    }
    if (matches.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: length check guarantees index 0 exists
      return { ok: true, entry: matches[0]! };
    }
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
        host: entry.host,
        status: "online",
        teams: [...entry.teams],
        connectedAt: entry.connectedAt.toISOString(),
      });
    }

    for (const entry of this.disconnected.values()) {
      const [shortName, host] = parseName(entry.fullName);
      result.push({
        name: entry.fullName,
        fullName: entry.fullName,
        shortName,
        host,
        status: "offline",
        teams: [...entry.teams],
        connectedAt: entry.disconnectedAt.toISOString(),
      });
    }

    // Include dashboard as a virtual agent when clients are connected
    if (hasDashboardClients()) {
      result.push({
        name: DASHBOARD_AGENT_NAME,
        fullName: DASHBOARD_AGENT_NAME,
        shortName: DASHBOARD_SHORT_NAME,
        host: "hub",
        status: "online",
        teams: [],
        connectedAt: new Date().toISOString(),
      });
    }

    return result;
  }
}

function parseName(fullName: string): [shortName: string, host: string] {
  const idx = fullName.indexOf("@");
  if (idx === -1) {
    return [fullName, ""];
  }
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}
