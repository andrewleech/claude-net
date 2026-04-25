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

  test("returns last N records when beforeUuid is null", async () => {
    write([
      { uuid: "a", type: "user" },
      { uuid: "b", type: "assistant" },
      { uuid: "c", type: "user" },
      { uuid: "d", type: "assistant" },
      { uuid: "e", type: "user" },
    ]);
    const r = await readHistoryBefore(tmpFile, null, 3);
    expect(r.records.map((rec) => rec.uuid)).toEqual(["c", "d", "e"]);
    expect(r.exhausted).toBe(false);
    expect(r.anchor_missing).toBe(false);
  });

  test("returns records preceding the anchor uuid", async () => {
    write([
      { uuid: "a", type: "user" },
      { uuid: "b", type: "assistant" },
      { uuid: "c", type: "user" },
      { uuid: "d", type: "assistant" },
      { uuid: "e", type: "user" },
    ]);
    const r = await readHistoryBefore(tmpFile, "d", 5);
    // Anchor "d" excluded; preceding 3 records returned. exhausted=true
    // because we asked for 5 but only had 3 available.
    expect(r.records.map((rec) => rec.uuid)).toEqual(["a", "b", "c"]);
    expect(r.exhausted).toBe(true);
    expect(r.anchor_missing).toBe(false);
  });

  test("respects the limit when more records precede the anchor", async () => {
    write([
      { uuid: "a", type: "user" },
      { uuid: "b", type: "assistant" },
      { uuid: "c", type: "user" },
      { uuid: "d", type: "assistant" },
      { uuid: "e", type: "user" },
    ]);
    const r = await readHistoryBefore(tmpFile, "e", 2);
    expect(r.records.map((rec) => rec.uuid)).toEqual(["c", "d"]);
    expect(r.exhausted).toBe(false);
    expect(r.anchor_missing).toBe(false);
  });

  test("anchor not in file returns anchor_missing", async () => {
    write([
      { uuid: "a", type: "user" },
      { uuid: "b", type: "assistant" },
    ]);
    const r = await readHistoryBefore(tmpFile, "nonexistent", 5);
    expect(r.records).toEqual([]);
    expect(r.anchor_missing).toBe(true);
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
      `${JSON.stringify({ uuid: "a" })}\nnot json\n${JSON.stringify({ uuid: "b" })}\n`,
    );
    const r = await readHistoryBefore(tmpFile, null, 5);
    expect(r.records.map((rec) => rec.uuid)).toEqual(["a", "b"]);
  });

  test("limit 0 is rejected gracefully", async () => {
    write([{ uuid: "a" }]);
    const r = await readHistoryBefore(tmpFile, null, 0);
    expect(r.records).toEqual([]);
    expect(r.exhausted).toBe(true);
  });

  test("ring stays bounded for large files", async () => {
    const records: { uuid: string }[] = [];
    for (let i = 0; i < 5000; i++) records.push({ uuid: `u${i}` });
    write(records);
    // Anchor near the end; we want the 50 records preceding u4900.
    const r = await readHistoryBefore(tmpFile, "u4900", 50);
    expect(r.records.length).toBe(50);
    expect(r.records[0]?.uuid).toBe("u4850");
    expect(r.records[49]?.uuid).toBe("u4899");
    expect(r.exhausted).toBe(false);
  });
});
