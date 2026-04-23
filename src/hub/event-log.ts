/**
 * In-memory bounded ring buffer of structured hub events.
 *
 * Scope: runtime observability of agent lifecycle and message routing
 * outcomes. NOT an audit log — contents do not survive hub restart, and
 * entries silently roll off once the buffer fills. See
 * `docs/HUB_OBSERVABILITY_PLAN.md` for the event taxonomy.
 */

export interface HubEvent {
  /** Epoch millis (Date.now()) captured at push time. */
  ts: number;
  /** Dot-separated category, e.g. `agent.registered`, `message.sent`. */
  event: string;
  /** Event-specific payload. Metadata only — never carries message bodies. */
  data: Record<string, unknown>;
}

export interface QueryOptions {
  /**
   * Prefix-match on `event`. `"agent"` matches `agent.registered`,
   * `agent.disconnected`, etc. An exact name also matches itself.
   */
  event?: string;
  /** Include only events with `ts > since` (exclusive). */
  since?: number;
  /** Max entries returned. Defaults to all matching. */
  limit?: number;
  /**
   * Substring match against `data.from`, `data.to`, and `data.fullName`
   * when those are strings. Used to scope a query to a particular agent
   * without callers needing to know which field each event uses.
   */
  agent?: string;
}

const DEFAULT_CAPACITY = 10_000;

export class EventLog {
  private readonly buffer: (HubEvent | null)[];
  private readonly capacityValue: number;
  /** Next write index (oldest slot once buffer is full). */
  private head = 0;
  /** Number of populated slots; saturates at capacity. */
  private countValue = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(
        `EventLog capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.capacityValue = Math.floor(capacity);
    this.buffer = new Array(this.capacityValue).fill(null);
  }

  get capacity(): number {
    return this.capacityValue;
  }

  get size(): number {
    return this.countValue;
  }

  /**
   * Append an event. When the buffer is full the oldest entry is
   * overwritten — FIFO eviction, O(1).
   */
  push(event: string, data: Record<string, unknown>): void {
    const entry: HubEvent = { ts: Date.now(), event, data };
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacityValue;
    if (this.countValue < this.capacityValue) this.countValue++;
  }

  /**
   * Return matching events in chronological order (oldest first).
   * The buffer itself is never exposed — callers get a fresh array.
   */
  query(opts: QueryOptions = {}): HubEvent[] {
    const { event, since, limit, agent } = opts;
    const results: HubEvent[] = [];

    // Walk from the oldest populated slot forward. When not full, oldest
    // is index 0; when full, oldest is `head` (the next-write slot).
    const start = this.countValue < this.capacityValue ? 0 : this.head;
    for (let i = 0; i < this.countValue; i++) {
      const idx = (start + i) % this.capacityValue;
      const entry = this.buffer[idx];
      if (!entry) continue;
      if (event !== undefined && !matchesEventPrefix(entry.event, event)) {
        continue;
      }
      if (since !== undefined && entry.ts <= since) continue;
      if (agent !== undefined && !matchesAgent(entry, agent)) continue;
      results.push(entry);
    }

    if (limit !== undefined && limit >= 0 && results.length > limit) {
      // Prefer the most recent matches when a limit trims the result.
      return results.slice(results.length - limit);
    }
    return results;
  }

  /**
   * Count events by event-name in the time window `(since, now]`.
   * `since` defaults to one hour ago.
   */
  summary(since?: number): { counts: Record<string, number>; total: number } {
    const cutoff = since ?? Date.now() - 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    let total = 0;

    const start = this.countValue < this.capacityValue ? 0 : this.head;
    for (let i = 0; i < this.countValue; i++) {
      const idx = (start + i) % this.capacityValue;
      const entry = this.buffer[idx];
      if (!entry) continue;
      if (entry.ts <= cutoff) continue;
      counts[entry.event] = (counts[entry.event] ?? 0) + 1;
      total++;
    }

    return { counts, total };
  }

  /** Timestamp of the oldest retained event, or 0 if empty. */
  oldestTs(): number {
    if (this.countValue === 0) return 0;
    const start = this.countValue < this.capacityValue ? 0 : this.head;
    return this.buffer[start]?.ts ?? 0;
  }
}

function matchesEventPrefix(eventName: string, query: string): boolean {
  if (eventName === query) return true;
  // Category match: `agent` should hit `agent.registered` but NOT `agentic`.
  // Require a dot boundary so unrelated names sharing a prefix don't leak.
  return eventName.startsWith(`${query}.`);
}

function matchesAgent(entry: HubEvent, agent: string): boolean {
  const fields = ["fullName", "from", "to"] as const;
  for (const field of fields) {
    const value = entry.data[field];
    if (typeof value === "string" && value.includes(agent)) return true;
  }
  return false;
}
