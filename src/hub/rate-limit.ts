// Small token-bucket rate limiter keyed by arbitrary string (typically
// sid + ip). Used by the mirror endpoints; exposed so tests can inject a
// controlled clock and other future endpoints can reuse it.

export interface RateLimiterOptions {
  /** Max events permitted per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export class RateLimiter {
  private max: number;
  private windowMs: number;
  private now: () => number;
  private hits = new Map<string, number[]>();
  private lastSweepAt = 0;

  constructor(opts: RateLimiterOptions) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Return true if the call is allowed (and record it). Returns false when
   * the caller is over the quota.
   */
  allow(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const arr = this.hits.get(key) ?? [];
    // Drop stale entries (amortized O(n) per key).
    let first = 0;
    while (first < arr.length && (arr[first] ?? 0) < cutoff) first++;
    if (first > 0) arr.splice(0, first);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);

    // Periodic background sweep to reclaim memory from dead keys.
    if (t - this.lastSweepAt > this.windowMs * 10) {
      this.lastSweepAt = t;
      for (const [k, v] of this.hits) {
        if (v.length === 0) this.hits.delete(k);
      }
    }

    return true;
  }

  /**
   * Number of milliseconds until the caller can try again. 0 if already
   * allowed. Useful for Retry-After headers.
   */
  retryAfterMs(key: string): number {
    const arr = this.hits.get(key);
    if (!arr || arr.length < this.max) return 0;
    const oldest = arr[0] ?? 0;
    const ready = oldest + this.windowMs;
    return Math.max(0, ready - this.now());
  }

  /** Test helper: clear all counters. */
  reset(): void {
    this.hits.clear();
    this.lastSweepAt = 0;
  }
}
