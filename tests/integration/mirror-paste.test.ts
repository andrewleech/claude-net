// End-to-end paste test: hub + (WebSocket pseudo-agent) verifying that
// POST /api/mirror/:sid/paste relays a MirrorPasteFrame to the agent,
// waits for the agent's mirror_paste_done ack, and then auto-injects the
// returned path reference.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "@/hub/mirror";
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
  send: (m: unknown) => void;
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
        send(m) {
          ws.send(JSON.stringify(m));
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", (e) => reject(e));
  });
}

async function createSession(port: number) {
  const r = await fetch(`http://localhost:${port}/api/mirror/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_agent: "t:u@h", cwd: "/tmp" }),
  });
  const d = (await r.json()) as { sid: string };
  return { sid: d.sid };
}

describe("mirror paste REST → WS relay → ack → auto-inject", () => {
  let hub: ReturnType<typeof startHub>;

  beforeEach(() => {
    hub = startHub();
  });

  afterEach(() => {
    hub.stop();
  });

  test("POST /paste relays frame, resolves on agent ack, auto-injects @path", async () => {
    const s = await createSession(hub.port);
    const agentUrl = `ws://localhost:${hub.port}/ws/mirror/${encodeURIComponent(
      s.sid,
    )}?as=agent`;
    const agent = await connectWs(agentUrl);
    await agent.waitFor((m) => m.event === "mirror:agent_ready");

    // Fire the paste while the agent listens for the frame + acks it.
    const pasteResponse = (async () => {
      const r = await fetch(
        `http://localhost:${hub.port}/api/mirror/${s.sid}/paste`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "x".repeat(700_000),
            watcher: "test",
          }),
        },
      );
      return { status: r.status, body: await r.json() };
    })();

    const pasteFrame = (await agent.waitFor(
      (m) => m.event === "mirror_paste",
    )) as Record<string, unknown>;
    expect(pasteFrame.sid).toBe(s.sid);
    expect(typeof pasteFrame.requestId).toBe("string");
    expect((pasteFrame.text as string).length).toBe(700_000);

    // Simulate agent reply.
    agent.send({
      action: "mirror_paste_done",
      sid: s.sid,
      requestId: pasteFrame.requestId,
      path: "/tmp/claude-net/pastes/paste-xyz.txt",
    });

    // The hub should also auto-inject `@<path>`.
    const injectFrame = (await agent.waitFor(
      (m) => m.event === "mirror_inject",
    )) as Record<string, unknown>;
    expect(injectFrame.text).toBe("@/tmp/claude-net/pastes/paste-xyz.txt");

    const res = await pasteResponse;
    expect(res.status).toBe(200);
    const body = res.body as {
      accepted: boolean;
      path: string;
      reference: string;
      bytes: number;
    };
    expect(body.accepted).toBe(true);
    expect(body.path).toBe("/tmp/claude-net/pastes/paste-xyz.txt");
    expect(body.reference).toBe("@/tmp/claude-net/pastes/paste-xyz.txt");
    expect(body.bytes).toBe(700_000);

    agent.close();
  });

  test("rejects paste over CLAUDE_NET_MIRROR_PASTE_MAX_MB cap", async () => {
    const s = await createSession(hub.port);
    // Default cap is 64 MB — we don't need to actually allocate 64 MB, just
    // send something obviously over. The endpoint checks Buffer.byteLength.
    const huge = "a".repeat(65 * 1024 * 1024);
    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/paste`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: huge, watcher: "test" }),
      },
    );
    expect(r.status).toBe(413);
    const body = (await r.json()) as { error?: string };
    expect(body.error || "").toContain("Paste exceeds");
  });

  test("GET /config returns limits", async () => {
    const r = await fetch(`http://localhost:${hub.port}/api/mirror/config`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      inject_max_kb: number;
      paste_max_mb: number;
      inject_rpm: number;
    };
    expect(body.inject_max_kb).toBeGreaterThan(0);
    expect(body.paste_max_mb).toBeGreaterThan(0);
    expect(body.inject_rpm).toBeGreaterThan(0);
  });
});
