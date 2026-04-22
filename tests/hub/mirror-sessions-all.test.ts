// Covers GET /api/mirror/sessions/all — returns every active session as a
// plain summary. No tokens, no click-through URL. Used by the dashboard on
// a trusted internal network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry, mirrorPlugin } from "@/hub/mirror";
import { Elysia } from "elysia";

function startHub() {
  const reg = new MirrorRegistry({ transcriptRing: 100, retentionMs: 0 });
  const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
  app.listen(0);
  // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
  const port = app.server!.port;
  return { port, stop: () => app.stop(), reg };
}

describe("GET /api/mirror/sessions/all", () => {
  let hub: ReturnType<typeof startHub>;

  beforeEach(() => {
    hub = startHub();
  });

  afterEach(() => {
    hub.stop();
  });

  test("returns empty list when no sessions exist", async () => {
    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/sessions/all`,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  test("returns summary for each session without any token fields", async () => {
    const c1 = hub.reg.createSession("a:u@h", "/a");
    const c2 = hub.reg.createSession("b:u@h", "/b");
    expect(c1.ok && c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;

    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/sessions/all`,
    );
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    const sids = list.map((s) => s.sid as string).sort();
    expect(sids).toEqual([c1.entry.sid, c2.entry.sid].sort());
    for (const s of list) {
      expect(s).not.toHaveProperty("owner_token");
      expect(s).not.toHaveProperty("mirror_url");
      expect(typeof s.owner_agent).toBe("string");
      expect(typeof s.watcher_count).toBe("number");
      expect(typeof s.transcript_len).toBe("number");
    }
  });
});
