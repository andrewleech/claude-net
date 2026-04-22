import { describe, expect, test } from "bun:test";
import { RateLimiter } from "@/hub/rate-limit";

describe("RateLimiter", () => {
  test("allows up to max within the window", () => {
    const t = 0;
    const r = new RateLimiter({ max: 3, windowMs: 1000, now: () => t });
    expect(r.allow("k")).toBe(true);
    expect(r.allow("k")).toBe(true);
    expect(r.allow("k")).toBe(true);
    expect(r.allow("k")).toBe(false);
  });

  test("rolls over after the window", () => {
    let t = 0;
    const r = new RateLimiter({ max: 2, windowMs: 1000, now: () => t });
    expect(r.allow("k")).toBe(true);
    expect(r.allow("k")).toBe(true);
    expect(r.allow("k")).toBe(false);
    t = 1500;
    expect(r.allow("k")).toBe(true);
  });

  test("separate keys have independent buckets", () => {
    const r = new RateLimiter({ max: 1, windowMs: 1000 });
    expect(r.allow("a")).toBe(true);
    expect(r.allow("b")).toBe(true);
    expect(r.allow("a")).toBe(false);
    expect(r.allow("b")).toBe(false);
  });

  test("retryAfterMs reports remaining wait", () => {
    let t = 0;
    const r = new RateLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(r.allow("k")).toBe(true);
    expect(r.retryAfterMs("k")).toBe(1000);
    t = 400;
    expect(r.retryAfterMs("k")).toBe(600);
    t = 1500;
    expect(r.retryAfterMs("k")).toBe(0);
  });
});
