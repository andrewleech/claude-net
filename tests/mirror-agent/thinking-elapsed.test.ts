// The thinking counter's elapsed time must be computed where both operands
// share a clock. The agent stamps startedAt with its own Date.now(); a
// viewer on another machine subtracting that from its own clock reads the
// counter wrong by whatever the two hosts differ by — differently per
// host, so moving between sessions looks like the number jumping. The agent
// therefore also reports the turn's age as a duration.
//
// Stands up a real hub and a real mirror-agent, then drives the daemon's
// /hook endpoint the way claude-net-mirror-push does.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "@/hub/mirror";
import { type AgentHandle, startAgent } from "@/mirror-agent/agent";
import { Elysia } from "elysia";

type Msg = Record<string, unknown>;

function startHub() {
  const reg = new MirrorRegistry({ transcriptRing: 200, retentionMs: 0 });
  let app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
  app = wsMirrorPlugin(app, reg);
  app.listen(0);
  // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
  const port = app.server!.port;
  return { port, stop: () => app.stop() };
}

function connectWs(url: string): Promise<{
  messages: Msg[];
  waitFor: (pred: (m: Msg) => boolean, ms?: number) => Promise<Msg>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Msg[] = [];
    const waiters: Array<{
      pred: (m: Msg) => boolean;
      resolve: (m: Msg) => void;
    }> = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as Msg;
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w?.pred(msg)) {
          waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });
    ws.addEventListener("open", () =>
      resolve({
        messages,
        waitFor(pred, ms = 15_000) {
          for (const m of messages) if (pred(m)) return Promise.resolve(m);
          return new Promise<Msg>((res, rej) => {
            const t = setTimeout(
              () =>
                rej(
                  new Error(
                    `timed out waiting for frame; saw ${messages
                      .map((m) => String(m.event))
                      .join(",")}`,
                  ),
                ),
              ms,
            );
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.addEventListener("error", (e) => reject(e));
  });
}

describe("thinking indicator elapsed time", () => {
  let hub: ReturnType<typeof startHub>;
  let handle: AgentHandle;
  let stateDir = "";
  let projDir = "";

  beforeEach(async () => {
    hub = startHub();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-think-state-"));
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-think-proj-"));
    handle = await startAgent({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      stateDir,
      idleShutdownMs: 0,
      sessionIdleMs: 0,
    });
  });

  afterEach(async () => {
    await handle.stop();
    hub.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  async function hook(body: Record<string, unknown>): Promise<void> {
    await fetch(`http://127.0.0.1:${handle.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("a turn reports its age as a duration, not just a start time", async () => {
    const sid = crypto.randomUUID();
    const transcriptPath = path.join(projDir, `${sid}.jsonl`);
    await hook({
      hook_event_name: "SessionStart",
      session_id: sid,
      transcript_path: transcriptPath,
      cwd: projDir,
      source: "startup",
    });

    const watcher = await connectWs(
      `ws://127.0.0.1:${hub.port}/ws/mirror/${encodeURIComponent(sid)}`,
    );
    await watcher.waitFor((m) => m.event === "mirror:init");

    await hook({
      hook_event_name: "UserPromptSubmit",
      session_id: sid,
      cwd: projDir,
      prompt: "do a thing",
    });
    const start = await watcher.waitFor(
      (m) => m.event === "mirror:thinking" && m.active === true,
    );
    // Both fields present: the duration is what a viewer renders, the
    // absolute stamp stays for agents/consumers that want it.
    expect(typeof start.elapsed_ms).toBe("number");
    expect(typeof start.startedAt).toBe("number");
    expect(start.elapsed_ms as number).toBeGreaterThanOrEqual(0);
    expect(start.elapsed_ms as number).toBeLessThan(5_000);

    // A tool starting keeps the same turn: the duration grows while the
    // start stamp holds still.
    await Bun.sleep(1_100);
    await hook({
      hook_event_name: "PreToolUse",
      session_id: sid,
      cwd: projDir,
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "true" },
    });
    const running = await watcher.waitFor(
      (m) => m.event === "mirror:thinking" && m.tool === "Bash",
    );
    expect(running.startedAt).toBe(start.startedAt);
    expect(running.elapsed_ms as number).toBeGreaterThanOrEqual(1_000);

    // The duration must agree with the wall-clock gap between the two
    // frames — that equivalence is the whole point, and it holds without
    // the viewer ever touching startedAt.
    const grew = (running.elapsed_ms as number) - (start.elapsed_ms as number);
    expect(grew).toBeGreaterThanOrEqual(900);
    expect(grew).toBeLessThan(5_000);

    watcher.close();
  });

  test("turn end carries no timing fields", async () => {
    const sid = crypto.randomUUID();
    await hook({
      hook_event_name: "SessionStart",
      session_id: sid,
      transcript_path: path.join(projDir, `${sid}.jsonl`),
      cwd: projDir,
      source: "startup",
    });
    const watcher = await connectWs(
      `ws://127.0.0.1:${hub.port}/ws/mirror/${encodeURIComponent(sid)}`,
    );
    await watcher.waitFor((m) => m.event === "mirror:init");

    await hook({
      hook_event_name: "UserPromptSubmit",
      session_id: sid,
      cwd: projDir,
      prompt: "hi",
    });
    await watcher.waitFor(
      (m) => m.event === "mirror:thinking" && m.active === true,
    );

    await hook({
      hook_event_name: "Stop",
      session_id: sid,
      cwd: projDir,
      last_assistant_message: "done",
      stop_reason: "end_turn",
    });
    const end = await watcher.waitFor(
      (m) => m.event === "mirror:thinking" && m.active === false,
    );
    expect("elapsed_ms" in end).toBe(false);
    expect("startedAt" in end).toBe(false);

    watcher.close();
  });
});
