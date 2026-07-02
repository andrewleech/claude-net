import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverRunningCcSessions,
  encodeProjectDirName,
  findActiveSessionForCcPid,
  readTmuxPaneFromCcEnv,
} from "@/mirror-agent/agent";

describe("encodeProjectDirName", () => {
  test("replaces slashes with hyphens", () => {
    expect(encodeProjectDirName("/home/alice/work")).toBe("-home-alice-work");
  });

  test("replaces underscores with hyphens", () => {
    expect(encodeProjectDirName("/home/alice/claude_marketplace")).toBe(
      "-home-alice-claude-marketplace",
    );
  });

  test("replaces dots with hyphens (yielding `--` for `/.`)", () => {
    expect(encodeProjectDirName("/home/alice/.claude/worktrees")).toBe(
      "-home-alice--claude-worktrees",
    );
  });

  test("non-alphanumerics including spaces become hyphens", () => {
    expect(encodeProjectDirName("/home/al ice/Plot of Sin(x)")).toBe(
      "-home-al-ice-Plot-of-Sin-x-",
    );
  });
});

describe("findActiveSessionForCcPid", () => {
  let tmpHome: string;
  let projectsDir: string;
  const sampleSid = "3d27a058-e598-49f1-abfc-5de63d0a6a46";
  const olderSid = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cn-test-home-"));
    projectsDir = path.join(tmpHome, ".claude", "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeJsonl(cwd: string, sid: string, mtimeMs: number): string {
    const dir = path.join(projectsDir, encodeProjectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(file, "");
    // Tests rely on monotonic mtime; fs.utimesSync expects seconds.
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }

  test("returns null when projects dir doesn't exist", () => {
    expect(findActiveSessionForCcPid(123, "/home/alice/work", tmpHome)).toBe(
      null,
    );
  });

  test("returns null when cwd is empty", () => {
    expect(findActiveSessionForCcPid(123, "", tmpHome)).toBe(null);
  });

  test("returns the sole JSONL for a cwd", () => {
    const cwd = "/home/alice/work";
    writeJsonl(cwd, sampleSid, Date.now());
    const found = findActiveSessionForCcPid(0, cwd, tmpHome);
    expect(found).not.toBe(null);
    if (!found) return;
    expect(found.sessionId).toBe(sampleSid);
    expect(found.transcriptPath).toContain(`${sampleSid}.jsonl`);
    expect(found.transcriptPath).toContain(encodeProjectDirName(cwd));
  });

  test("picks the most recently-modified JSONL when multiple exist", () => {
    const cwd = "/home/alice/work";
    const olderMs = Date.now() - 10_000;
    const newerMs = Date.now();
    writeJsonl(cwd, olderSid, olderMs);
    writeJsonl(cwd, sampleSid, newerMs);
    const found = findActiveSessionForCcPid(0, cwd, tmpHome);
    expect(found?.sessionId).toBe(sampleSid);
  });

  test("rejects filenames that aren't UUID-shaped", () => {
    const cwd = "/home/alice/work";
    const dir = path.join(projectsDir, encodeProjectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.jsonl"), "");
    const found = findActiveSessionForCcPid(0, cwd, tmpHome);
    expect(found).toBe(null);
  });

  test("ignores non-jsonl files in the project dir", () => {
    const cwd = "/home/alice/work";
    const dir = path.join(projectsDir, encodeProjectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scratch.txt"), "ignore me");
    fs.writeFileSync(path.join(dir, "scratch.json"), "{}");
    writeJsonl(cwd, sampleSid, Date.now());
    const found = findActiveSessionForCcPid(0, cwd, tmpHome);
    expect(found?.sessionId).toBe(sampleSid);
  });

  test("returns null when the project dir contains no jsonl files", () => {
    const cwd = "/home/alice/work";
    const dir = path.join(projectsDir, encodeProjectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scratch.txt"), "no transcripts here");
    expect(findActiveSessionForCcPid(0, cwd, tmpHome)).toBe(null);
  });
});

describe("readTmuxPaneFromCcEnv", () => {
  test("reads TMUX_PANE from this process's own environ when set", () => {
    if (process.platform !== "linux") return; // /proc-only path
    // Bun preserves the parent env via process.env — use self.
    const previous = process.env.TMUX_PANE;
    try {
      // We can't actually set our own /proc/<self>/environ — it's
      // snapshot at exec. Verify only that a missing var returns
      // undefined, and that an existing var (when present) is read.
      const ownPane = readTmuxPaneFromCcEnv(process.pid);
      if (previous) {
        expect(ownPane).toBe(previous);
      } else {
        expect(ownPane).toBeUndefined();
      }
    } finally {
      // Don't mutate state; nothing was written.
      void previous;
    }
  });

  test("returns undefined for an obviously bogus pid", () => {
    if (process.platform !== "linux") return;
    expect(readTmuxPaneFromCcEnv(2 ** 31 - 1)).toBeUndefined();
  });

  test("returns undefined for non-finite pid input", () => {
    expect(readTmuxPaneFromCcEnv(Number.NaN)).toBeUndefined();
    expect(readTmuxPaneFromCcEnv(0)).toBeUndefined();
    expect(readTmuxPaneFromCcEnv(-1)).toBeUndefined();
  });
});

describe("discoverRunningCcSessions", () => {
  // We construct a fake /proc tree plus a fake ~/.claude/projects/ tree
  // and verify the function walks both correctly. The fake proc has
  // three pids: one matching the claude exe pattern, one not, and one
  // matching but with no JSONL on disk.
  let tmpProc: string;
  let tmpHome: string;
  const matchingSid = "3d27a058-e598-49f1-abfc-5de63d0a6a46";

  beforeEach(() => {
    tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), "cn-proc-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cn-home-"));
  });

  afterEach(() => {
    fs.rmSync(tmpProc, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeFakePid(pid: number, opts: { exe: string; cwd: string }): void {
    const dir = path.join(tmpProc, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    // /proc/<pid>/exe and /proc/<pid>/cwd are symlinks; the helper uses
    // readlinkSync so we replicate the kernel's shape.
    fs.symlinkSync(opts.exe, path.join(dir, "exe"));
    fs.symlinkSync(opts.cwd, path.join(dir, "cwd"));
  }

  function plantJsonl(cwd: string, sid: string): void {
    const projects = path.join(tmpHome, ".claude", "projects");
    const dir = path.join(projects, encodeProjectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), "");
  }

  test("returns [] on non-Linux platforms", () => {
    if (process.platform === "linux") return;
    expect(discoverRunningCcSessions(tmpProc, tmpHome)).toEqual([]);
  });

  test("returns [] when /proc is unreadable", () => {
    if (process.platform !== "linux") return;
    expect(discoverRunningCcSessions("/no/such/proc", tmpHome)).toEqual([]);
  });

  test("matches a claude/versions/X.Y.Z exe and finds its session", () => {
    if (process.platform !== "linux") return;
    const cwd = path.join(tmpHome, "project-a");
    fs.mkdirSync(cwd, { recursive: true });
    plantJsonl(cwd, matchingSid);
    makeFakePid(12345, {
      exe: "/home/u/.local/share/claude/versions/2.1.186/claude",
      cwd,
    });
    const found = discoverRunningCcSessions(tmpProc, tmpHome);
    expect(found).toHaveLength(1);
    expect(found[0]?.ccPid).toBe(12345);
    expect(found[0]?.sessionId).toBe(matchingSid);
    expect(found[0]?.cwd).toBe(cwd);
  });

  test("matches a path ending in /claude even without versions/", () => {
    if (process.platform !== "linux") return;
    const cwd = path.join(tmpHome, "project-b");
    fs.mkdirSync(cwd, { recursive: true });
    plantJsonl(cwd, matchingSid);
    makeFakePid(2222, { exe: "/usr/local/bin/claude", cwd });
    const found = discoverRunningCcSessions(tmpProc, tmpHome);
    expect(found.map((d) => d.ccPid)).toContain(2222);
  });

  test("matches claude-channels' hash-suffixed patched binary", () => {
    if (process.platform !== "linux") return;
    const cwd = path.join(tmpHome, "project-c");
    fs.mkdirSync(cwd, { recursive: true });
    plantJsonl(cwd, matchingSid);
    makeFakePid(2223, {
      exe: "/home/u/.local/share/claude-channels/claude-patched-ab7ea74dfdc8",
      cwd,
    });
    const found = discoverRunningCcSessions(tmpProc, tmpHome);
    expect(found.map((d) => d.ccPid)).toContain(2223);
  });

  test("ignores processes whose exe doesn't look like claude", () => {
    if (process.platform !== "linux") return;
    const cwd = path.join(tmpHome, "p");
    fs.mkdirSync(cwd, { recursive: true });
    plantJsonl(cwd, matchingSid);
    makeFakePid(9999, { exe: "/usr/bin/bash", cwd });
    expect(discoverRunningCcSessions(tmpProc, tmpHome)).toEqual([]);
  });

  test("skips matching processes that have no JSONL on disk", () => {
    if (process.platform !== "linux") return;
    const cwd = path.join(tmpHome, "no-transcript");
    fs.mkdirSync(cwd, { recursive: true });
    // Note: no plantJsonl call — directory exists in /proc but no
    // transcript file in ~/.claude/projects.
    makeFakePid(3333, { exe: "/usr/local/bin/claude", cwd });
    expect(discoverRunningCcSessions(tmpProc, tmpHome)).toEqual([]);
  });

  test("deduplicates sessions that resolve to the same sid", () => {
    if (process.platform !== "linux") return;
    const cwd = path.join(tmpHome, "shared-cwd");
    fs.mkdirSync(cwd, { recursive: true });
    plantJsonl(cwd, matchingSid);
    // Two processes share the same cwd (fork-session); both resolve
    // to the same JSONL. We dedup so the agent doesn't open the
    // session twice.
    makeFakePid(4444, { exe: "/usr/local/bin/claude", cwd });
    makeFakePid(4445, { exe: "/usr/local/bin/claude", cwd });
    const found = discoverRunningCcSessions(tmpProc, tmpHome);
    expect(found).toHaveLength(1);
  });

  test("ignores non-pid entries in /proc", () => {
    if (process.platform !== "linux") return;
    // Drop a "self" symlink and a "version" file like the real /proc has.
    fs.symlinkSync("12345", path.join(tmpProc, "self"));
    fs.writeFileSync(path.join(tmpProc, "version"), "fake");
    expect(discoverRunningCcSessions(tmpProc, tmpHome)).toEqual([]);
  });
});
