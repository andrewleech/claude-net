// Sub-agent JSONL tail: once a sub-agent-tagged hook names a new agent_id,
// the mirror-agent starts tailing that sub-agent's own transcript file and
// emits its assistant text blocks tagged with agent_id/agent_type - without
// touching the parent's context-usage state (no ctx/usage broadcast for
// sub-agent tails, even when the underlying record carries a usage object).
//
// Stands up a real hub (Elysia + MirrorRegistry, random port) and a real
// mirror-agent daemon (startAgent) pointed at it, then drives the daemon's
// /hook endpoint the same way claude-net-mirror-push does.

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
  return { port, stop: () => app.stop(), reg };
}

function connectWs(url: string): Promise<{
  ws: WebSocket;
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
    ws.addEventListener("open", () => {
      resolve({
        ws,
        messages,
        waitFor(pred, ms = 3000) {
          for (const m of messages) if (pred(m)) return Promise.resolve(m);
          return new Promise<Msg>((res, rej) => {
            const t = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx !== -1) waiters.splice(idx, 1);
              rej(
                new Error(`Timed out. Received: ${JSON.stringify(messages)}`),
              );
            }, ms);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", (e) => reject(e));
  });
}

describe("mirror-agent sub-agent JSONL tail", () => {
  let hub: ReturnType<typeof startHub>;
  let handle: AgentHandle;
  let stateDir = "";
  let projDir = "";

  beforeEach(async () => {
    hub = startHub();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-subtail-agent-"));
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-subtail-proj-"));
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

  test("emits tagged text-only frames from a sub-agent's own transcript, without a ctx/usage broadcast", async () => {
    const sid = crypto.randomUUID();
    const transcriptPath = path.join(projDir, `${sid}.jsonl`);

    // SessionStart establishes the session on the hub and records
    // transcriptPath, which the sub-agent tail path derives from.
    const startRes = await fetch(`http://127.0.0.1:${handle.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sid,
        transcript_path: transcriptPath,
        cwd: projDir,
        source: "startup",
      }),
    });
    expect(startRes.status).toBe(202);

    const watcher = await connectWs(
      `ws://127.0.0.1:${hub.port}/ws/mirror/${encodeURIComponent(sid)}`,
    );
    await watcher.waitFor((m) => m.event === "mirror:init");

    // Pre-create the sub-agent's own transcript with one assistant
    // record carrying both a text block and a usage object. The usage
    // object is the tripwire: if the tail mistakenly routed through
    // emitCtxFromUsage (as the main tail does), a mirror:statusline
    // broadcast would follow.
    const agentId = "sub-1";
    const subPath = path.join(
      projDir,
      sid,
      "subagents",
      `agent-${agentId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(subPath), { recursive: true });
    const rec = {
      type: "assistant",
      uuid: "sub-rec-1",
      timestamp: new Date().toISOString(),
      message: {
        content: [{ type: "text", text: "Sub-agent reasoning text" }],
        usage: {
          input_tokens: 500_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };
    fs.writeFileSync(subPath, `${JSON.stringify(rec)}\n`);

    // First sighting of agent_id: a PreToolUse hook tagged with
    // agent_id/agent_type starts the sub-agent tail. The file already
    // exists, so tailJsonl's initial synchronous read picks it up
    // immediately.
    const toolRes = await fetch(`http://127.0.0.1:${handle.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: sid,
        transcript_path: transcriptPath,
        cwd: projDir,
        tool_use_id: "use-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        agent_id: agentId,
        agent_type: "general-purpose",
      }),
    });
    expect(toolRes.status).toBe(202);

    const textEvt = (await watcher.waitFor(
      (m) =>
        m.event === "mirror:event" &&
        m.kind === "assistant_message" &&
        m.agent_id === agentId,
    )) as Record<string, unknown>;
    expect(textEvt.agent_type).toBe("general-purpose");
    const payload = textEvt.payload as Record<string, unknown>;
    expect(payload.text).toBe("Sub-agent reasoning text");
    expect(payload.subagent_done).toBeUndefined();

    // Give any (incorrect) ctx broadcast a beat to arrive, then confirm
    // none did - the sub-agent tail must never touch the parent's ctx bar.
    await new Promise((r) => setTimeout(r, 300));
    const statusline = watcher.messages.find(
      (m) => m.event === "mirror:statusline",
    );
    expect(statusline).toBeUndefined();

    watcher.close();
  }, 10000);
});
