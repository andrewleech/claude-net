import type { AgentInfo } from "@/shared/types";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// Mirrors Mailbox's DEFAULT_CAPACITY (mailbox.ts) — same bounding
// rationale, same FIFO-by-recency eviction, so seenNames can't grow
// unboundedly either.
const SEEN_NAMES_CAPACITY = 5_000;

// Cap on how many online intervals `onlineIntervals` retains per
// fullName — bounds memory for a name that connects/disconnects
// repeatedly. Only recency matters for the overlap check below, so the
// oldest interval is dropped first.
const MAX_INTERVALS_PER_NAME = 8;

/**
 * One span during which a fullName had a live `AgentEntry`, ordered by a
 * logical sequence number rather than wall-clock time — two register()
 * calls in the same process tick can carry the identical `Date.now()`
 * millisecond, which would make genuinely concurrent intervals look
 * like they never overlapped. `end` is `null` while still online.
 */
interface OnlineInterval {
  start: number;
  end: number | null;
}

/** True if any interval in `a` overlaps any interval in `b`, treating an
 * open (`end: null`) interval as running through `now`. Used to tell
 * "the same identity, seen sequentially under different names" (no
 * overlap) apart from "two distinct identities that happened to both be
 * online at once" (overlap) when a partial-address query matches more
 * than one seenName. */
function intervalsOverlap(
  a: readonly OnlineInterval[],
  b: readonly OnlineInterval[],
  now: number,
): boolean {
  for (const ia of a) {
    const iaEnd = ia.end ?? now;
    for (const ib of b) {
      const ibEnd = ib.end ?? now;
      if (ia.start < ibEnd && ib.start < iaEnd) return true;
    }
  }
  return false;
}

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
  /**
   * Claude Code PID announced by the plugin on register. null if the
   * plugin didn't send `cc_pid` (pre-rollout client). Paired with `host`
   * in `findByHostPid` to drive the mirror-session rename join.
   */
  ccPid: number | null;
  /**
   * Working directory of the Claude Code process at register time.
   * null if the plugin didn't send `cwd` (pre-rollout client). Used
   * to probe the mirror-agent daemon when no mirror session exists.
   */
  cwd: string | null;
}

export interface DisconnectedEntry {
  fullName: string;
  teams: Set<string>;
  disconnectedAt: Date;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface RegistryOptions {
  disconnectTimeoutMs?: number;
  /** Override for tests — production always uses SEEN_NAMES_CAPACITY. */
  seenNamesCapacity?: number;
}

export class Registry {
  readonly agents = new Map<string, AgentEntry>();
  readonly disconnected = new Map<string, DisconnectedEntry>();
  /**
   * Every fullName that has completed register(), bounded to the most
   * recent `SEEN_NAMES_CAPACITY` (FIFO-by-recency, mirroring Mailbox) so
   * it can't grow forever — unlike `disconnected`, membership here
   * doesn't require team membership. Backs `resolveSeenNameOrAmbiguous`,
   * which gates whether an offline send still deposits a mailbox entry:
   * "identity known to the hub" means "registered at some point (and
   * not since evicted)", not "currently online" or "was on a team when
   * it dropped". A rename removes the old name here — see `register`.
   */
  readonly seenNames = new Set<string>();
  /**
   * Per-fullName history of live-registration spans, keyed and evicted
   * in lockstep with `seenNames`. Backs `resolveSeenNameOrAmbiguous`'s
   * overlap check: two seenNames matching the same partial address are
   * only collapsed to "the same identity, renamed/reconnected over
   * time" when their intervals never overlapped — if both were online
   * at once, they're distinct agents and must be reported ambiguous.
   */
  private readonly onlineIntervals = new Map<string, OnlineInterval[]>();
  /** Monotonic counter stamped onto interval start/end instead of
   * `Date.now()` — see `OnlineInterval`. */
  private intervalSeq = 0;
  private disconnectTimeoutMs: number;
  private seenNamesCapacity: number;
  private onTimeoutCleanup?: (fullName: string, teams: Set<string>) => void;

  constructor(options?: RegistryOptions) {
    this.disconnectTimeoutMs = options?.disconnectTimeoutMs ?? TWO_HOURS_MS;
    this.seenNamesCapacity = options?.seenNamesCapacity ?? SEEN_NAMES_CAPACITY;
  }

  /** Record `fullName` as seen, refreshing its recency and evicting the
   * oldest entry once over capacity. */
  private touchSeenName(fullName: string): void {
    this.seenNames.delete(fullName);
    this.seenNames.add(fullName);
    if (this.seenNames.size > this.seenNamesCapacity) {
      const oldest = this.seenNames.keys().next().value;
      if (oldest !== undefined) {
        this.seenNames.delete(oldest);
        this.onlineIntervals.delete(oldest);
      }
    }
  }

  /** Open a new online interval for `fullName`, capping how many this
   * name retains. Called whenever a fresh `AgentEntry` starts backing
   * the name (not on a same-identity re-register, which never went
   * offline). */
  private openInterval(fullName: string): void {
    let intervals = this.onlineIntervals.get(fullName);
    if (!intervals) {
      intervals = [];
      this.onlineIntervals.set(fullName, intervals);
    }
    intervals.push({ start: ++this.intervalSeq, end: null });
    if (intervals.length > MAX_INTERVALS_PER_NAME) intervals.shift();
  }

  /** Close `fullName`'s currently-open online interval, if any. */
  private closeInterval(fullName: string): void {
    const intervals = this.onlineIntervals.get(fullName);
    if (!intervals || intervals.length === 0) return;
    const last = intervals[intervals.length - 1];
    if (last && last.end === null) last.end = ++this.intervalSeq;
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
    options: {
      channelCapable?: boolean;
      ccPid?: number | null;
      cwd?: string | null;
    } = {},
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
    const ccPid = options.ccPid ?? null;
    const cwd = options.cwd ?? null;

    if (!isValidAgentName(fullName)) {
      return {
        ok: false,
        error: `Name '${fullName}' is not in the required session:user@host format (all three parts must be non-empty).`,
      };
    }

    // Detect rename: same wsIdentity, different name. At most one match
    // is possible because register() maintains the invariant. Detection
    // only — no mutation yet. Every rejection path below must run before
    // the renamer's original identity (its `agents` entry and its
    // `seenNames` membership) is touched, so a rejected rename leaves
    // that identity fully intact (still online, still seen).
    let renamedFrom: string | undefined;
    let inheritedTeams: Set<string> | null = null;
    for (const [existingName, entry] of this.agents) {
      if (entry.wsIdentity === identity && existingName !== fullName) {
        renamedFrom = existingName;
        inheritedTeams = new Set(entry.teams);
        break;
      }
    }

    const existing = this.agents.get(fullName);
    if (existing && existing.wsIdentity !== identity) {
      // A different transport already holds this exact name. Distinguish a
      // reconnect of the SAME Claude Code session — which must be allowed
      // to reclaim its name — from a genuine collision with a different
      // session, which must still be rejected so the plugin falls back to
      // a `-N` suffix.
      //
      // Same session ⇔ same Claude Code process. The plugin announces
      // ccPid on every register, and a reconnect on a fresh socket (even
      // when the hub has not yet processed the old socket's close) carries
      // the same ccPid as the stale holder. Reclaim in that case: drop the
      // stale entry and carry its team memberships forward.
      const sameSession = ccPid !== null && existing.ccPid === ccPid;
      if (!sameSession) {
        return {
          ok: false,
          error: `Name '${fullName}' is already registered. Choose a different name.`,
        };
      }
      inheritedTeams = inheritedTeams ?? new Set(existing.teams);
    }

    // Every rejection path has now passed — safe to mutate.
    this.touchSeenName(fullName);
    if (renamedFrom) {
      this.agents.delete(renamedFrom);
      // The old name is dead — drop it from seenNames so it stops
      // shadowing partial-name resolution (and stops matching at all)
      // for an identity that has moved to `fullName`. Its interval
      // history goes with it — a name that can never match again can
      // never contribute to a future overlap check.
      this.seenNames.delete(renamedFrom);
      this.onlineIntervals.delete(renamedFrom);
    }
    if (existing && existing.wsIdentity !== identity) {
      this.agents.delete(fullName);
      // The displaced entry's online interval must be closed here — the
      // stale socket's eventual close will no-op (unregister's identity
      // guard sees a different wsIdentity now owns the name), so this is
      // the only point that can end it. Left open, it would overlap every
      // future registration of this name and make everConcurrent report
      // false concurrency forever.
      this.closeInterval(fullName);
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
      // Refresh ccPid/cwd so a late-arriving identity upgrade (plugin
      // upgraded mid-session, fresh ppid info) flows into findByHostPid
      // without needing a reconnect.
      if (ccPid !== null) existing.ccPid = ccPid;
      if (cwd !== null) existing.cwd = cwd;
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
      ccPid,
      cwd,
    };
    this.agents.set(fullName, entry);
    this.openInterval(fullName);
    return { ok: true, entry, restored, renamedFrom };
  }

  /**
   * Find the connected agent that owns (host, ccPid). Used by
   * MirrorRegistry to resolve the current mirror-session label from a
   * live MCP registration — including immediately after a hub restart,
   * where the plugin has re-announced itself with the same ccPid.
   */
  findByHostPid(host: string, ccPid: number): AgentEntry | null {
    if (!host || !Number.isFinite(ccPid)) return null;
    for (const entry of this.agents.values()) {
      if (entry.host === host && entry.ccPid === ccPid) return entry;
    }
    return null;
  }

  unregister(fullName: string, wsIdentity?: object): void {
    const entry = this.agents.get(fullName);
    if (!entry) return;
    // Identity guard: when a specific transport is unregistering (its
    // socket closed), only act if that transport still owns the name.
    // After a same-session reconnect reclaimed the name on a fresh socket,
    // the old socket's delayed close must not evict the live owner.
    if (wsIdentity !== undefined && entry.wsIdentity !== wsIdentity) return;

    this.agents.delete(fullName);
    this.closeInterval(fullName);

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
  ):
    | { ok: true; entry: AgentEntry }
    | { ok: false; error: string; ambiguous?: true } {
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
  ):
    | { ok: true; entry: AgentEntry }
    | { ok: false; error: string; ambiguous?: true } {
    if (matches.length === 0) {
      return { ok: false, error: `Agent '${name}' is not online.` };
    }
    if (matches.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: length check guarantees index 0 exists
      return { ok: true, entry: matches[0]! };
    }
    return this.ambiguousError(name, matches);
  }

  /**
   * `ambiguous: true` lets a caller distinguish this from "not online" —
   * multiple *live* agents matched, so the fix is "use the full name",
   * not "wait for them to come back" or "check their mailbox".
   */
  private ambiguousError(
    name: string,
    matches: AgentEntry[],
  ): { ok: false; error: string; ambiguous: true } {
    const names = matches.map((e) => e.fullName).join(", ");
    return {
      ok: false,
      ambiguous: true,
      error: `Multiple agents match '${name}': ${names}. Use the full name.`,
    };
  }

  getByFullName(fullName: string): AgentEntry | null {
    return this.agents.get(fullName) ?? null;
  }

  /**
   * Resolve `name` — in any of the addressing forms `resolve()` accepts
   * (full, `session:user`, `user@host`, plain) — against every fullName
   * ever registered this hub's lifetime, online or not. Used to find the
   * canonical mailbox key for an offline recipient addressed by a
   * partial name. Distinguishes "no match" (null) from "ambiguous" (an
   * error) rather than collapsing both into null — used by get_mailbox
   * and routeDirect/routeSystemNotification so an ambiguous partial name
   * surfaces the ambiguity instead of silently reporting an empty
   * mailbox or depositing under a guessed name.
   *
   * A `session:user` or `user@host` query pins two of the three address
   * components, so every match it can produce already shares those two
   * fields. That multiplicity is only safe to collapse to a single
   * canonical name when the matches were never simultaneously online:
   * that pattern is the *same* identity seen under different session
   * names or hosts at different points in the hub's lifetime (a rename
   * lookalike, or the same person's sessions churning one after
   * another), and the most-recently-seen one is the one still worth
   * addressing. If two matches' online intervals ever overlapped,
   * they were live at the same time under different names — genuinely
   * distinct agents (e.g. two concurrent sessions on one host) — and
   * must be reported ambiguous rather than guessed at. A plain
   * single-component query has no such guarantee either way — it can
   * span genuinely unrelated identities — so it always reports
   * ambiguity on multiple matches.
   */
  resolveSeenNameOrAmbiguous(
    name: string,
  ): { fullName: string } | { error: string } | null {
    const matches = matchNames(name, this.seenNames);
    if (matches.length === 1) return { fullName: matches[0] as string };
    if (matches.length > 1) {
      const hasColon = name.includes(":");
      const hasAt = name.includes("@");
      if (hasColon !== hasAt && !this.everConcurrent(matches)) {
        // biome-ignore lint/style/noNonNullAssertion: length check guarantees a last element
        return { fullName: matches[matches.length - 1]! };
      }
      return {
        error: `Multiple agents match '${name}': ${matches.join(", ")}. Use the full name.`,
      };
    }
    return null;
  }

  /** True if any two of `names` were ever online at the same time. */
  private everConcurrent(names: readonly string[]): boolean {
    // Greater than any recorded seq — an open interval (end: null)
    // extends through "now" in sequence terms too.
    const now = this.intervalSeq + 1;
    for (let i = 0; i < names.length; i++) {
      const a = this.onlineIntervals.get(names[i] as string) ?? [];
      for (let j = i + 1; j < names.length; j++) {
        const b = this.onlineIntervals.get(names[j] as string) ?? [];
        if (intervalsOverlap(a, b, now)) return true;
      }
    }
    return false;
  }

  /**
   * Update an agent's channelCapable flag in place — used when the
   * plugin's empirical self-test confirms (or refutes) channel
   * delivery after the initial register has gone through. Returns
   * false if the agent is not registered.
   */
  setChannelCapable(fullName: string, capable: boolean): boolean {
    const entry = this.agents.get(fullName);
    if (!entry) return false;
    entry.channelCapable = capable;
    return true;
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
        cwd: entry.cwd,
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
        cwd: null,
      });
    }

    return result;
  }
}

/**
 * Reject names that don't fit the canonical `session:user@host` format
 * with all three parts non-empty. Used by `register()` to keep the
 * agent namespace structurally clean, and — critically — to reserve
 * identities like `system@claude-net` for the plugin's own startup
 * self-test notification. The LLM's trust in that notification depends
 * on no remote agent being able to register a colliding name.
 */
export function isValidAgentName(fullName: string): boolean {
  if (typeof fullName !== "string") return false;
  const colonIdx = fullName.indexOf(":");
  if (colonIdx <= 0) return false;
  const atIdx = fullName.indexOf("@", colonIdx + 1);
  if (atIdx <= colonIdx + 1) return false;
  if (atIdx >= fullName.length - 1) return false;
  return true;
}

/**
 * Filter `names` down to the ones matching `query` under the same
 * addressing-form rules as `Registry.resolve` (full / session:user /
 * user@host / plain, with plain preferring session > user > host).
 * Used to resolve a partial name against a name set that isn't backed
 * by live AgentEntry objects (e.g. `seenNames`).
 */
function matchNames(query: string, names: ReadonlySet<string>): string[] {
  const hasColon = query.includes(":");
  const hasAt = query.includes("@");

  // Full-name form is the dominant case (every team-member / exact-address
  // lookup uses it) — O(1) Set lookup instead of copying the whole set to
  // an array and scanning it with `.includes`.
  if (hasColon && hasAt) {
    return names.has(query) ? [query] : [];
  }

  const all = [...names];
  if (hasColon && !hasAt) {
    const [session, user] = query.split(":");
    return all.filter((n) => {
      const p = parseName(n);
      return p.session === session && p.user === user;
    });
  }
  if (!hasColon && hasAt) {
    const [user, host] = query.split("@");
    return all.filter((n) => {
      const p = parseName(n);
      return p.user === user && p.host === host;
    });
  }

  const bySession = all.filter((n) => parseName(n).session === query);
  if (bySession.length > 0) return bySession;
  const byUser = all.filter((n) => parseName(n).user === query);
  if (byUser.length > 0) return byUser;
  return all.filter((n) => parseName(n).host === query);
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
