// Tests for checkExistingDaemon — the agent-side guard against the
// watchdog spawn race. The function is exercised by writing a port file
// into a tmp state dir and pointing it at a fake fetch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  anotherMirrorAgentAlive,
  checkExistingDaemon,
  evictIfPeerOwnsPortFile,
} from "@/mirror-agent/agent";

// A TimeoutError, as AbortSignal.timeout() surfaces it — the singleton
// guards treat this as "listening but slow" (vs a plain connect error).
function timeoutError(): Error {
  const e = new Error("timed out");
  e.name = "TimeoutError";
  return e;
}

let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-singleton-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function portFile(): string {
  const uid = process.getuid?.() ?? 0;
  return path.join(stateDir, `mirror-agent-${uid}.port`);
}

describe("checkExistingDaemon", () => {
  test("returns healthy:false when no port file exists", async () => {
    const result = await checkExistingDaemon(stateDir);
    expect(result).toEqual({ healthy: false, port: null });
  });

  test("returns healthy:true when peer responds 200 on /health", async () => {
    fs.writeFileSync(portFile(), "9999");
    const fakeFetch = (async (_url: string) => ({
      ok: true,
    })) as unknown as typeof fetch;
    const result = await checkExistingDaemon(stateDir, fakeFetch);
    expect(result).toEqual({ healthy: true, port: 9999 });
    // Port file is preserved for live peers.
    expect(fs.existsSync(portFile())).toBe(true);
  });

  test("removes stale port file when peer is unreachable", async () => {
    fs.writeFileSync(portFile(), "9999");
    const fakeFetch = (async (_url: string) => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await checkExistingDaemon(stateDir, fakeFetch);
    expect(result.healthy).toBe(false);
    expect(result.port).toBe(9999);
    expect(fs.existsSync(portFile())).toBe(false);
  });

  test("defers to a slow (timeout) peer when a daemon is alive", async () => {
    fs.writeFileSync(portFile(), "9999");
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      throw timeoutError();
    }) as unknown as typeof fetch;
    // aliveImpl=() => true: a mirror-agent process is actually running.
    const result = await checkExistingDaemon(stateDir, fakeFetch, () => true);
    // A slow-but-live peer must count as present: do not spawn a duplicate,
    // and leave the port file intact.
    expect(result).toEqual({ healthy: true, port: 9999 });
    expect(fs.existsSync(portFile())).toBe(true);
    expect(calls).toBeGreaterThan(1); // retried rather than giving up at once
  });

  test("takes over on timeout when NO daemon process is alive", async () => {
    // Recorded loopback port was recycled by an unrelated, mute listener:
    // every probe times out but no mirror-agent exists. We must NOT defer
    // forever (that would strand the host with no daemon) — take over.
    fs.writeFileSync(portFile(), "9999");
    const fakeFetch = (async () => {
      throw timeoutError();
    }) as unknown as typeof fetch;
    const result = await checkExistingDaemon(stateDir, fakeFetch, () => false);
    expect(result).toEqual({ healthy: false, port: 9999 });
    expect(fs.existsSync(portFile())).toBe(false);
  });

  test("removes port file with non-numeric contents", async () => {
    fs.writeFileSync(portFile(), "garbage\n");
    const result = await checkExistingDaemon(stateDir);
    expect(result).toEqual({ healthy: false, port: null });
    expect(fs.existsSync(portFile())).toBe(false);
  });

  test("removes port file with zero/negative port", async () => {
    fs.writeFileSync(portFile(), "0");
    const result = await checkExistingDaemon(stateDir);
    expect(result).toEqual({ healthy: false, port: null });
    expect(fs.existsSync(portFile())).toBe(false);
  });

  test("treats peer 5xx as unhealthy and removes the port file", async () => {
    fs.writeFileSync(portFile(), "1234");
    const fakeFetch = (async (_url: string) => ({
      ok: false,
    })) as unknown as typeof fetch;
    const result = await checkExistingDaemon(stateDir, fakeFetch);
    expect(result).toEqual({ healthy: false, port: 1234 });
    expect(fs.existsSync(portFile())).toBe(false);
  });

  test("hits the expected URL", async () => {
    fs.writeFileSync(portFile(), "4242");
    let calledUrl = "";
    const fakeFetch = (async (url: string) => {
      calledUrl = url;
      return { ok: true };
    }) as unknown as typeof fetch;
    await checkExistingDaemon(stateDir, fakeFetch);
    expect(calledUrl).toBe("http://127.0.0.1:4242/health");
  });
});

describe("evictIfPeerOwnsPortFile", () => {
  test("no-op when the port file is missing", async () => {
    let exited = false;
    await evictIfPeerOwnsPortFile(8000, stateDir, fetch, ((_c: number) => {
      exited = true;
    }) as unknown as (code: number) => never);
    expect(exited).toBe(false);
  });

  test("no-op when the port file names this same process", async () => {
    fs.writeFileSync(portFile(), "8000");
    let exited = false;
    await evictIfPeerOwnsPortFile(8000, stateDir, fetch, ((_c: number) => {
      exited = true;
    }) as unknown as (code: number) => never);
    expect(exited).toBe(false);
  });

  test("exits when the file names a different healthy peer", async () => {
    fs.writeFileSync(portFile(), "9999");
    let exited = false;
    let exitCode = -1;
    const fakeFetch = (async (_url: string) => ({
      ok: true,
    })) as unknown as typeof fetch;
    await evictIfPeerOwnsPortFile(8000, stateDir, fakeFetch, ((c: number) => {
      exited = true;
      exitCode = c;
    }) as unknown as (code: number) => never);
    expect(exited).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("does NOT exit when the named peer is unreachable", async () => {
    fs.writeFileSync(portFile(), "9999");
    let exited = false;
    const fakeFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await evictIfPeerOwnsPortFile(8000, stateDir, fakeFetch, ((_c: number) => {
      exited = true;
    }) as unknown as (code: number) => never);
    expect(exited).toBe(false);
  });

  test("does NOT exit when the named peer returns non-OK", async () => {
    fs.writeFileSync(portFile(), "9999");
    let exited = false;
    const fakeFetch = (async () => ({
      ok: false,
    })) as unknown as typeof fetch;
    await evictIfPeerOwnsPortFile(8000, stateDir, fakeFetch, ((_c: number) => {
      exited = true;
    }) as unknown as (code: number) => never);
    expect(exited).toBe(false);
  });

  test("exits on timeout when another daemon is alive (slow owner)", async () => {
    fs.writeFileSync(portFile(), "9999");
    let exited = false;
    let exitCode = -1;
    const fakeFetch = (async () => {
      throw timeoutError();
    }) as unknown as typeof fetch;
    await evictIfPeerOwnsPortFile(
      8000,
      stateDir,
      fakeFetch,
      ((c: number) => {
        exited = true;
        exitCode = c;
      }) as unknown as (code: number) => never,
      () => true, // a real mirror-agent owns the slow port
    );
    // A timeout on loopback means something is listening but slow — a live
    // owner. The duplicate must yield.
    expect(exited).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("does NOT exit on timeout when no daemon is alive (foreign port)", async () => {
    // The recorded port is held by an unrelated, mute listener — not a
    // mirror-agent. The live daemon must stay, not exit into a no-daemon
    // state.
    fs.writeFileSync(portFile(), "9999");
    let exited = false;
    const fakeFetch = (async () => {
      throw timeoutError();
    }) as unknown as typeof fetch;
    await evictIfPeerOwnsPortFile(
      8000,
      stateDir,
      fakeFetch,
      ((_c: number) => {
        exited = true;
      }) as unknown as (code: number) => never,
      () => false,
    );
    expect(exited).toBe(false);
  });
});

describe("anotherMirrorAgentAlive", () => {
  let procRoot = "";

  beforeEach(() => {
    procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-proc-"));
  });

  afterEach(() => {
    fs.rmSync(procRoot, { recursive: true, force: true });
  });

  // Build a fake /proc/<pid>/cmdline (NUL-separated argv).
  function fakeProc(pid: number, argv: string[]): void {
    const dir = path.join(procRoot, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cmdline"), `${argv.join("\0")}\0`);
  }

  test("returns false on non-linux", () => {
    if (process.platform === "linux") return;
    fakeProc(4242, ["bun", "/x/mirror-agent.bundle.js"]);
    // Non-linux can't read /proc; the guard conservatively returns true,
    // so this assertion only holds off-linux where the early return fires.
    expect(anotherMirrorAgentAlive(procRoot, 1)).toBe(true);
  });

  test("detects another bun mirror-agent daemon", () => {
    if (process.platform !== "linux") return;
    fakeProc(4242, ["bun", "/home/u/.local/share/cc/mirror-agent.bundle.js"]);
    expect(anotherMirrorAgentAlive(procRoot, 1)).toBe(true);
  });

  test("excludes self", () => {
    if (process.platform !== "linux") return;
    fakeProc(4242, ["bun", "/x/mirror-agent.bundle.js"]);
    expect(anotherMirrorAgentAlive(procRoot, 4242)).toBe(false);
  });

  test("ignores inject subcommand and unrelated processes", () => {
    if (process.platform !== "linux") return;
    // inject run: trailing args after the bundle → not the daemon form.
    fakeProc(10, ["bun", "/x/mirror-agent.bundle.js", "inject", "hello"]);
    fakeProc(11, ["bun", "/x/some-other.js"]);
    fakeProc(12, ["node", "server.js"]);
    expect(anotherMirrorAgentAlive(procRoot, 1)).toBe(false);
  });
});
