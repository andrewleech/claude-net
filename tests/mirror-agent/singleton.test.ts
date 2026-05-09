// Tests for checkExistingDaemon — the agent-side guard against the
// watchdog spawn race. The function is exercised by writing a port file
// into a tmp state dir and pointing it at a fake fetch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkExistingDaemon } from "@/mirror-agent/agent";

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
