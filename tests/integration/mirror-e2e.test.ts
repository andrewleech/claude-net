// End-to-end: stand up a real hub on a random port, create a mirror session
// via the REST endpoint, connect an "agent" WebSocket that pushes events, and
// a "watcher" WebSocket that consumes them. Assert the watcher sees the same
// events the agent pushed, in order. Tokens are no longer required — the hub
// sits on a trusted network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "@/hub/mirror";
import { Elysia } from "elysia";

type Msg = Record<string, unknown>;

interface TestHub {
  port: number;
  stop(): void;
  mirrorRegistry: MirrorRegistry;
}

function startHub(): TestHub {
  const mirrorRegistry = new MirrorRegistry({
    transcriptRing: 200,
    retentionMs: 0,
  });

  let app = new Elysia().use(mirrorPlugin({ mirrorRegistry }));
  app = wsMirrorPlugin(app, mirrorRegistry);
  app.listen(0);

  // biome-ignore lint/style/noNonNullAssertion: server is guaranteed after listen
  const port = app.server!.port;
  return {
    port,
    stop: () => app.stop(),
    mirrorRegistry,
  };
}

interface WsConn {
  ws: WebSocket;
  messages: Msg[];
  waitFor: (pred: (m: Msg) => boolean, ms?: number) => Promise<Msg>;
  close: () => void;
}

function connectWs(url: string): Promise<WsConn> {
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
          for (const m of messages) {
            if (pred(m)) return Promise.resolve(m);
          }
          return new Promise<Msg>((res, rej) => {
            const t = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx !== -1) waiters.splice(idx, 1);
              rej(
                new Error(
                  `Timed out waiting for message. Received: ${JSON.stringify(messages)}`,
                ),
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

async function createSession(
  port: number,
  owner = "session:u@h",
  cwd = "/tmp",
): Promise<{ sid: string }> {
  const res = await fetch(`http://localhost:${port}/api/mirror/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_agent: owner, cwd }),
  });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  const data = (await res.json()) as { sid: string };
  return { sid: data.sid };
}

function eventFrame(
  sid: string,
  uuid: string,
  kind: string,
  payload: Record<string, unknown>,
): Msg {
  return {
    action: "mirror_event",
    sid,
    uuid,
    kind,
    ts: Date.now(),
    payload: { kind, ...payload },
  };
}

describe("mirror-session end-to-end", () => {
  let hub: TestHub;

  beforeEach(() => {
    hub = startHub();
  });

  afterEach(() => {
    hub.stop();
  });

  test("creates a session and returns just the sid", async () => {
    const s = await createSession(hub.port);
    expect(s.sid).toMatch(/.+/);
  });

  test("watcher receives init then live events pushed by the agent", async () => {
    const s = await createSession(hub.port);
    const wsBase = `ws://localhost:${hub.port}/ws/mirror/${encodeURIComponent(s.sid)}`;

    const agent = await connectWs(`${wsBase}?as=agent`);
    await agent.waitFor((m) => m.event === "mirror:agent_ready");

    const watcher = await connectWs(wsBase);
    const init = (await watcher.waitFor(
      (m) => m.event === "mirror:init",
    )) as Record<string, unknown>;
    expect(init.sid).toBe(s.sid);
    expect(Array.isArray(init.transcript)).toBe(true);

    const [u1, u2, u3] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    const uuids = [u1, u2, u3];
    agent.ws.send(
      JSON.stringify(
        eventFrame(s.sid, u1, "user_prompt", {
          prompt: "p1",
          cwd: "/tmp",
        }),
      ),
    );
    agent.ws.send(
      JSON.stringify(
        eventFrame(s.sid, u2, "assistant_message", {
          text: "reply",
          stop_reason: "end_turn",
        }),
      ),
    );
    agent.ws.send(
      JSON.stringify(eventFrame(s.sid, u3, "notification", { text: "note" })),
    );

    for (const u of uuids) {
      const ev = (await watcher.waitFor(
        (m) => m.event === "mirror:event" && m.uuid === u,
      )) as Record<string, unknown>;
      expect(ev.sid).toBe(s.sid);
    }

    agent.close();
    watcher.close();
  });

  test("watcher connection on an unknown sid is rejected", async () => {
    const watcher = await connectWs(
      `ws://localhost:${hub.port}/ws/mirror/bogus-sid`,
    );
    const err = (await watcher.waitFor((m) => m.event === "error")) as Record<
      string,
      unknown
    >;
    expect(typeof err.message).toBe("string");
    watcher.close();
  });

  test("transcript snapshot replays in the init frame", async () => {
    const s = await createSession(hub.port);
    const wsBase = `ws://localhost:${hub.port}/ws/mirror/${encodeURIComponent(s.sid)}`;
    const agent = await connectWs(`${wsBase}?as=agent`);
    await agent.waitFor((m) => m.event === "mirror:agent_ready");

    const uuids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, u] of uuids.entries()) {
      agent.ws.send(
        JSON.stringify(
          eventFrame(s.sid, u, "user_prompt", {
            prompt: `p${i}`,
            cwd: "/tmp",
          }),
        ),
      );
    }
    await new Promise((r) => setTimeout(r, 50));

    const watcher = await connectWs(wsBase);
    const init = (await watcher.waitFor((m) => m.event === "mirror:init")) as {
      transcript: Array<{ uuid: string }>;
    };
    const initUuids = init.transcript.map((f) => f.uuid);
    expect(initUuids).toEqual(uuids);
    agent.close();
    watcher.close();
  });

  test("REST /transcript and /close work without any token query", async () => {
    const s = await createSession(hub.port);
    const ok = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/transcript`,
    );
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as Record<string, unknown>;
    expect(payload.sid).toBe(s.sid);
    expect(Array.isArray(payload.transcript)).toBe(true);

    const missing = await fetch(
      `http://localhost:${hub.port}/api/mirror/does-not-exist/transcript`,
    );
    expect(missing.status).toBe(404);

    const close = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/close`,
      { method: "POST" },
    );
    expect(close.status).toBe(200);
  });
});
