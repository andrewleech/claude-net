import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readHistoryBefore } from "@/mirror-agent/jsonl-history";

describe("readHistoryBefore", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `mirror-history-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  function write(records: unknown[]): void {
    fs.writeFileSync(
      tmpFile,
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
  }

  function ts(iso: string): string {
    return new Date(iso).toISOString();
  }

  test("returns last N records when beforeTs is null", async () => {
    write([
      { uuid: "a", timestamp: ts("2026-04-01T00:00:00Z") },
      { uuid: "b", timestamp: ts("2026-04-01T00:00:01Z") },
      { uuid: "c", timestamp: ts("2026-04-01T00:00:02Z") },
      { uuid: "d", timestamp: ts("2026-04-01T00:00:03Z") },
      { uuid: "e", timestamp: ts("2026-04-01T00:00:04Z") },
    ]);
    const r = await readHistoryBefore(tmpFile, null, 3);
    expect(r.records.map((rec) => rec.uuid)).toEqual(["c", "d", "e"]);
    expect(r.exhausted).toBe(false);
  });

  test("returns records strictly older than beforeTs", async () => {
    write([
      { uuid: "a", timestamp: ts("2026-04-01T00:00:00Z") },
      { uuid: "b", timestamp: ts("2026-04-01T00:00:01Z") },
      { uuid: "c", timestamp: ts("2026-04-01T00:00:02Z") },
      { uuid: "d", timestamp: ts("2026-04-01T00:00:03Z") },
      { uuid: "e", timestamp: ts("2026-04-01T00:00:04Z") },
    ]);
    const cutoff = Date.parse("2026-04-01T00:00:03Z");
    const r = await readHistoryBefore(tmpFile, cutoff, 5);
    // d is AT the cutoff so excluded; a, b, c are strictly older.
    expect(r.records.map((rec) => rec.uuid)).toEqual(["a", "b", "c"]);
    expect(r.exhausted).toBe(true);
  });

  test("respects the limit when more records precede the cutoff", async () => {
    write([
      { uuid: "a", timestamp: ts("2026-04-01T00:00:00Z") },
      { uuid: "b", timestamp: ts("2026-04-01T00:00:01Z") },
      { uuid: "c", timestamp: ts("2026-04-01T00:00:02Z") },
      { uuid: "d", timestamp: ts("2026-04-01T00:00:03Z") },
      { uuid: "e", timestamp: ts("2026-04-01T00:00:04Z") },
    ]);
    const cutoff = Date.parse("2026-04-01T00:00:04Z");
    const r = await readHistoryBefore(tmpFile, cutoff, 2);
    // Limit 2 keeps the two most recent records older than cutoff.
    expect(r.records.map((rec) => rec.uuid)).toEqual(["c", "d"]);
    expect(r.exhausted).toBe(false);
  });

  test("cutoff after every record returns the tail", async () => {
    write([
      { uuid: "a", timestamp: ts("2026-04-01T00:00:00Z") },
      { uuid: "b", timestamp: ts("2026-04-01T00:00:01Z") },
    ]);
    const cutoff = Date.parse("2030-01-01T00:00:00Z");
    const r = await readHistoryBefore(tmpFile, cutoff, 5);
    expect(r.records.map((rec) => rec.uuid)).toEqual(["a", "b"]);
    expect(r.exhausted).toBe(true);
  });

  test("cutoff before every record returns empty", async () => {
    write([
      { uuid: "a", timestamp: ts("2026-04-01T00:00:00Z") },
      { uuid: "b", timestamp: ts("2026-04-01T00:00:01Z") },
    ]);
    const cutoff = Date.parse("2020-01-01T00:00:00Z");
    const r = await readHistoryBefore(tmpFile, cutoff, 5);
    expect(r.records).toEqual([]);
    expect(r.exhausted).toBe(true);
  });

  test("missing file returns empty", async () => {
    const r = await readHistoryBefore(`${tmpFile}.does-not-exist`, null, 10);
    expect(r.records).toEqual([]);
    expect(r.exhausted).toBe(true);
  });

  test("malformed lines are skipped", async () => {
    fs.writeFileSync(
      tmpFile,
      `${JSON.stringify({ uuid: "a", timestamp: ts("2026-04-01T00:00:00Z") })}\nnot json\n${JSON.stringify({ uuid: "b", timestamp: ts("2026-04-01T00:00:01Z") })}\n`,
    );
    const r = await readHistoryBefore(tmpFile, null, 5);
    expect(r.records.map((rec) => rec.uuid)).toEqual(["a", "b"]);
  });

  test("limit 0 is rejected gracefully", async () => {
    write([{ uuid: "a", timestamp: ts("2026-04-01T00:00:00Z") }]);
    const r = await readHistoryBefore(tmpFile, null, 0);
    expect(r.records).toEqual([]);
    expect(r.exhausted).toBe(true);
  });

  test("ring stays bounded for large files", async () => {
    const records: { uuid: string; timestamp: string }[] = [];
    const base = Date.parse("2026-04-01T00:00:00Z");
    for (let i = 0; i < 5000; i++) {
      records.push({
        uuid: `u${i}`,
        timestamp: new Date(base + i * 1000).toISOString(),
      });
    }
    write(records);
    // Cutoff at the 4900th record; we want the 50 records preceding it.
    const cutoff = base + 4900 * 1000;
    const r = await readHistoryBefore(tmpFile, cutoff, 50);
    expect(r.records.length).toBe(50);
    expect(r.records[0]?.uuid).toBe("u4850");
    expect(r.records[49]?.uuid).toBe("u4899");
    expect(r.exhausted).toBe(false);
  });
});
