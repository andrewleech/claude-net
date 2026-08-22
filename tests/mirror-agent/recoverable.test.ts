import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  encodeProjectDirName,
  sanitizeTmuxName,
  scanRecoverable,
} from "@/mirror-agent/recoverable";

const SID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SID_B = "bbbbbbbb-1111-2222-3333-444444444444";

describe("scanRecoverable", () => {
  let home: string;
  let projectsRoot: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cn-recover-"));
    projectsRoot = path.join(home, ".claude", "projects");
    fs.mkdirSync(projectsRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Create a project directory plus a transcript, and register it in ~/.claude.json. */
  function seed(opts: {
    name: string;
    sid: string;
    lastGracefulShutdown?: boolean;
    hasTrustDialogAccepted?: boolean;
    lines?: string[];
    ageMs?: number;
    /** Skip creating the working directory on disk. */
    missingDir?: boolean;
  }): string {
    const cwd = path.join(home, "projects", opts.name);
    if (!opts.missingDir) fs.mkdirSync(cwd, { recursive: true });

    const tDir = path.join(projectsRoot, encodeProjectDirName(cwd));
    fs.mkdirSync(tDir, { recursive: true });
    const file = path.join(tDir, `${opts.sid}.jsonl`);
    const lines = opts.lines ?? [
      JSON.stringify({ type: "user", message: { content: "hello there" } }),
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    if (opts.ageMs) {
      const when = new Date(Date.now() - opts.ageMs);
      fs.utimesSync(file, when, when);
    }

    const cfgPath = path.join(home, ".claude.json");
    const cfg = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      : { projects: {} };
    cfg.projects[cwd] = {
      lastGracefulShutdown: opts.lastGracefulShutdown ?? false,
      hasTrustDialogAccepted: opts.hasTrustDialogAccepted ?? true,
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    return cwd;
  }

  test("surfaces a project whose last exit was not graceful", () => {
    const cwd = seed({ name: "alpha", sid: SID_A });
    const found = scanRecoverable({ home });
    expect(found).toHaveLength(1);
    expect(found[0].session_id).toBe(SID_A);
    expect(found[0].cwd).toBe(cwd);
    expect(found[0].label).toBe("alpha");
    expect(found[0].turns).toBe(1);
    expect(found[0].preview).toBe("hello there");
  });

  test("skips a project that shut down gracefully", () => {
    seed({ name: "alpha", sid: SID_A, lastGracefulShutdown: true });
    expect(scanRecoverable({ home })).toHaveLength(0);
  });

  test("skips transcripts older than the window", () => {
    seed({ name: "alpha", sid: SID_A, ageMs: 48 * 60 * 60 * 1000 });
    expect(scanRecoverable({ home, withinHours: 24 })).toHaveLength(0);
    expect(scanRecoverable({ home, withinHours: 72 })).toHaveLength(1);
  });

  test("withinHours: null applies no window at all", () => {
    seed({ name: "alpha", sid: SID_A, ageMs: 400 * 24 * 60 * 60 * 1000 });
    expect(scanRecoverable({ home, withinHours: 24 })).toHaveLength(0);
    expect(scanRecoverable({ home, withinHours: null })).toHaveLength(1);
  });

  test("skips a project whose directory no longer exists", () => {
    seed({ name: "gone", sid: SID_A, missingDir: true });
    expect(scanRecoverable({ home })).toHaveLength(0);
  });

  test("skips sessions the daemon reports as live", () => {
    seed({ name: "alpha", sid: SID_A });
    expect(
      scanRecoverable({ home, liveSessionIds: new Set([SID_A]) }),
    ).toHaveLength(0);
  });

  test("skips cwds the daemon reports as live", () => {
    const cwd = seed({ name: "alpha", sid: SID_A });
    expect(scanRecoverable({ home, liveCwds: new Set([cwd]) })).toHaveLength(0);
  });

  test("flags projects that have never accepted the trust dialog", () => {
    seed({ name: "alpha", sid: SID_A, hasTrustDialogAccepted: false });
    seed({ name: "beta", sid: SID_B, hasTrustDialogAccepted: true });
    const byLabel = new Map(scanRecoverable({ home }).map((s) => [s.label, s]));
    expect(byLabel.get("alpha")?.needs_trust).toBe(true);
    expect(byLabel.get("beta")?.needs_trust).toBe(false);
  });

  test("reports an existing tmux session as a conflict", () => {
    seed({ name: "alpha", sid: SID_A });
    const found = scanRecoverable({
      home,
      tmuxSessionExists: (name) => name === "alpha",
    });
    expect(found[0].tmux_conflict).toBe("alpha");
  });

  test("does not treat a longer tmux name as a conflict", () => {
    seed({ name: "alpha", sid: SID_A });
    const found = scanRecoverable({
      home,
      tmuxSessionExists: (name) => name === "alpha-two",
    });
    expect(found[0].tmux_conflict).toBeNull();
  });

  test("reports a dotted directory basename's sanitized tmux name as a conflict", () => {
    seed({ name: "v1.2", sid: SID_A });
    const found = scanRecoverable({
      home,
      // The probe only ever sees names tmux would actually create, i.e.
      // with "." rewritten to "_" already.
      tmuxSessionExists: (name) => name === "v1_2",
    });
    expect(found[0].tmux_conflict).toBe("v1_2");
  });

  test("preview uses the last real user turn and ignores tool results", () => {
    seed({
      name: "alpha",
      sid: SID_A,
      lines: [
        JSON.stringify({ type: "user", message: { content: "first" } }),
        JSON.stringify({ type: "assistant", message: { content: "reply" } }),
        JSON.stringify({ type: "user", message: { content: "second" } }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", content: "output" }] },
        }),
        JSON.stringify({
          type: "user",
          message: { content: "<system-reminder>noise</system-reminder>" },
        }),
      ],
    });
    const found = scanRecoverable({ home });
    expect(found[0].preview).toBe("second");
    expect(found[0].turns).toBe(2);
  });

  test("prefers a /rename custom-title over the directory basename", () => {
    seed({
      name: "alpha",
      sid: SID_A,
      lines: [
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        JSON.stringify({ type: "custom-title", customTitle: "auth rewrite" }),
      ],
    });
    expect(scanRecoverable({ home })[0].label).toBe("auth rewrite");
  });

  test("applies the redactor to the preview", () => {
    seed({
      name: "alpha",
      sid: SID_A,
      lines: [
        JSON.stringify({
          type: "user",
          message: { content: "token sk-secret" },
        }),
      ],
    });
    const found = scanRecoverable({
      home,
      redact: (s) => s.replace("sk-secret", "«redacted»"),
    });
    expect(found[0].preview).toBe("token «redacted»");
  });

  test("picks the newest transcript when a project has several", () => {
    const cwd = seed({ name: "alpha", sid: SID_A, ageMs: 60 * 60 * 1000 });
    const tDir = path.join(projectsRoot, encodeProjectDirName(cwd));
    fs.writeFileSync(
      path.join(tDir, `${SID_B}.jsonl`),
      `${JSON.stringify({ type: "user", message: { content: "newer" } })}\n`,
    );
    const found = scanRecoverable({ home });
    expect(found).toHaveLength(1);
    expect(found[0].session_id).toBe(SID_B);
  });

  test("ignores empty transcripts", () => {
    const cwd = seed({ name: "alpha", sid: SID_A });
    fs.writeFileSync(
      path.join(projectsRoot, encodeProjectDirName(cwd), `${SID_A}.jsonl`),
      "",
    );
    expect(scanRecoverable({ home })).toHaveLength(0);
  });

  test("returns nothing when ~/.claude.json is absent or unparseable", () => {
    expect(scanRecoverable({ home })).toHaveLength(0);
    fs.writeFileSync(path.join(home, ".claude.json"), "{ not json");
    expect(scanRecoverable({ home })).toHaveLength(0);
  });

  test("sorts most recently active first", () => {
    seed({ name: "older", sid: SID_A, ageMs: 4 * 60 * 60 * 1000 });
    seed({ name: "newer", sid: SID_B });
    const found = scanRecoverable({ home });
    expect(found.map((s) => s.label)).toEqual(["newer", "older"]);
  });

  test("metadataOnly skips the transcript body: basename label, null turns, empty preview", () => {
    seed({
      name: "alpha",
      sid: SID_A,
      lines: [
        JSON.stringify({ type: "user", message: { content: "hello there" } }),
        JSON.stringify({ type: "custom-title", customTitle: "renamed" }),
      ],
    });
    const found = scanRecoverable({ home, metadataOnly: true });
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("alpha");
    expect(found[0].turns).toBeNull();
    expect(found[0].preview).toBe("");
    expect(found[0].session_id).toBe(SID_A);
    expect(found[0].needs_trust).toBe(false);
  });
});

describe("sanitizeTmuxName", () => {
  test("rewrites the tmux target-syntax delimiters . and : to _", () => {
    expect(sanitizeTmuxName("v1.2")).toBe("v1_2");
    expect(sanitizeTmuxName("a:b")).toBe("a_b");
    expect(sanitizeTmuxName("a.b:c.d")).toBe("a_b_c_d");
  });

  test("leaves names without those characters untouched", () => {
    expect(sanitizeTmuxName("widget")).toBe("widget");
    expect(sanitizeTmuxName("my-project_2")).toBe("my-project_2");
  });
});
