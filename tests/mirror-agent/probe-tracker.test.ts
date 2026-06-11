import { describe, expect, test } from "bun:test";
import { ProbeAttemptTracker } from "@/mirror-agent/probe-tracker";

describe("ProbeAttemptTracker", () => {
  test("first probe for a ccPid is not skipped", () => {
    const t = new ProbeAttemptTracker();
    expect(t.shouldSkip(123)).toBe(false);
  });

  test("in-flight probe blocks concurrent probe for same ccPid", () => {
    const t = new ProbeAttemptTracker();
    t.begin(123);
    expect(t.shouldSkip(123)).toBe(true);
  });

  test("different ccPids are tracked independently", () => {
    const t = new ProbeAttemptTracker();
    t.begin(123);
    expect(t.shouldSkip(456)).toBe(false);
  });

  test("succeeded() clears the record so a later probe can begin again", () => {
    const t = new ProbeAttemptTracker();
    t.begin(123);
    t.succeeded(123);
    expect(t.shouldSkip(123)).toBe(false);
    expect(t.size()).toBe(0);
  });

  test("failed() applies a cooldown for subsequent probes", () => {
    let now = 1_000;
    const t = new ProbeAttemptTracker(
      30_000,
      () => now,
      () => "sid-stub",
    );
    t.begin(123);
    t.failed(123);

    // Inside cooldown window — skip.
    now = 1_000 + 29_000;
    expect(t.shouldSkip(123)).toBe(true);

    // Past cooldown — allow.
    now = 1_000 + 31_000;
    expect(t.shouldSkip(123)).toBe(false);
  });

  test("retry after failure reuses the same sid (idempotent against hub dedup)", () => {
    let now = 1_000;
    let counter = 0;
    const t = new ProbeAttemptTracker(
      30_000,
      () => now,
      () => `sid-${++counter}`,
    );
    const sid1 = t.begin(123);
    t.failed(123);

    now = 1_000 + 31_000;
    const sid2 = t.begin(123);
    expect(sid2).toBe(sid1);
    expect(counter).toBe(1); // genSid was called only once
  });

  test("a fresh probe for a different ccPid still mints a new sid", () => {
    let counter = 0;
    const t = new ProbeAttemptTracker(
      30_000,
      () => 0,
      () => `sid-${++counter}`,
    );
    const sid1 = t.begin(123);
    const sid2 = t.begin(456);
    expect(sid1).toBe("sid-1");
    expect(sid2).toBe("sid-2");
  });

  test("succeeded() on an unknown ccPid is a no-op", () => {
    const t = new ProbeAttemptTracker();
    expect(() => t.succeeded(999)).not.toThrow();
  });

  test("preassigned sid wins over the fresh-UUID fallback on first begin", () => {
    let counter = 0;
    const t = new ProbeAttemptTracker(
      30_000,
      () => 0,
      () => `sid-${++counter}`,
    );
    const sid = t.begin(123, "real-session-id");
    expect(sid).toBe("real-session-id");
    expect(counter).toBe(0); // genSid was never called
  });

  test("cached sid from a prior begin wins over a later preassignment", () => {
    let counter = 0;
    let now = 0;
    const t = new ProbeAttemptTracker(
      30_000,
      () => now,
      () => `sid-${++counter}`,
    );
    // First probe lays down a cached sid (the fresh-UUID one).
    const sid1 = t.begin(123);
    expect(sid1).toBe("sid-1");
    t.failed(123);
    // Later retry passes a preassigned sid, but the cached one wins so
    // the retry stays idempotent against the hub's by-sid dedup.
    now = 31_000;
    const sid2 = t.begin(123, "different-real-id");
    expect(sid2).toBe("sid-1");
  });

  test("failed() on an unknown ccPid is a no-op (no record created)", () => {
    const t = new ProbeAttemptTracker();
    t.failed(999);
    expect(t.shouldSkip(999)).toBe(false);
    expect(t.size()).toBe(0);
  });

  test("succeeded() after begin() with no failure removes the record", () => {
    const t = new ProbeAttemptTracker();
    t.begin(123);
    t.succeeded(123);
    expect(t.size()).toBe(0);
  });
});
