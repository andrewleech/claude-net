import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TailHandle, tailJsonl } from "@/mirror-agent/jsonl-tail";

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("tailJsonl", () => {
  let tmpFile: string;
  let handle: TailHandle | null = null;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `mirror-jsonl-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
  });

  afterEach(() => {
    if (handle) {
      handle.stop();
      handle = null;
    }
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  test("reads existing content on start", async () => {
    fs.writeFileSync(
      tmpFile,
      `${JSON.stringify({ uuid: "a", type: "user" })}\n${JSON.stringify({ uuid: "b", type: "assistant" })}\n`,
    );
    const seen: string[] = [];
    handle = tailJsonl(tmpFile, {
      onRecord: (r) => seen.push(r.uuid as string),
      pollIntervalMs: 50,
    });
    await wait(100);
    expect(seen).toEqual(["a", "b"]);
  });

  test("reads appended lines after start", async () => {
    fs.writeFileSync(tmpFile, "");
    const seen: string[] = [];
    handle = tailJsonl(tmpFile, {
      onRecord: (r) => seen.push(r.uuid as string),
      pollIntervalMs: 50,
    });
    await wait(80);
    fs.appendFileSync(tmpFile, `${JSON.stringify({ uuid: "a" })}\n`);
    fs.appendFileSync(tmpFile, `${JSON.stringify({ uuid: "b" })}\n`);
    await wait(200);
    expect(seen).toContain("a");
    expect(seen).toContain("b");
  });

  test("does not fire on non-existent file until it appears", async () => {
    const seen: string[] = [];
    handle = tailJsonl(tmpFile, {
      onRecord: (r) => seen.push(r.uuid as string),
      pollIntervalMs: 50,
    });
    await wait(80);
    expect(seen).toEqual([]);
    fs.writeFileSync(tmpFile, `${JSON.stringify({ uuid: "x" })}\n`);
    await wait(200);
    expect(seen).toContain("x");
  });

  test("handles malformed lines without crashing", async () => {
    fs.writeFileSync(
      tmpFile,
      `not-json\n${JSON.stringify({ uuid: "good" })}\n`,
    );
    const seen: string[] = [];
    const errors: Error[] = [];
    handle = tailJsonl(tmpFile, {
      onRecord: (r) => seen.push(r.uuid as string),
      onError: (err) => errors.push(err),
      pollIntervalMs: 50,
    });
    await wait(100);
    expect(seen).toEqual(["good"]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
