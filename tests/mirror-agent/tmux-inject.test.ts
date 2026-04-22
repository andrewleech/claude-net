import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TmuxInjector } from "@/mirror-agent/tmux-inject";

// A fake `tmux` shim: records every invocation's argv to a file and exits 0.
// The injector runs `<tmux-bin> send-keys -t <pane> -l -- <text>` then
// `<tmux-bin> send-keys -t <pane> Enter`.

function makeFakeTmux(logFile: string, exitCode = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-tmux-"));
  const bin = path.join(dir, "tmux");
  // Bash script that appends its argv JSON-encoded, one per line.
  const script = `#!/usr/bin/env bash
python3 - "$@" <<'PY' >> ${JSON.stringify(logFile)}
import json, sys
print(json.dumps(sys.argv[1:]))
PY
exit ${exitCode}
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

function readLog(p: string): string[][] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as string[]);
}

describe("TmuxInjector", () => {
  let logFile: string;
  let fakeTmux: string;

  beforeEach(() => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-inject-"));
    logFile = path.join(tmpdir, "invocations.log");
    fakeTmux = makeFakeTmux(logFile);
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(path.dirname(fakeTmux), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("rejects empty prompt", async () => {
    const inj = new TmuxInjector({ tmuxBin: fakeTmux });
    const r = await inj.inject("s-1", "%0", "   \n  ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("empty");
  });

  test("rejects too-long prompt", async () => {
    const inj = new TmuxInjector({ tmuxBin: fakeTmux });
    const big = "x".repeat(1024 * 1024);
    const r = await inj.inject("s-1", "%0", big);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("too_long");
  });

  test("successful inject runs send-keys -l then Enter", async () => {
    const inj = new TmuxInjector({ tmuxBin: fakeTmux });
    const r = await inj.inject("s-1", "%12", "hello world");
    expect(r.ok).toBe(true);
    const calls = readLog(logFile);
    expect(calls.length).toBe(2);
    // First call: literal text.
    expect(calls[0]).toEqual([
      "send-keys",
      "-t",
      "%12",
      "-l",
      "--",
      "hello world",
    ]);
    // Second: Enter.
    expect(calls[1]).toEqual(["send-keys", "-t", "%12", "Enter"]);
  });

  test("rate limit rejects bursts inside the window", async () => {
    const inj = new TmuxInjector({ tmuxBin: fakeTmux, rateLimitMs: 500 });
    const r1 = await inj.inject("s-1", "%0", "one");
    expect(r1.ok).toBe(true);
    const r2 = await inj.inject("s-1", "%0", "two");
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.code).toBe("rate_limited");
  });

  test("literal mode preserves shell metacharacters", async () => {
    const inj = new TmuxInjector({ tmuxBin: fakeTmux });
    const evil = '`whoami`; rm -rf /; $(echo bad) "quotes"';
    const r = await inj.inject("s-1", "%0", evil);
    expect(r.ok).toBe(true);
    const calls = readLog(logFile);
    // The dangerous text must be passed as a single literal argv element.
    expect(calls[0]).toEqual(["send-keys", "-t", "%0", "-l", "--", evil]);
  });

  test("tmux failure returns tmux_failed code", async () => {
    const failing = makeFakeTmux(logFile, 1);
    const inj = new TmuxInjector({ tmuxBin: failing });
    const r = await inj.inject("s-1", "%0", "anything");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("tmux_failed");
    try {
      fs.rmSync(path.dirname(failing), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
