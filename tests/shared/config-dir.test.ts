import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  accountLabel,
  claudeJsonPath,
  configDirFromTranscriptPath,
  defaultConfigDir,
  discoverConfigDirs,
  normalizeConfigDir,
  resolveConfigDir,
  sanitizeTmuxName,
  tmuxSessionBase,
} from "@/shared/config-dir";

describe("defaultConfigDir", () => {
  test("joins home with .claude", () => {
    expect(defaultConfigDir("/home/alice")).toBe("/home/alice/.claude");
  });
});

describe("resolveConfigDir", () => {
  test("falls back to the default when CLAUDE_CONFIG_DIR is unset", () => {
    expect(resolveConfigDir({}, "/home/alice")).toBe("/home/alice/.claude");
  });

  test("falls back to the default when CLAUDE_CONFIG_DIR is empty/whitespace", () => {
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: "" }, "/home/alice")).toBe(
      "/home/alice/.claude",
    );
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: "  " }, "/home/alice")).toBe(
      "/home/alice/.claude",
    );
  });

  test("uses CLAUDE_CONFIG_DIR when set, normalized", () => {
    expect(
      resolveConfigDir(
        { CLAUDE_CONFIG_DIR: "/home/alice/.claude-personal/" },
        "/home/alice",
      ),
    ).toBe("/home/alice/.claude-personal");
  });
});

describe("normalizeConfigDir", () => {
  let tmp: string;

  beforeEach(() => {
    // Realpath'd immediately: os.tmpdir() is itself a symlink on macOS
    // (/tmp -> /private/tmp), and normalizeConfigDir realpaths any path
    // that exists, so comparing against the raw mkdtemp result would
    // fail there even though the underlying directory is identical.
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cn-cfgdir-norm-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("strips a trailing slash", () => {
    expect(normalizeConfigDir(`${tmp}/`)).toBe(tmp);
  });

  test("resolves a relative path to absolute", () => {
    expect(normalizeConfigDir(".")).toBe(path.resolve("."));
  });

  test("resolves a symlink to the real directory when it exists", () => {
    const real = path.join(tmp, "real");
    const link = path.join(tmp, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(normalizeConfigDir(link)).toBe(fs.realpathSync(real));
  });

  test("leaves a non-existent path resolved-but-unlinked", () => {
    const missing = path.join(tmp, "does-not-exist");
    expect(normalizeConfigDir(missing)).toBe(missing);
  });
});

describe("claudeJsonPath", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cn-cfgdir-json-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("default account: ~/.claude/.claude.json is absent, falls back to $HOME/.claude.json", () => {
    const configDir = defaultConfigDir(home);
    fs.mkdirSync(configDir, { recursive: true });
    expect(claudeJsonPath(configDir, home)).toBe(
      path.join(home, ".claude.json"),
    );
  });

  test("custom account: prefers <configDir>/.claude.json when it exists", () => {
    const configDir = path.join(home, ".claude-personal");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, ".claude.json"), "{}");
    expect(claudeJsonPath(configDir, home)).toBe(
      path.join(configDir, ".claude.json"),
    );
  });

  test("custom account without its own .claude.json still resolves inside the custom dir, never $HOME's", () => {
    const configDir = path.join(home, ".claude-personal");
    fs.mkdirSync(configDir, { recursive: true });
    expect(claudeJsonPath(configDir, home)).toBe(
      path.join(configDir, ".claude.json"),
    );
  });

  test("a default config dir without its own .claude.json falls back to $HOME's", () => {
    const configDir = defaultConfigDir(home);
    expect(claudeJsonPath(configDir, home)).toBe(
      path.join(home, ".claude.json"),
    );
  });

  test("a default config dir that does have its own .claude.json wins over $HOME's", () => {
    const configDir = defaultConfigDir(home);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, ".claude.json"), "{}");
    expect(claudeJsonPath(configDir, home)).toBe(
      path.join(configDir, ".claude.json"),
    );
  });
});

describe("configDirFromTranscriptPath", () => {
  test("main session transcript: three levels below /projects/", () => {
    expect(
      configDirFromTranscriptPath(
        "/home/alice/.claude/projects/-home-alice-work/3d27a058-e598-49f1-abfc-5de63d0a6a46.jsonl",
      ),
    ).toBe("/home/alice/.claude");
  });

  test("sub-agent transcript: five levels below /projects/", () => {
    expect(
      configDirFromTranscriptPath(
        "/home/alice/.claude/projects/-home-alice-work/3d27a058-e598-49f1-abfc-5de63d0a6a46/subagents/agent-7.jsonl",
      ),
    ).toBe("/home/alice/.claude");
  });

  test("custom account transcript path", () => {
    expect(
      configDirFromTranscriptPath(
        "/home/alice/.claude-personal/projects/-home-alice-work/sid.jsonl",
      ),
    ).toBe("/home/alice/.claude-personal");
  });

  test("returns null when there is no /projects/ segment", () => {
    expect(configDirFromTranscriptPath("/home/alice/notes.jsonl")).toBeNull();
  });

  test("returns null for undefined/null/empty input", () => {
    expect(configDirFromTranscriptPath(undefined)).toBeNull();
    expect(configDirFromTranscriptPath(null)).toBeNull();
    expect(configDirFromTranscriptPath("")).toBeNull();
  });

  test("a path starting with /projects/ (no config dir prefix) returns null", () => {
    expect(configDirFromTranscriptPath("/projects/x/sid.jsonl")).toBeNull();
  });
});

describe("accountLabel", () => {
  test("empty string for the default account", () => {
    expect(accountLabel("/home/alice/.claude", "/home/alice")).toBe("");
  });

  test("empty string for the default account given with a trailing slash", () => {
    expect(accountLabel("/home/alice/.claude/", "/home/alice")).toBe("");
  });

  test("strips the leading dot and 'claude-' prefix", () => {
    expect(accountLabel("/home/alice/.claude-personal", "/home/alice")).toBe(
      "personal",
    );
  });

  test("a custom dir without the claude- prefix keeps its dotless basename", () => {
    expect(accountLabel("/home/alice/.work", "/home/alice")).toBe("work");
  });
});

describe("sanitizeTmuxName", () => {
  test("rewrites . and : to _", () => {
    expect(sanitizeTmuxName("v1.2")).toBe("v1_2");
    expect(sanitizeTmuxName("a:b")).toBe("a_b");
  });

  test("leaves other names untouched", () => {
    expect(sanitizeTmuxName("widget")).toBe("widget");
  });
});

describe("tmuxSessionBase", () => {
  test("default account: no suffix, matches sanitizeTmuxName(basename(cwd))", () => {
    expect(
      tmuxSessionBase(
        "/home/alice/my.project",
        "/home/alice/.claude",
        "/home/alice",
      ),
    ).toBe("my_project");
  });

  test("custom account: suffixed with -<label>", () => {
    expect(
      tmuxSessionBase(
        "/home/alice/my-project",
        "/home/alice/.claude-personal",
        "/home/alice",
      ),
    ).toBe("my-project-personal");
  });

  test("two accounts in the same cwd never collide", () => {
    const cwd = "/home/alice/shared";
    const home = "/home/alice";
    const work = tmuxSessionBase(cwd, "/home/alice/.claude", home);
    const personal = tmuxSessionBase(cwd, "/home/alice/.claude-personal", home);
    expect(work).not.toBe(personal);
  });
});

describe("discoverConfigDirs", () => {
  let home: string;

  beforeEach(() => {
    // Realpath'd for the same reason as normalizeConfigDir's own tests
    // above - discoverConfigDirs normalizes every path it returns.
    home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cn-cfgdir-discover-")),
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("always includes the default dir first, even when it doesn't exist on disk", () => {
    expect(discoverConfigDirs(home)).toEqual([path.join(home, ".claude")]);
  });

  test("finds a .claude-* sibling with its own .claude.json", () => {
    const personal = path.join(home, ".claude-personal");
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, ".claude.json"), "{}");
    fs.writeFileSync(path.join(personal, "settings.json"), "{}");
    expect(discoverConfigDirs(home)).toEqual([
      path.join(home, ".claude"),
      personal,
    ]);
  });

  test("ignores a copy of the default dir that has only a settings.json", () => {
    // `cp -r ~/.claude ~/.claude-backup` copies settings.json but not
    // .claude.json, which the default account keeps in $HOME.
    const backup = path.join(home, ".claude-backup");
    fs.mkdirSync(path.join(backup, "projects"), { recursive: true });
    fs.writeFileSync(path.join(backup, "settings.json"), "{}");
    expect(discoverConfigDirs(home)).toEqual([path.join(home, ".claude")]);
  });

  test("ignores a .claude-* directory with no marker file", () => {
    fs.mkdirSync(path.join(home, ".claude-scratch"), { recursive: true });
    expect(discoverConfigDirs(home)).toEqual([path.join(home, ".claude")]);
  });

  test("ignores a .claude-* entry that is a file, not a directory", () => {
    fs.writeFileSync(path.join(home, ".claude-stray"), "not a dir");
    expect(discoverConfigDirs(home)).toEqual([path.join(home, ".claude")]);
  });

  test("sorts multiple accounts alphabetically after the default", () => {
    for (const name of [".claude-zzz", ".claude-aaa"]) {
      const dir = path.join(home, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
    }
    expect(discoverConfigDirs(home)).toEqual([
      path.join(home, ".claude"),
      path.join(home, ".claude-aaa"),
      path.join(home, ".claude-zzz"),
    ]);
  });

  test("returns just the default dir when home is unreadable", () => {
    expect(discoverConfigDirs(path.join(home, "no-such-home"))).toEqual([
      path.join(home, "no-such-home", ".claude"),
    ]);
  });
});
