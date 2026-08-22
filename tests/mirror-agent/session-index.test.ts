// The index exists so a daemon restart re-attaches to sessions it already
// knew rather than re-deriving them from /proc — a derivation that cannot
// separate two sessions sharing a directory. These tests use a fake
// procRoot so the pid-liveness and pid-reuse guards can be exercised
// without spawning processes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SessionIndex,
  entryStillValid,
  indexKey,
  loadSessionIndex,
  saveSessionIndex,
  sessionIndexPath,
} from "@/mirror-agent/session-index";

let root: string;
let stateDir: string;
let procRoot: string;

const SID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-sessidx-"));
  stateDir = path.join(root, "state");
  procRoot = path.join(root, "proc");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(procRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Fake /proc/<pid>/cwd symlink plus a transcript file on disk. */
function fakeProcess(pid: number, cwd: string, transcript: string): void {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
  fs.symlinkSync(cwd, path.join(procRoot, String(pid), "cwd"));
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{}\n");
}

function entry(pid: number, cwd: string, sid: string, transcript: string) {
  return { sid, cwd, ccPid: pid, transcriptPath: transcript, ts: Date.now() };
}

describe("entryStillValid", () => {
  test("accepts a live pid whose cwd and transcript match", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fakeProcess(4242, cwd, tr);
    expect(entryStillValid(entry(4242, cwd, SID_A, tr), procRoot)).toBe(true);
  });

  test("rejects a pid that is gone", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fs.mkdirSync(path.dirname(tr), { recursive: true });
    fs.writeFileSync(tr, "{}\n");
    expect(entryStillValid(entry(999_999, cwd, SID_A, tr), procRoot)).toBe(
      false,
    );
  });

  test("rejects a reused pid now running in a different directory", () => {
    // The whole reason cwd is part of the key: the kernel hands pids out
    // again, and inheriting a sid would mirror the wrong transcript.
    const realCwd = path.join(root, "other");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fakeProcess(4242, realCwd, tr);
    const stale = entry(4242, path.join(root, "proj"), SID_A, tr);
    expect(entryStillValid(stale, procRoot)).toBe(false);
  });

  test("rejects an entry whose transcript has been removed", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fakeProcess(4242, cwd, tr);
    fs.rmSync(tr);
    expect(entryStillValid(entry(4242, cwd, SID_A, tr), procRoot)).toBe(false);
  });
});

describe("load / save round trip", () => {
  test("persists and restores a valid entry", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fakeProcess(4242, cwd, tr);
    saveSessionIndex(stateDir, [entry(4242, cwd, SID_A, tr)]);
    const loaded = loadSessionIndex(stateDir, procRoot);
    expect(loaded.get(indexKey(4242, cwd))?.sid).toBe(SID_A);
  });

  test("missing file yields an empty map, not a throw", () => {
    expect(loadSessionIndex(stateDir, procRoot).size).toBe(0);
  });

  test("corrupt JSON yields an empty map", () => {
    fs.writeFileSync(sessionIndexPath(stateDir), "{not json");
    expect(loadSessionIndex(stateDir, procRoot).size).toBe(0);
  });

  test("drops entries whose process is gone", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fs.mkdirSync(path.dirname(tr), { recursive: true });
    fs.writeFileSync(tr, "{}\n");
    saveSessionIndex(stateDir, [entry(31337, cwd, SID_A, tr)]);
    expect(loadSessionIndex(stateDir, procRoot).size).toBe(0);
  });

  test("drops entries past the age bound", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fakeProcess(4242, cwd, tr);
    const old = { ...entry(4242, cwd, SID_A, tr), ts: 1_000 };
    saveSessionIndex(stateDir, [old]);
    const loaded = loadSessionIndex(
      stateDir,
      procRoot,
      1_000 + 31 * 24 * 60 * 60 * 1000,
    );
    expect(loaded.size).toBe(0);
  });

  test("rejects a malformed sid rather than feeding it downstream", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", "notauuid.jsonl");
    fakeProcess(4242, cwd, tr);
    saveSessionIndex(stateDir, [entry(4242, cwd, "notauuid", tr)]);
    expect(loadSessionIndex(stateDir, procRoot).size).toBe(0);
  });

  test("a non-array file is discarded", () => {
    fs.writeFileSync(sessionIndexPath(stateDir), JSON.stringify({ a: 1 }));
    expect(loadSessionIndex(stateDir, procRoot).size).toBe(0);
  });
});

describe("SessionIndex", () => {
  test("records a session and finds it again after a reload", () => {
    // The restart case: what the daemon learned from a hook survives into
    // the next process.
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fakeProcess(4242, cwd, tr);

    const first = new SessionIndex(stateDir, procRoot);
    first.record(SID_A, cwd, 4242, tr);

    const second = new SessionIndex(stateDir, procRoot);
    second.load();
    expect(second.get(4242, cwd)?.sid).toBe(SID_A);
  });

  test("keeps two sessions sharing a directory apart", () => {
    // This is the case the /proc derivation cannot resolve, and the reason
    // the index exists at all.
    const cwd = path.join(root, "shared");
    const trA = path.join(root, "tr", `${SID_A}.jsonl`);
    const trB = path.join(root, "tr", `${SID_B}.jsonl`);
    fakeProcess(101, cwd, trA);
    fs.mkdirSync(path.join(procRoot, "102"), { recursive: true });
    fs.symlinkSync(cwd, path.join(procRoot, "102", "cwd"));
    fs.writeFileSync(trB, "{}\n");

    const idx = new SessionIndex(stateDir, procRoot);
    idx.record(SID_A, cwd, 101, trA);
    idx.record(SID_B, cwd, 102, trB);

    const reloaded = new SessionIndex(stateDir, procRoot);
    reloaded.load();
    expect(reloaded.get(101, cwd)?.sid).toBe(SID_A);
    expect(reloaded.get(102, cwd)?.sid).toBe(SID_B);
  });

  test("ignores a record with no ccPid or no transcript", () => {
    const cwd = path.join(root, "proj");
    const idx = new SessionIndex(stateDir, procRoot);
    idx.record(SID_A, cwd, null, "/some/path.jsonl");
    idx.record(SID_A, cwd, 4242, undefined);
    idx.record(SID_A, undefined, 4242, "/some/path.jsonl");
    expect(idx.size).toBe(0);
  });

  test("a moved transcript updates in place", () => {
    const cwd = path.join(root, "proj");
    const trOld = path.join(root, "tr", `${SID_A}.jsonl`);
    const trNew = path.join(root, "tr2", `${SID_A}.jsonl`);
    fakeProcess(4242, cwd, trOld);
    fs.mkdirSync(path.dirname(trNew), { recursive: true });
    fs.writeFileSync(trNew, "{}\n");

    const idx = new SessionIndex(stateDir, procRoot);
    idx.record(SID_A, cwd, 4242, trOld);
    idx.record(SID_A, cwd, 4242, trNew);
    expect(idx.size).toBe(1);
    expect(idx.get(4242, cwd)?.transcriptPath).toBe(trNew);
  });

  test("forget removes the entry so a restart won't re-adopt it", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fakeProcess(4242, cwd, tr);
    const idx = new SessionIndex(stateDir, procRoot);
    idx.record(SID_A, cwd, 4242, tr);
    idx.forget(4242, cwd);
    expect(idx.size).toBe(0);
    const reloaded = new SessionIndex(stateDir, procRoot);
    reloaded.load();
    expect(reloaded.size).toBe(0);
  });

  test("an unchanged record inside the debounce window skips the write", () => {
    const cwd = path.join(root, "proj");
    const tr = path.join(root, "tr", `${SID_A}.jsonl`);
    fakeProcess(4242, cwd, tr);
    const idx = new SessionIndex(stateDir, procRoot);
    idx.record(SID_A, cwd, 4242, tr, 1_000_000);
    const mtime1 = fs.statSync(sessionIndexPath(stateDir)).mtimeMs;
    idx.record(SID_A, cwd, 4242, tr, 1_000_500);
    const mtime2 = fs.statSync(sessionIndexPath(stateDir)).mtimeMs;
    expect(mtime2).toBe(mtime1);
    expect(idx.get(4242, cwd)?.ts).toBe(1_000_000);
  });
});
