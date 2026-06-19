import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROMPT_DEFINITIONS,
  buildRenamePromptMessages,
  encodeProjectDirName,
  findActiveSessionForCcPid,
  readCustomTitleFromTranscript,
  readPersistedAgentName,
  resolveStartupName,
  sanitizeSessionPart,
  writePersistedAgentName,
} from "@/plugin/plugin";

describe("encodeProjectDirName", () => {
  test("replaces slashes with hyphens", () => {
    expect(encodeProjectDirName("/home/alice/work")).toBe("-home-alice-work");
  });

  test("replaces non-alphanumerics including dots and spaces", () => {
    expect(encodeProjectDirName("/home/al ice/.claude")).toBe(
      "-home-al-ice--claude",
    );
  });
});

describe("findActiveSessionForCcPid", () => {
  let tmpHome: string;
  let projectsDir: string;
  const sampleSid = "3d27a058-e598-49f1-abfc-5de63d0a6a46";
  const olderSid = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cn-plugin-home-"));
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
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }

  test("returns null when projects dir doesn't exist", () => {
    expect(findActiveSessionForCcPid(0, "/home/alice/work", tmpHome)).toBe(
      null,
    );
  });

  test("returns the most recently-modified JSONL", () => {
    const cwd = "/home/alice/work";
    writeJsonl(cwd, olderSid, Date.now() - 10_000);
    writeJsonl(cwd, sampleSid, Date.now());
    const found = findActiveSessionForCcPid(0, cwd, tmpHome);
    expect(found?.sessionId).toBe(sampleSid);
    expect(found?.transcriptPath).toContain(`${sampleSid}.jsonl`);
  });

  test("rejects non-UUID filenames", () => {
    const cwd = "/home/alice/work";
    const dir = path.join(projectsDir, encodeProjectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scratch.jsonl"), "");
    expect(findActiveSessionForCcPid(0, cwd, tmpHome)).toBe(null);
  });
});

describe("readCustomTitleFromTranscript", () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-jsonl-"));
    file = path.join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when file missing", () => {
    expect(readCustomTitleFromTranscript(file)).toBe(null);
  });

  test("returns null when no custom-title line present", () => {
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "user", content: "hi" })}\n`,
    );
    expect(readCustomTitleFromTranscript(file)).toBe(null);
  });

  test("returns the most recent custom-title", () => {
    const lines = [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "custom-title", customTitle: "first" }),
      JSON.stringify({ type: "user", content: "another" }),
      JSON.stringify({ type: "custom-title", customTitle: "latest" }),
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = readCustomTitleFromTranscript(file);
    expect(result?.title).toBe("latest");
    expect(typeof result?.ts).toBe("number");
  });

  test("ignores malformed JSON lines", () => {
    const lines = [
      "not json at all",
      JSON.stringify({ type: "custom-title", customTitle: "real" }),
      '{"broken',
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    expect(readCustomTitleFromTranscript(file)?.title).toBe("real");
  });

  test("ignores custom-title with empty customTitle", () => {
    const lines = [
      JSON.stringify({ type: "custom-title", customTitle: "" }),
      JSON.stringify({ type: "custom-title", customTitle: "real" }),
    ];
    fs.writeFileSync(file, lines.join("\n"));
    expect(readCustomTitleFromTranscript(file)?.title).toBe("real");
  });
});

describe("sanitizeSessionPart", () => {
  test("strips colon and at-sign that would break hub regex", () => {
    expect(sanitizeSessionPart("net:dev@host")).toBe("net-dev-host");
  });

  test("collapses whitespace and other punctuation to dashes", () => {
    expect(sanitizeSessionPart("hello world!")).toBe("hello-world");
  });

  test("preserves alphanumerics, dots, underscores, dashes", () => {
    expect(sanitizeSessionPart("my_session-1.0")).toBe("my_session-1.0");
  });

  test("trims leading and trailing dashes", () => {
    expect(sanitizeSessionPart("---foo---")).toBe("foo");
  });

  test("caps to 64 chars", () => {
    expect(sanitizeSessionPart("a".repeat(100)).length).toBe(64);
  });

  test("returns empty for input with no usable characters", () => {
    expect(sanitizeSessionPart("@@@:::")).toBe("");
  });
});

describe("readPersistedAgentName / writePersistedAgentName", () => {
  let tmpHome: string;
  const cwd = "/home/alice/work";
  const sid = "3d27a058-e598-49f1-abfc-5de63d0a6a46";

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cn-persist-"));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("returns null when no persisted file exists", () => {
    expect(readPersistedAgentName(sid, cwd, tmpHome)).toBe(null);
  });

  test("round-trips name and timestamp", () => {
    writePersistedAgentName(sid, cwd, "reviewer:alice@host", 1000, tmpHome);
    const got = readPersistedAgentName(sid, cwd, tmpHome);
    expect(got).toEqual({ name: "reviewer:alice@host", ts: 1000 });
  });

  test("creates the project dir as needed", () => {
    writePersistedAgentName(sid, cwd, "x:y@z", 1, tmpHome);
    const dir = path.join(
      tmpHome,
      ".claude",
      "projects",
      encodeProjectDirName(cwd),
    );
    expect(fs.existsSync(dir)).toBe(true);
  });

  test("returns null for malformed persisted JSON", () => {
    const dir = path.join(
      tmpHome,
      ".claude",
      "projects",
      encodeProjectDirName(cwd),
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.claude-net.json`), "not json");
    expect(readPersistedAgentName(sid, cwd, tmpHome)).toBe(null);
  });

  test("returns null when required fields are missing", () => {
    const dir = path.join(
      tmpHome,
      ".claude",
      "projects",
      encodeProjectDirName(cwd),
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${sid}.claude-net.json`),
      JSON.stringify({ name: "x" }), // missing ts
    );
    expect(readPersistedAgentName(sid, cwd, tmpHome)).toBe(null);
  });
});

describe("resolveStartupName", () => {
  const defaultName = "session:alice@host";

  test("returns the default when neither source is set", () => {
    expect(resolveStartupName(defaultName, null, null)).toBe(defaultName);
  });

  test("returns persisted when only persisted is set", () => {
    expect(
      resolveStartupName(
        defaultName,
        { name: "reviewer:alice@host", ts: 1000 },
        null,
      ),
    ).toBe("reviewer:alice@host");
  });

  test("returns custom-title-derived name when only that is set", () => {
    expect(
      resolveStartupName(defaultName, null, { title: "tester", ts: 1000 }),
    ).toBe("tester:alice@host");
  });

  test("freshest wins when both are set", () => {
    expect(
      resolveStartupName(
        defaultName,
        { name: "old:alice@host", ts: 1000 },
        { title: "new", ts: 2000 },
      ),
    ).toBe("new:alice@host");
    expect(
      resolveStartupName(
        defaultName,
        { name: "newer:alice@host", ts: 3000 },
        { title: "stale", ts: 2000 },
      ),
    ).toBe("newer:alice@host");
  });

  test("ignores custom-title that sanitizes to empty", () => {
    expect(
      resolveStartupName(defaultName, null, { title: "@@@:::", ts: 9999 }),
    ).toBe(defaultName);
  });

  test("sanitizes custom-title that contains forbidden chars", () => {
    expect(
      resolveStartupName(defaultName, null, {
        title: "my:test@thing",
        ts: 1000,
      }),
    ).toBe("my-test-thing:alice@host");
  });
});

describe("PROMPT_DEFINITIONS", () => {
  test("declares /rename prompt with required name arg", () => {
    const rename = PROMPT_DEFINITIONS.find((p) => p.name === "rename");
    expect(rename).toBeDefined();
    expect(rename?.arguments?.[0]?.name).toBe("name");
    expect(rename?.arguments?.[0]?.required).toBe(true);
  });
});

describe("buildRenamePromptMessages", () => {
  test("returns a user message that mentions both register and /rename", () => {
    const result = buildRenamePromptMessages("reviewer");
    expect(result.messages).toHaveLength(1);
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("register");
    expect(text).toContain("/rename");
    expect(text).toContain("reviewer");
    expect(text).toContain("claude-net-mirror-agent inject");
  });

  test("sanitizes the requested name before embedding", () => {
    const result = buildRenamePromptMessages("foo:bar@baz");
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("foo-bar-baz");
    expect(text).not.toContain("foo:bar@baz");
  });
});
