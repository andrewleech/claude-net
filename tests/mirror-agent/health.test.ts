// Tests for the /health endpoint of a running agent — specifically the
// `hub` and `pid` fields the launcher uses to detect a daemon running
// against a stale hub URL (bin/claude-channels: _mirror_agent_healthy).
// A daemon spawned with the wrong hub (e.g. the localhost fallback) still
// answers /health, so the launcher compares the reported hub against the
// freshly-resolved config and kills/respawns on mismatch.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentHandle, startAgent } from "@/mirror-agent/agent";

describe("mirror-agent /health", () => {
  let stateDir = "";
  let handle: AgentHandle;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-health-"));
    // Trailing slashes in the configured URL must not leak into the
    // reported hub — the launcher compares normalized values.
    handle = await startAgent({
      hubUrl: "http://hub.invalid:1///",
      stateDir,
      idleShutdownMs: 0,
      sessionIdleMs: 0,
    });
  });

  afterAll(async () => {
    await handle.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("reports status, hub (normalized) and pid", async () => {
    const resp = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.hub).toBe("http://hub.invalid:1");
    expect(body.pid).toBe(process.pid);
    expect(body.port).toBe(handle.port);
  });
});
