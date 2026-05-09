// Per-ccPid bookkeeping for `host_session_probe` retries.
//
// The hub re-sends `host_session_probe` for every Claude Code process
// it knows about whenever the mirror-agent's WS reconnects (and again
// when each plugin re-registers). Without bookkeeping, every reconnect
// burst minted a fresh sid per ccPid and POSTed it to /api/mirror/session
// — the hub's per-host rate limiter then 429'd everything but the first
// few, and the next reconnect would mint a fresh sid again. The result
// in the log was an endless `creating session for ccPid=… sid=<random>`
// / `429 Rate limit` ping-pong that never terminated.
//
// This tracker fixes both halves of the loop:
//   - Reuses the same sid across retries so the POST is idempotent
//     (the hub's createSession dedupes by sid).
//   - Adds a per-ccPid cooldown after a failure so reconnect storms
//     don't immediately retry the same probe.
//
// The tracker is intentionally small and synchronous; the agent owns
// the actual openSession call. `now` is injected so tests can drive
// the cooldown without setTimeout/clock skew.
import crypto from "node:crypto";

interface ProbeRecord {
  sid: string;
  pending: boolean;
  /** ms-since-epoch of the last failure; 0 when no failure recorded. */
  lastFailureAt: number;
}

export class ProbeAttemptTracker {
  private readonly attempts = new Map<number, ProbeRecord>();

  constructor(
    private readonly cooldownMs: number = 30_000,
    private readonly now: () => number = Date.now,
    private readonly genSid: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * True if a probe for this ccPid is in-flight, or if the most recent
   * attempt failed less than `cooldownMs` ago.
   */
  shouldSkip(ccPid: number): boolean {
    const r = this.attempts.get(ccPid);
    if (!r) return false;
    if (r.pending) return true;
    if (r.lastFailureAt === 0) return false;
    return this.now() - r.lastFailureAt < this.cooldownMs;
  }

  /**
   * Mark a probe as in-flight and return the sid to use. Reuses the
   * cached sid if a prior attempt for this ccPid failed, so the retry
   * is idempotent against the hub's by-sid dedup.
   */
  begin(ccPid: number): string {
    const existing = this.attempts.get(ccPid);
    const sid = existing?.sid ?? this.genSid();
    this.attempts.set(ccPid, {
      sid,
      pending: true,
      lastFailureAt: existing?.lastFailureAt ?? 0,
    });
    return sid;
  }

  /** Probe completed successfully — drop the record so future probes
   *  (e.g., after the session closes) start fresh. */
  succeeded(ccPid: number): void {
    this.attempts.delete(ccPid);
  }

  /** Probe failed — keep the sid for retry, stamp the failure time so
   *  the cooldown applies. */
  failed(ccPid: number): void {
    const r = this.attempts.get(ccPid);
    if (!r) return;
    r.pending = false;
    r.lastFailureAt = this.now();
  }

  /** Test/diagnostic helper. */
  size(): number {
    return this.attempts.size;
  }
}
