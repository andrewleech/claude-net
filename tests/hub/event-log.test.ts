import { describe, expect, test } from "bun:test";
import { EventLog } from "@/hub/event-log";

describe("EventLog", () => {
  describe("push", () => {
    test("records event with ts, name, and data", () => {
      const log = new EventLog(10);
      const before = Date.now();
      log.push("agent.registered", { fullName: "s:u@h" });
      const after = Date.now();

      const [entry] = log.query();
      expect(entry).toBeDefined();
      expect(entry?.event).toBe("agent.registered");
      expect(entry?.data).toEqual({ fullName: "s:u@h" });
      expect(entry?.ts).toBeGreaterThanOrEqual(before);
      expect(entry?.ts).toBeLessThanOrEqual(after);
    });

    test("size reflects number of pushed events", () => {
      const log = new EventLog(10);
      expect(log.size).toBe(0);
      log.push("a", {});
      log.push("b", {});
      expect(log.size).toBe(2);
    });
  });

  describe("capacity overflow (FIFO)", () => {
    test("oldest entry is evicted when capacity is exceeded", () => {
      const log = new EventLog(3);
      log.push("e", { i: 1 });
      log.push("e", { i: 2 });
      log.push("e", { i: 3 });
      log.push("e", { i: 4 });

      const entries = log.query();
      expect(entries.map((e) => e.data.i)).toEqual([2, 3, 4]);
      expect(log.size).toBe(3);
    });

    test("size saturates at capacity", () => {
      const log = new EventLog(2);
      log.push("e", {});
      log.push("e", {});
      log.push("e", {});
      log.push("e", {});
      expect(log.size).toBe(2);
    });

    test("query returns chronological order after wrap", () => {
      const log = new EventLog(3);
      for (let i = 1; i <= 7; i++) log.push("e", { i });
      expect(log.query().map((e) => e.data.i)).toEqual([5, 6, 7]);
    });

    test("rejects non-positive capacity", () => {
      expect(() => new EventLog(0)).toThrow();
      expect(() => new EventLog(-1)).toThrow();
    });
  });

  describe("query filters", () => {
    test("exact event name match", () => {
      const log = new EventLog(10);
      log.push("agent.registered", { fullName: "a" });
      log.push("message.sent", { from: "a" });
      const hits = log.query({ event: "agent.registered" });
      expect(hits.length).toBe(1);
      expect(hits[0]?.event).toBe("agent.registered");
    });

    test("prefix match on category", () => {
      const log = new EventLog(10);
      log.push("agent.registered", {});
      log.push("agent.disconnected", {});
      log.push("message.sent", {});
      const hits = log.query({ event: "agent" });
      expect(hits.length).toBe(2);
      expect(hits.every((h) => h.event.startsWith("agent."))).toBe(true);
    });

    test("prefix does not match unrelated names sharing a string prefix", () => {
      const log = new EventLog(10);
      log.push("agent.registered", {});
      log.push("agentic.something", {});
      // Guard against accidental substring matching — category boundaries
      // are meaningful.
      const hits = log.query({ event: "agent" });
      expect(hits.length).toBe(1);
      expect(hits[0]?.event).toBe("agent.registered");
    });

    test("since filter is exclusive of the given ts", async () => {
      const log = new EventLog(10);
      log.push("e", { i: 1 });
      await new Promise((r) => setTimeout(r, 5));
      const pivot = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      log.push("e", { i: 2 });
      log.push("e", { i: 3 });

      const hits = log.query({ since: pivot });
      expect(hits.map((e) => e.data.i)).toEqual([2, 3]);
    });

    test("limit returns the most recent N matches", () => {
      const log = new EventLog(10);
      for (let i = 1; i <= 5; i++) log.push("e", { i });
      const hits = log.query({ limit: 2 });
      expect(hits.map((e) => e.data.i)).toEqual([4, 5]);
    });

    test("agent filter matches fullName, from, or to", () => {
      const log = new EventLog(10);
      log.push("agent.registered", { fullName: "s1:u1@h1" });
      log.push("message.sent", { from: "s2:u2@h2", to: "s1:u1@h1" });
      log.push("message.sent", { from: "other", to: "other" });

      const byFullName = log.query({ agent: "s1:u1@h1" });
      expect(byFullName.length).toBe(2);

      const byFrom = log.query({ agent: "u2" });
      expect(byFrom.length).toBe(1);
      expect(byFrom[0]?.data.from).toBe("s2:u2@h2");
    });

    test("combined filters AND together", () => {
      const log = new EventLog(10);
      log.push("agent.registered", { fullName: "s1:u1@h1" });
      log.push("message.sent", { from: "s1:u1@h1", to: "other" });
      log.push("message.sent", { from: "other", to: "other" });

      const hits = log.query({ event: "message", agent: "u1" });
      expect(hits.length).toBe(1);
      expect(hits[0]?.event).toBe("message.sent");
    });
  });

  describe("summary", () => {
    test("counts events by name in window", () => {
      const log = new EventLog(10);
      log.push("agent.registered", {});
      log.push("agent.registered", {});
      log.push("message.sent", {});
      const { counts, total } = log.summary(0);
      expect(counts["agent.registered"]).toBe(2);
      expect(counts["message.sent"]).toBe(1);
      expect(total).toBe(3);
    });

    test("excludes events at or before cutoff", async () => {
      const log = new EventLog(10);
      log.push("old", {});
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      log.push("new", {});

      const { counts, total } = log.summary(cutoff);
      expect(counts.old).toBeUndefined();
      expect(counts.new).toBe(1);
      expect(total).toBe(1);
    });

    test("defaults to last hour window when since omitted", () => {
      const log = new EventLog(10);
      log.push("recent", {});
      const { counts, total } = log.summary();
      expect(counts.recent).toBe(1);
      expect(total).toBe(1);
    });
  });

  describe("oldestTs", () => {
    test("returns 0 when empty", () => {
      expect(new EventLog(5).oldestTs()).toBe(0);
    });

    test("tracks the oldest retained event after eviction", () => {
      const log = new EventLog(2);
      log.push("e", { i: 1 });
      log.push("e", { i: 2 });
      const firstOldest = log.oldestTs();
      log.push("e", { i: 3 });
      // Slot holding i=1 was overwritten; oldest retained is now i=2's ts.
      expect(log.oldestTs()).toBeGreaterThanOrEqual(firstOldest);
      expect(log.query()[0]?.data.i).toBe(2);
    });
  });
});
