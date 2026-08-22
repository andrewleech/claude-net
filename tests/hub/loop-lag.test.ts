import { describe, expect, test } from "bun:test";
import { startLoopLagMonitor } from "@/hub/loop-lag";

/**
 * Drives the monitor by hand: `setInterval` is captured rather than run,
 * and the clock is a variable, so a 90-second stall is expressed without
 * waiting for one.
 */
function harness(opts?: { intervalMs?: number; thresholdMs?: number }) {
  const intervalMs = opts?.intervalMs ?? 500;
  let clock = 1_000_000;
  let tick: (() => void) | null = null;
  let cleared = false;
  const stalls: number[] = [];

  const monitor = startLoopLagMonitor({
    intervalMs,
    ...(opts?.thresholdMs !== undefined
      ? { thresholdMs: opts.thresholdMs }
      : {}),
    onStall: (lagMs) => stalls.push(lagMs),
    now: () => clock,
    setIntervalImpl: ((fn: () => void) => {
      tick = fn;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {
      cleared = true;
    }) as unknown as typeof clearInterval,
  });

  return {
    monitor,
    stalls,
    wasCleared: () => cleared,
    /** Advance the clock by `ms`, then deliver one tick. */
    advanceAndTick(ms: number) {
      clock += ms;
      tick?.();
    },
  };
}

describe("startLoopLagMonitor", () => {
  test("an on-time tick reports nothing", () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.advanceAndTick(500);
    expect(h.stalls).toEqual([]);
    expect(h.monitor.maxLagMs()).toBe(0);
    expect(h.monitor.stallCount()).toBe(0);
  });

  test("ordinary jitter under the threshold is ignored", () => {
    const h = harness({ thresholdMs: 1_000 });
    h.advanceAndTick(500 + 900);
    expect(h.stalls).toEqual([]);
  });

  test("reports the lag when a tick lands late", () => {
    // A 90 s block: the tick was due 500 ms in, arrived 90.5 s in.
    const h = harness();
    h.advanceAndTick(90_500);
    expect(h.stalls).toEqual([90_000]);
    expect(h.monitor.maxLagMs()).toBe(90_000);
    expect(h.monitor.stallCount()).toBe(1);
  });

  test("re-bases after a stall so it is reported once, not forever", () => {
    // Anchoring the next deadline to the missed one would make every
    // later tick look 90 s late.
    const h = harness();
    h.advanceAndTick(90_500);
    for (let i = 0; i < 5; i++) h.advanceAndTick(500);
    expect(h.stalls).toEqual([90_000]);
    expect(h.monitor.stallCount()).toBe(1);
  });

  test("tracks the high-water mark across several stalls", () => {
    const h = harness();
    h.advanceAndTick(3_000); // lag 2500
    h.advanceAndTick(10_500); // lag 10000
    h.advanceAndTick(2_000); // lag 1500
    expect(h.monitor.stallCount()).toBe(3);
    expect(h.monitor.maxLagMs()).toBe(10_000);
  });

  test("stop clears the timer", () => {
    const h = harness();
    h.monitor.stop();
    expect(h.wasCleared()).toBe(true);
  });
});
