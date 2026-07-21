import { describe, expect, test } from "bun:test";
import { markUuidSeen } from "@/mirror-agent/agent";

describe("markUuidSeen", () => {
  test("dedup set stays bounded and keeps the most recent uuids", () => {
    const seen = new Set<string>();
    // Push well past the cap; the set must not grow without bound.
    const N = 25_000;
    for (let i = 0; i < N; i++) markUuidSeen(seen, `u-${i}`);

    // Bounded below the total inserted (cap is 20k, evicts in bulk over it).
    expect(seen.size).toBeLessThanOrEqual(20_000);
    expect(seen.size).toBeGreaterThan(0);

    // The most-recent uuid is retained (dedup still works for recent items).
    expect(seen.has(`u-${N - 1}`)).toBe(true);
    // The very oldest has been evicted.
    expect(seen.has("u-0")).toBe(false);
  });

  test("re-adding an existing uuid doesn't grow the set", () => {
    const seen = new Set<string>();
    markUuidSeen(seen, "a");
    markUuidSeen(seen, "a");
    markUuidSeen(seen, "b");
    expect(seen.size).toBe(2);
  });
});
