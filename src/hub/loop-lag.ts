/**
 * Event-loop lag detector.
 *
 * A blocked event loop is the failure mode that leaves no trace: the hub
 * keeps its listening socket, completes TLS (handled off the JS loop),
 * holds a normal RSS and a near-idle CPU, and answers nothing. Ping ticks
 * stop, so every agent ages out and reconnects at once — which looks like
 * a network event rather than a stalled process. Observed twice on a
 * production hub for 1-2 minutes each, self-recovering, with no logged
 * cause.
 *
 * A timer that measures its own lateness turns that into one timestamped
 * line naming the duration. Cheap enough to leave on always: one timer,
 * two numbers per tick.
 */

/** Tick period. Short enough to bound the error on a reported stall. */
const DEFAULT_INTERVAL_MS = 500;
/**
 * Report only when a tick is at least this late. Well clear of ordinary
 * scheduling jitter and GC pauses, so a quiet hub logs nothing at all.
 */
const DEFAULT_THRESHOLD_MS = 1_000;

export interface LoopLagMonitor {
  /** Largest lag seen so far, in ms. 0 until the first stall. */
  maxLagMs(): number;
  /** Number of stalls that crossed the threshold. */
  stallCount(): number;
  stop(): void;
}

export interface LoopLagOptions {
  intervalMs?: number;
  thresholdMs?: number;
  /** Called once per stall, with how late the tick was. */
  onStall: (lagMs: number) => void;
  /** Injectable for tests. */
  now?: () => number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

/**
 * Start measuring event-loop lag. The monitor compares each tick's actual
 * arrival against when it was due; the difference is time the loop was
 * unavailable to run it.
 */
export function startLoopLagMonitor(opts: LoopLagOptions): LoopLagMonitor {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const now = opts.now ?? Date.now;
  const setIntervalFn = opts.setIntervalImpl ?? setInterval;
  const clearIntervalFn = opts.clearIntervalImpl ?? clearInterval;

  let expectedAt = now() + intervalMs;
  let maxLag = 0;
  let stalls = 0;

  const timer = setIntervalFn(() => {
    const t = now();
    const lag = t - expectedAt;
    // Re-base off the actual arrival, not the missed deadline: after a
    // 90 s stall the next tick is due 500 ms from now, and anchoring to
    // the stale deadline would report the same stall repeatedly.
    expectedAt = t + intervalMs;
    if (lag < thresholdMs) return;
    if (lag > maxLag) maxLag = lag;
    stalls++;
    opts.onStall(lag);
  }, intervalMs);

  // Never hold the process open on account of instrumentation.
  if (timer && typeof timer === "object" && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  return {
    maxLagMs: () => maxLag,
    stallCount: () => stalls,
    stop: () => clearIntervalFn(timer),
  };
}
