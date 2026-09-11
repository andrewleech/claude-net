import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  childEnv,
  computeConfigDirs,
  configDirsKey,
  envPrefixForShell,
  execArgsForAccount,
  handleHostLaunch,
  newSessionEnvFlags,
} from "@/mirror-agent/host-channel";
import type { ConfigDirInfo, HostLaunchRequest } from "@/shared/types";

const DEFAULT_DIR = "/home/alice/.claude";
const CUSTOM_DIR = "/home/alice/.claude-personal";

describe("childEnv", () => {
  // The daemon deletes its own CLAUDE_CONFIG_DIR at startup, but a unit
  // test calling childEnv directly bypasses that - assert against
  // whatever the ambient shell happens to have (it may or may not be
  // set) by saving and restoring it, so this test's outcome never
  // depends on the value inherited from wherever `bun test` runs.
  const ORIGINAL = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      // biome-ignore lint/performance/noDelete: restoring the exact pre-test env shape
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = ORIGINAL;
    }
  });

  test("default account: CLAUDE_CONFIG_DIR is absent even when the ambient env has one", () => {
    process.env.CLAUDE_CONFIG_DIR = "/some/leaked/value";
    const env = childEnv(DEFAULT_DIR, DEFAULT_DIR);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("default account: still absent when the ambient env never had it", () => {
    // biome-ignore lint/performance/noDelete: exercising the "never set" starting state
    delete process.env.CLAUDE_CONFIG_DIR;
    const env = childEnv(DEFAULT_DIR, DEFAULT_DIR);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("custom account: CLAUDE_CONFIG_DIR is set to the account's own dir", () => {
    // biome-ignore lint/performance/noDelete: starting from a clean slate
    delete process.env.CLAUDE_CONFIG_DIR;
    const env = childEnv(CUSTOM_DIR, DEFAULT_DIR);
    expect(env.CLAUDE_CONFIG_DIR).toBe(CUSTOM_DIR);
  });

  test("custom account: overrides whatever the ambient env already had", () => {
    process.env.CLAUDE_CONFIG_DIR = "/some/other/account";
    const env = childEnv(CUSTOM_DIR, DEFAULT_DIR);
    expect(env.CLAUDE_CONFIG_DIR).toBe(CUSTOM_DIR);
  });

  test("other env vars pass through unchanged", () => {
    process.env.CN_HOST_CHANNEL_TEST_VAR = "keep-me";
    try {
      const env = childEnv(DEFAULT_DIR, DEFAULT_DIR);
      expect(env.CN_HOST_CHANNEL_TEST_VAR).toBe("keep-me");
    } finally {
      // biome-ignore lint/performance/noDelete: test-local cleanup
      delete process.env.CN_HOST_CHANNEL_TEST_VAR;
    }
  });
});

describe("envPrefixForShell", () => {
  test("default account unsets CLAUDE_CONFIG_DIR", () => {
    expect(envPrefixForShell(DEFAULT_DIR, DEFAULT_DIR)).toBe(
      "unset CLAUDE_CONFIG_DIR; ",
    );
  });

  test("custom account exports and shell-quotes the config dir", () => {
    expect(envPrefixForShell(CUSTOM_DIR, DEFAULT_DIR)).toBe(
      `export CLAUDE_CONFIG_DIR='${CUSTOM_DIR}'; `,
    );
  });

  test("shell-quotes a config dir containing a single quote", () => {
    const dir = "/home/alice/.claude-o'brien";
    expect(envPrefixForShell(dir, DEFAULT_DIR)).toContain(
      "CLAUDE_CONFIG_DIR='/home/alice/.claude-o'\\''brien'",
    );
  });
});

describe("execArgsForAccount", () => {
  test("default account wraps the command in env -u CLAUDE_CONFIG_DIR", () => {
    expect(execArgsForAccount(DEFAULT_DIR, DEFAULT_DIR)).toEqual([
      "env",
      "-u",
      "CLAUDE_CONFIG_DIR",
      "claude-channels",
    ]);
  });

  test("custom account execs claude-channels directly (relies on -e for env)", () => {
    expect(execArgsForAccount(CUSTOM_DIR, DEFAULT_DIR)).toEqual([
      "claude-channels",
    ]);
  });
});

describe("newSessionEnvFlags", () => {
  test("default account: no -e flags needed", () => {
    expect(newSessionEnvFlags(DEFAULT_DIR, DEFAULT_DIR)).toEqual([]);
  });

  test("custom account: -e CLAUDE_CONFIG_DIR=<dir>", () => {
    expect(newSessionEnvFlags(CUSTOM_DIR, DEFAULT_DIR)).toEqual([
      "-e",
      `CLAUDE_CONFIG_DIR=${CUSTOM_DIR}`,
    ]);
  });
});

describe("computeConfigDirs", () => {
  let home: string;

  beforeEach(() => {
    // Realpath'd immediately: os.tmpdir() is itself a symlink on macOS
    // (/tmp -> /private/tmp), and computeConfigDirs normalizes every
    // path it returns, so comparing against the raw mkdtemp result would
    // fail there even though the underlying directory is identical.
    home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cn-hostchannel-")),
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("default account only: one entry, marked is_default", () => {
    const dirs = computeConfigDirs(home, new Set());
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toEqual({
      path: path.join(home, ".claude"),
      label: "",
      is_default: true,
    });
  });

  test("discovers a .claude-* sibling with its own .claude.json", () => {
    const personal = path.join(home, ".claude-personal");
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, ".claude.json"), "{}");
    const dirs = computeConfigDirs(home, new Set());
    expect(dirs.map((d) => d.path)).toEqual([
      path.join(home, ".claude"),
      personal,
    ]);
    expect(dirs[1]?.label).toBe("personal");
    expect(dirs[1]?.is_default).toBe(false);
  });

  test("unions in a live config dir the on-disk scan wouldn't find", () => {
    const weird = path.join(home, "not-dot-claude-prefixed");
    const dirs = computeConfigDirs(home, new Set([weird]));
    expect(dirs.map((d) => d.path)).toContain(weird);
  });

  test("dedupes a live config dir that's already discovered", () => {
    const personal = path.join(home, ".claude-personal");
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, "settings.json"), "{}");
    const dirs = computeConfigDirs(home, new Set([personal]));
    expect(dirs.filter((d) => d.path === personal)).toHaveLength(1);
  });

  test("default account always sorts first", () => {
    const aaa = path.join(home, ".claude-aaa");
    fs.mkdirSync(aaa, { recursive: true });
    fs.writeFileSync(path.join(aaa, "settings.json"), "{}");
    const dirs = computeConfigDirs(home, new Set());
    expect(dirs[0]?.is_default).toBe(true);
  });
});

describe("configDirsKey", () => {
  test("same paths in the same order produce the same key", () => {
    const a = [
      { path: "/x/.claude", label: "", is_default: true },
      { path: "/x/.claude-personal", label: "personal", is_default: false },
    ];
    const b = [
      { path: "/x/.claude", label: "", is_default: true },
      { path: "/x/.claude-personal", label: "personal", is_default: false },
    ];
    expect(configDirsKey(a)).toBe(configDirsKey(b));
  });

  test("a different set of paths produces a different key", () => {
    const a = [{ path: "/x/.claude", label: "", is_default: true }];
    const b = [{ path: "/y/.claude", label: "", is_default: true }];
    expect(configDirsKey(a)).not.toBe(configDirsKey(b));
  });
});

describe("handleHostLaunch config_dir validation", () => {
  let home: string;
  let customDir: string;
  let knownConfigDirs: ConfigDirInfo[];

  beforeEach(() => {
    // Realpath'd for the same reason as computeConfigDirs' own tests -
    // handleHostLaunch normalizes config_dir before comparing it.
    home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cn-launch-home-")),
    );
    customDir = path.join(home, ".claude-personal");
    fs.mkdirSync(customDir, { recursive: true });
    knownConfigDirs = [
      { path: path.join(home, ".claude"), label: "", is_default: true },
      { path: customDir, label: "personal", is_default: false },
    ];
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function baseReq(
    overrides: Partial<HostLaunchRequest> = {},
  ): HostLaunchRequest {
    return {
      action: "host_launch",
      request_id: "r1",
      cwd: "",
      ...overrides,
    };
  }

  test("an unknown config_dir is rejected with host_launch_done, not a hang", async () => {
    const result = await handleHostLaunch(
      baseReq({ config_dir: path.join(home, ".claude-other") }),
      true,
      home,
      knownConfigDirs,
    );
    expect(result.action).toBe("host_launch_done");
    expect(result.ok).toBeUndefined();
    expect(result.error).toContain("unknown config_dir");
  });

  test("a non-string config_dir is rejected without throwing", async () => {
    // req is cast the same way the real onMessage handler casts a parsed
    // WS frame - config_dir can be any JSON value at runtime regardless
    // of what HostLaunchRequest declares.
    const req = {
      action: "host_launch",
      request_id: "r1",
      cwd: "",
      config_dir: 123,
    } as unknown as HostLaunchRequest;
    const result = await handleHostLaunch(req, true, home, knownConfigDirs);
    expect(result.action).toBe("host_launch_done");
    expect(result.error).toBe("config_dir must be a non-empty string");
  });

  test("an empty-string config_dir is rejected", async () => {
    const result = await handleHostLaunch(
      baseReq({ config_dir: "" }),
      true,
      home,
      knownConfigDirs,
    );
    expect(result.error).toBe("config_dir must be a non-empty string");
  });

  test("a known dir is accepted after normalising a trailing slash", async () => {
    // cwd is deliberately invalid so the function returns before ever
    // touching tmux; the error coming from the cwd check (not a
    // config_dir one) is the proof config_dir passed validation.
    const result = await handleHostLaunch(
      baseReq({ config_dir: `${customDir}/` }),
      true,
      home,
      knownConfigDirs,
    );
    expect(result.error).not.toContain("config_dir");
    expect(result.error).toContain("path");
  });

  test("a known dir is accepted after resolving a symlink to it", async () => {
    const link = path.join(home, ".claude-personal-link");
    fs.symlinkSync(customDir, link);
    const result = await handleHostLaunch(
      baseReq({ config_dir: link }),
      true,
      home,
      knownConfigDirs,
    );
    expect(result.error).not.toContain("config_dir");
    expect(result.error).toContain("path");
  });

  test("omitted config_dir defaults to the default account without validation", async () => {
    const result = await handleHostLaunch(
      baseReq(),
      true,
      home,
      knownConfigDirs,
    );
    expect(result.error).not.toContain("config_dir");
    expect(result.error).toContain("path");
  });

  test("skip_permissions is still checked before config_dir", async () => {
    const result = await handleHostLaunch(
      baseReq({ skip_permissions: true, config_dir: customDir }),
      false,
      home,
      knownConfigDirs,
    );
    expect(result.error).toBe("skip_permissions not allowed on this host");
  });
});
