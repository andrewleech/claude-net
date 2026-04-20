// Token role + share/revoke end-to-end against the live Elysia hub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "@/hub/mirror";
import { Elysia } from "elysia";

type Msg = Record<string, unknown>;

function startHub() {
  const reg = new MirrorRegistry({ transcriptRing: 100, retentionMs: 0 });
  let app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg, port: 0 }));
  app = wsMirrorPlugin(app, reg);
  app.listen(0);
  // biome-ignore lint/style/noNonNullAssertion: server guaranteed after listen
  const port = app.server!.port;
  return { port, stop: () => app.stop(), reg };
}

async function createSession(port: number): Promise<{
  sid: string;
  token: string;
}> {
  const r = await fetch(`http://localhost:${port}/api/mirror/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_agent: "a:u@h", cwd: "/tmp" }),
  });
  const d = (await r.json()) as {
    sid: string;
    owner_token: string;
    mirror_url: string;
  };
  return { sid: d.sid, token: d.owner_token };
}

async function share(
  port: number,
  sid: string,
  ownerToken: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(
    `http://localhost:${port}/api/mirror/${sid}/share?t=${ownerToken}`,
    { method: "POST" },
  );
  return {
    status: r.status,
    body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function revoke(
  port: number,
  sid: string,
  ownerToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(
    `http://localhost:${port}/api/mirror/${sid}/revoke?t=${ownerToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return {
    status: r.status,
    body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

function connect(url: string): Promise<{
  ws: WebSocket;
  messages: Msg[];
  wait: (p: (m: Msg) => boolean, ms?: number) => Promise<Msg>;
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
        ws,
        messages,
        wait(pred, ms = 2000) {
          for (const m of messages) if (pred(m)) return Promise.resolve(m);
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              rej(new Error("timeout"));
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
        close: () => ws.close(),
      }),
    );
    ws.addEventListener("error", (e) => reject(e));
  });
}

describe("mirror tokens + share/revoke", () => {
  let hub: ReturnType<typeof startHub>;
  beforeEach(() => {
    hub = startHub();
  });
  afterEach(() => {
    hub.stop();
  });

  test("share mints a reader token; reader can watch but not inject", async () => {
    const s = await createSession(hub.port);

    // Connect an agent so inject has somewhere to go.
    const agent = await connect(
      `ws://localhost:${hub.port}/ws/mirror/${s.sid}?t=${s.token}&as=agent`,
    );
    await agent.wait((m) => m.event === "mirror:agent_ready");

    const r = await share(hub.port, s.sid, s.token);
    expect(r.status).toBe(200);
    const readerToken = r.body.reader_token as string;
    expect(readerToken).toMatch(/^[0-9a-f]{32}$/);

    // Reader can open the WS and get init with token_type=reader.
    const watcher = await connect(
      `ws://localhost:${hub.port}/ws/mirror/${s.sid}?t=${readerToken}`,
    );
    const init = (await watcher.wait(
      (m) => m.event === "mirror:init",
    )) as Record<string, unknown>;
    expect(init.token_type).toBe("reader");

    // Reader cannot inject.
    const injectRes = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/inject?t=${readerToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      },
    );
    expect(injectRes.status).toBe(403);

    // Reader cannot share further tokens.
    const shareAgain = await share(hub.port, s.sid, readerToken);
    expect(shareAgain.status).toBe(403);

    agent.close();
    watcher.close();
  });

  test("reader token cannot open as=agent", async () => {
    const s = await createSession(hub.port);
    const r = await share(hub.port, s.sid, s.token);
    const readerToken = r.body.reader_token as string;
    const conn = await connect(
      `ws://localhost:${hub.port}/ws/mirror/${s.sid}?t=${readerToken}&as=agent`,
    );
    const err = (await conn.wait((m) => m.event === "error")) as Record<
      string,
      unknown
    >;
    expect(String(err.message)).toContain("owner token");
    conn.close();
  });

  test("revoke kicks the watcher holding that token", async () => {
    const s = await createSession(hub.port);
    const r = await share(hub.port, s.sid, s.token);
    const readerToken = r.body.reader_token as string;

    const watcher = await connect(
      `ws://localhost:${hub.port}/ws/mirror/${s.sid}?t=${readerToken}`,
    );
    await watcher.wait((m) => m.event === "mirror:init");

    const rev = await revoke(hub.port, s.sid, s.token, { token: readerToken });
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(1);

    // Reader can no longer auth; reconnect attempt gets an error frame.
    const reconnect = await connect(
      `ws://localhost:${hub.port}/ws/mirror/${s.sid}?t=${readerToken}`,
    );
    const err = (await reconnect.wait((m) => m.event === "error")) as Record<
      string,
      unknown
    >;
    expect(String(err.message)).toContain("Invalid token");

    watcher.close();
    reconnect.close();
  });

  test("revoke all kicks both owner and reader", async () => {
    const s = await createSession(hub.port);
    const r = await share(hub.port, s.sid, s.token);
    const readerToken = r.body.reader_token as string;

    const rev = await revoke(hub.port, s.sid, s.token, { all: true });
    expect(rev.status).toBe(200);
    expect((rev.body.revoked as number) >= 2).toBe(true);

    // Both tokens are now invalid.
    const attempt = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/transcript?t=${readerToken}`,
    );
    expect(attempt.status).toBe(403);
    const ownerAttempt = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/transcript?t=${s.token}`,
    );
    expect(ownerAttempt.status).toBe(403);
  });

  test("GET /tokens lists active tokens (owner-only)", async () => {
    const s = await createSession(hub.port);
    await share(hub.port, s.sid, s.token);
    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/${s.sid}/tokens?t=${s.token}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      tokens: Array<{ type: string; revoked_at: string | null }>;
    };
    expect(body.tokens.length).toBe(2);
    const types = body.tokens.map((t) => t.type).sort();
    expect(types).toEqual(["owner", "reader"]);
  });
});
