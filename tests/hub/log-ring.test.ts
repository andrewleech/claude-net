import { describe, expect, test } from "bun:test";
import { LogRing, captureProcessOutput } from "@/hub/log-ring";

describe("LogRing line assembly", () => {
  test("reassembles a line split across chunks", () => {
    const ring = new LogRing();
    ring.write("stderr", "[claude-net] half a ");
    ring.write("stderr", "line\n");
    expect(ring.query().map((l) => l.text)).toEqual([
      "[claude-net] half a line",
    ]);
  });

  test("splits a chunk carrying several lines", () => {
    const ring = new LogRing();
    ring.write("stderr", "one\ntwo\nthree\n");
    expect(ring.query().map((l) => l.text)).toEqual(["one", "two", "three"]);
  });

  test("holds an unterminated remainder until flush", () => {
    const ring = new LogRing();
    ring.write("stdout", "no newline yet");
    expect(ring.size).toBe(0);
    ring.flush();
    expect(ring.query().map((l) => l.text)).toEqual(["no newline yet"]);
  });

  test("flush is idempotent", () => {
    const ring = new LogRing();
    ring.write("stdout", "x");
    ring.flush();
    ring.flush();
    expect(ring.size).toBe(1);
  });

  test("strips CR and drops blank lines", () => {
    const ring = new LogRing();
    ring.write("stderr", "crlf line\r\n\n\nafter blanks\n");
    expect(ring.query().map((l) => l.text)).toEqual([
      "crlf line",
      "after blanks",
    ]);
  });

  test("tags the originating stream", () => {
    const ring = new LogRing();
    ring.write("stdout", "out\n");
    ring.write("stderr", "err\n");
    expect(ring.query({ stream: "stderr" }).map((l) => l.text)).toEqual([
      "err",
    ]);
    expect(ring.query({ stream: "stdout" }).map((l) => l.text)).toEqual([
      "out",
    ]);
  });

  test("interleaved streams keep separate partials", () => {
    // stdout and stderr are independent fds; a half-written stderr line
    // must not absorb a stdout write that lands between its chunks.
    const ring = new LogRing();
    ring.write("stderr", "err part ");
    ring.write("stdout", "whole out\n");
    ring.write("stderr", "two\n");
    expect(ring.query({ stream: "stderr" }).map((l) => l.text)).toEqual([
      "err part two",
    ]);
    expect(ring.query({ stream: "stdout" }).map((l) => l.text)).toEqual([
      "whole out",
    ]);
  });

  test("truncates a single oversized line rather than retaining it whole", () => {
    const ring = new LogRing();
    ring.write("stderr", `${"x".repeat(50_000)}\n`);
    const line = ring.query()[0];
    expect(line?.text.length).toBe(8 * 1024);
  });

  test("flushes an unterminated write once it passes the partial cap", () => {
    // A writer that never emits a newline must not grow the partial
    // without bound.
    const ring = new LogRing();
    ring.write("stderr", "y".repeat(20_000));
    expect(ring.size).toBe(1);
  });
});

describe("LogRing bounds", () => {
  test("evicts oldest first and counts the drops", () => {
    const ring = new LogRing(3);
    for (const t of ["a", "b", "c", "d", "e"]) ring.write("stderr", `${t}\n`);
    expect(ring.query().map((l) => l.text)).toEqual(["c", "d", "e"]);
    expect(ring.size).toBe(3);
    expect(ring.dropped).toBe(2);
  });

  test("honours the byte ceiling ahead of the line count", () => {
    // 10 slots but only ~2 KB of budget: the line count never fills.
    const ring = new LogRing(10, 2_000);
    for (let i = 0; i < 10; i++) ring.write("stderr", `${"z".repeat(500)}\n`);
    expect(ring.size).toBeLessThanOrEqual(4);
    expect(ring.dropped).toBeGreaterThan(0);
    // Whatever survives is the most recent.
    expect(ring.query().length).toBe(ring.size);
  });

  test("rejects a nonsense capacity", () => {
    expect(() => new LogRing(0)).toThrow();
    expect(() => new LogRing(Number.NaN)).toThrow();
  });
});

describe("LogRing query", () => {
  test("since is exclusive and limit keeps the newest", () => {
    const ring = new LogRing();
    ring.write("stderr", "old\n");
    const cut = ring.query()[0]?.ts ?? 0;
    ring.write("stderr", "new1\n");
    ring.write("stderr", "new2\n");
    const after = ring.query({ since: cut }).map((l) => l.text);
    expect(after).not.toContain("old");
    expect(ring.query({ limit: 1 }).map((l) => l.text)).toEqual(["new2"]);
  });

  test("returns a fresh array, never the buffer", () => {
    const ring = new LogRing();
    ring.write("stderr", "a\n");
    const first = ring.query();
    first.length = 0;
    expect(ring.query()).toHaveLength(1);
  });
});

describe("captureProcessOutput", () => {
  test("tees stderr into the ring and still writes through", () => {
    const ring = new LogRing();
    const seen: string[] = [];
    const realWrite = process.stderr.write;
    // Stand in for the terminal so the assertion doesn't depend on it.
    process.stderr.write = ((chunk: string | Uint8Array) => {
      seen.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;

    const release = captureProcessOutput(ring);
    try {
      process.stderr.write("captured line\n");
    } finally {
      release();
      process.stderr.write = realWrite;
    }

    expect(ring.query().map((l) => l.text)).toEqual(["captured line"]);
    expect(seen).toEqual(["captured line\n"]);
  });

  test("release restores the original writer", () => {
    const ring = new LogRing();
    const before = process.stderr.write;
    const release = captureProcessOutput(ring);
    expect(process.stderr.write).not.toBe(before);
    release();
    expect(process.stderr.write).toBe(before);
  });

  test("captures console.log, which bypasses process.stdout.write in Bun", () => {
    // Patching the stream alone misses every console.* call under Bun —
    // they write to the fd directly. Without this the most idiomatic way
    // to add a diagnostic would be invisible in the ring.
    const ring = new LogRing();
    const release = captureProcessOutput(ring);
    try {
      console.log("banner %s and %d", "text", 42);
      console.error("a failure");
    } finally {
      release();
    }
    const lines = ring.query();
    expect(lines.map((l) => l.text)).toContain("banner text and 42");
    const err = lines.find((l) => l.text === "a failure");
    expect(err?.stream).toBe("stderr");
  });

  test("restores the console methods on release", () => {
    const ring = new LogRing();
    const before = console.log;
    const release = captureProcessOutput(ring);
    expect(console.log).not.toBe(before);
    release();
    expect(console.log).toBe(before);
  });

  test("accepts Buffer chunks", () => {
    const ring = new LogRing();
    const realWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const release = captureProcessOutput(ring);
    try {
      process.stderr.write(Buffer.from("from a buffer\n", "utf8"));
    } finally {
      release();
      process.stderr.write = realWrite;
    }
    expect(ring.query().map((l) => l.text)).toEqual(["from a buffer"]);
  });
});
