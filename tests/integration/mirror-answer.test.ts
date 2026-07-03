// End-to-end answer test: hub + (WebSocket pseudo-agent) verifying that
// POST /api/mirror/:sid/answer validates the answer set and relays a
// MirrorAnswerFrame over the WS. The tmux keystroke choreography itself
// lives in the mirror-agent and is exercised separately; here we only
// assert the REST → WS relay and the body validation.

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
  const d = (await r.json()) as { sid: string };
  return { sid: d.sid };
}

function answerUrl(port: number, sid: string) {
  return `http://localhost:${port}/api/mirror/${encodeURIComponent(sid)}/answer`;
}

describe("mirror answer REST → WS relay", () => {
  let hub: ReturnType<typeof startHub>;

  beforeEach(() => {
    hub = startHub();
  });

  afterEach(() => {
    hub.stop();
  });

  test("POST /answer relays a MirrorAnswerFrame to the agent WS", async () => {
    const s = await createSession(hub.port);
    const agentUrl = `ws://localhost:${hub.port}/ws/mirror/${encodeURIComponent(
      s.sid,
    )}?as=agent`;
    const agent = await connectWs(agentUrl);
    await agent.waitFor((m) => m.event === "mirror:agent_ready");

    const answers = [{ digit: 2 }, { digit: 3, text: "Berlin" }];
    const res = await fetch(answerUrl(hub.port, s.sid), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers, watcher: "test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);

    const frame = (await agent.waitFor(
      (m) => m.event === "mirror_answer",
    )) as Record<string, unknown>;
    expect(frame.sid).toBe(s.sid);
    expect(frame.answers).toEqual(answers);
    expect((frame.origin as Record<string, unknown>).watcher).toBe("test");

    agent.close();
  });

  test("relays multiSelect and note answer shapes verbatim", async () => {
    const s = await createSession(hub.port);
    const agent = await connectWs(
      `ws://localhost:${hub.port}/ws/mirror/${encodeURIComponent(s.sid)}?as=agent`,
    );
    await agent.waitFor((m) => m.event === "mirror:agent_ready");

    const answers = [{ multi: true, digits: [1, 3] }, { note: "looks good" }];
    const res = await fetch(answerUrl(hub.port, s.sid), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers, watcher: "test" }),
    });
    expect(res.status).toBe(200);

    const frame = (await agent.waitFor(
      (m) => m.event === "mirror_answer",
    )) as Record<string, unknown>;
    expect(frame.answers).toEqual(answers);
    agent.close();
  });

  test("rejects answer on an unknown sid with 404", async () => {
    const res = await fetch(answerUrl(hub.port, "unknown-sid"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ digit: 1 }] }),
    });
    expect(res.status).toBe(404);
  });

  test("rejects an empty answer set with 400", async () => {
    const s = await createSession(hub.port);
    const res = await fetch(answerUrl(hub.port, s.sid), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects answers whose digits are all out of range with 400", async () => {
    const s = await createSession(hub.port);
    const res = await fetch(answerUrl(hub.port, s.sid), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 0 and 99 are out of the 1-9 single-keypress range → both dropped.
      body: JSON.stringify({ answers: [{ digit: 0 }, { digit: 99 }] }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 503 when no mirror-agent is connected", async () => {
    const s = await createSession(hub.port);
    const res = await fetch(answerUrl(hub.port, s.sid), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ digit: 1 }] }),
    });
    expect(res.status).toBe(503);
  });
});
