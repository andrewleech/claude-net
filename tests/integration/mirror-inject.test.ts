// End-to-end inject test: hub + (WebSocket pseudo-agent) verifying that
// POST /api/mirror/:sid/inject relays a MirrorInjectFrame over the WS.
//
// We don't stand up the full mirror-agent here (the tmux piece is exercised
// by tests/mirror-agent/tmux-inject.test.ts). Instead we connect a raw
// "agent"-role WebSocket to the hub and assert the frame arrives correctly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "@/hub/mirror";
import { Elysia } from "elysia";

type Msg = Record<string, unknown>;

function startHub() {
  const reg = new MirrorRegistry({ transcriptRing: 200, retentionMs: 0 });
  let app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg, port: 0 }));
  app = wsMirrorPlugin(app, reg);
  app.listen(0);
  // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
  const port = app.server!.port;
  return {
    port,
    stop: () => app.stop(),
    reg,
  };
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

async function createSession(port: number) {
  const r = await fetch(`http://localhost:${port}/api/mirror/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_agent: "t:u@h", cwd: "/tmp" }),
  });
  const d = (await r.json()) as {
    sid: string;
    owner_token: string;
    mirror_url: string;
  };
  return { sid: d.sid, token: d.owner_token };
}

describe("mirror inject REST → WS relay", () => {
  let hub: ReturnType<typeof startHub>;

  beforeEach(() => {
    hub = startHub();
  });

  afterEach(() => {
    hub.stop();
  });

  test("POST /inject relays MirrorInjectFrame to agent WS with seq", async () => {
    const s = await createSession(hub.port);
    const agentUrl =
      `ws://localhost:${hub.port}/ws/mirror/${encodeURIComponent(s.sid)}` +
      `?t=${encodeURIComponent(s.token)}&as=agent`;
    const agent = await connectWs(agentUrl);
    await agent.waitFor((m) => m.event === "mirror:agent_ready");

    const res = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/inject?t=${s.token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello from the web", watcher: "test" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean; seq: number };
    expect(body.accepted).toBe(true);
    expect(body.seq).toBe(1);

    const frame = (await agent.waitFor(
      (m) => m.event === "mirror_inject",
    )) as Record<string, unknown>;
    expect(frame.sid).toBe(s.sid);
    expect(frame.text).toBe("hello from the web");
    const origin = frame.origin as Record<string, unknown>;
    expect(origin.watcher).toBe("test");

    agent.close();
  });

  test("rejects inject without a token", async () => {
    const s = await createSession(hub.port);
    const res = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/inject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("rejects empty prompt", async () => {
    const s = await createSession(hub.port);
    const res = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/inject?t=${s.token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   \n" }),
      },
    );
    expect(res.status).toBe(400);
  });

  test("returns 503 when no mirror-agent is connected", async () => {
    const s = await createSession(hub.port);
    const res = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/inject?t=${s.token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      },
    );
    expect(res.status).toBe(503);
  });

  test("hub-side rate limit kicks in on burst", async () => {
    const s = await createSession(hub.port);
    const agentUrl =
      `ws://localhost:${hub.port}/ws/mirror/${encodeURIComponent(s.sid)}` +
      `?t=${encodeURIComponent(s.token)}&as=agent`;
    const agent = await connectWs(agentUrl);
    await agent.waitFor((m) => m.event === "mirror:agent_ready");

    const first = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/inject?t=${s.token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      },
    );
    expect(first.status).toBe(200);
    const second = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/inject?t=${s.token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi again" }),
      },
    );
    expect(second.status).toBe(429);
    agent.close();
  });
});
