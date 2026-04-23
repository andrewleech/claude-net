import { beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry, mirrorPlugin } from "@/hub/mirror";
import type { MirrorEventFrame } from "@/shared/types";
import { Elysia } from "elysia";

function makeFrame(
  sid: string,
  uuid: string,
  partial?: Partial<MirrorEventFrame>,
): MirrorEventFrame {
  return {
    action: "mirror_event",
    sid,
    uuid,
    kind: "user_prompt",
    ts: Date.now(),
    payload: { kind: "user_prompt", prompt: "hi", cwd: "/tmp" },
    ...partial,
  };
}

describe("MirrorRegistry", () => {
  let reg: MirrorRegistry;

  beforeEach(() => {
    reg = new MirrorRegistry({
      transcriptRing: 50,
      retentionMs: 0,
      orphanCloseMs: 0,
    });
  });

  test("createSession returns an entry with no token in the shape", () => {
    const r = reg.createSession("alice:u@h", "/home/alice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.ownerAgent).toBe("alice:u@h");
    expect(r.entry.cwd).toBe("/home/alice");
    expect(r.restored).toBe(false);
    expect(reg.sessions.size).toBe(1);
    expect(r).not.toHaveProperty("token");
  });

  test("createSession is idempotent for same sid + owner", () => {
    const r1 = reg.createSession("alice:u@h", "/home/alice", "sid-1");
    const r2 = reg.createSession("alice:u@h", "/home/alice", "sid-1");
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.restored).toBe(true);
    expect(r2.entry.sid).toBe(r1.entry.sid);
    expect(reg.sessions.size).toBe(1);
  });

  test("createSession treats a stale owner POST on an existing sid as keep-alive", () => {
    // After an MCP rename, the mirror-agent keeps re-POSTing the
    // cwd-derived owner because it doesn't track the chosen label —
    // the hub must accept those as keep-alives rather than failing
    // them, otherwise WS reconnects after a rename would wedge.
    const r1 = reg.createSession("alice:u@h", "/home/alice", "sid-1");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    r1.entry.ownerAgent = "renamed:u@h"; // simulate post-rename state
    const r2 = reg.createSession("alice:u@h", "/home/alice", "sid-1");
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.restored).toBe(true);
    // Keep the post-rename label intact.
    expect(r2.entry.ownerAgent).toBe("renamed:u@h");
  });

  test("getSession returns the entry for a known sid, 404 otherwise", () => {
    const r = reg.createSession("alice:u@h", "/home/alice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const found = reg.getSession(r.entry.sid);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entry.sid).toBe(r.entry.sid);

    const missing = reg.getSession("nope");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.status).toBe(404);
  });

  test("recordEvent appends to transcript and dedupes by uuid", () => {
    const r = reg.createSession("alice:u@h", "/home/alice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const fresh = reg.recordEvent(sid, makeFrame(sid, "u-1"));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.duplicate).toBe(false);

    const dupe = reg.recordEvent(sid, makeFrame(sid, "u-1"));
    expect(dupe.ok).toBe(true);
    if (!dupe.ok) return;
    expect(dupe.duplicate).toBe(true);
    expect(r.entry.transcript).toHaveLength(1);
  });

  test("recordEvent ring-bounds the transcript", () => {
    const tiny = new MirrorRegistry({ transcriptRing: 3, retentionMs: 0 });
    const r = tiny.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 10; i++) {
      tiny.recordEvent(r.entry.sid, makeFrame(r.entry.sid, `u-${i}`));
    }
    expect(r.entry.transcript).toHaveLength(3);
    const uuids = r.entry.transcript.map((f) => f.uuid);
    expect(uuids).toEqual(["u-7", "u-8", "u-9"]);
  });

  test("addWatcher / removeWatcher manage the watcher set", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    const ws = { send: (s: string) => sent.push(s) };
    const watcher = {
      ws,
      wsIdentity: {},
      id: "w-1",
    };
    reg.addWatcher(sid, watcher);
    expect(r.entry.watchers.size).toBe(1);
    reg.recordEvent(sid, makeFrame(sid, "u-1"));
    expect(sent).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const msg = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(msg.event).toBe("mirror:event");
    expect(msg.uuid).toBe("u-1");
    reg.removeWatcher(sid, watcher);
    expect(r.entry.watchers.size).toBe(0);
  });

  test("closeSession emits session_end event to watchers", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    reg.addWatcher(sid, {
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
      id: "w-1",
    });
    reg.closeSession(sid, "exit");
    const endEvent = sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => {
        const p = m.payload as Record<string, unknown> | undefined;
        return m.event === "mirror:event" && p?.kind === "session_end";
      });
    expect(endEvent).toBeDefined();
    const late = reg.recordEvent(sid, makeFrame(sid, "late"));
    expect(late.ok).toBe(false);
  });

  test("listOwnedBy returns summaries for owner's sessions only", () => {
    reg.createSession("a:u@h", "/a");
    reg.createSession("a:u@h", "/a2");
    reg.createSession("b:u@h", "/b");
    const mine = reg.listOwnedBy("a:u@h");
    expect(mine).toHaveLength(2);
    expect(mine.every((s) => s.owner_agent === "a:u@h")).toBe(true);
  });

  test("relayPaste sends frame and resolves when agent ack arrives", async () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    reg.setAgentConnection(sid, {
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
    });
    const pending = reg.relayPaste(sid, "hello world", "web", 5000);
    expect(sent).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.event).toBe("mirror_paste");
    expect(frame.text).toBe("hello world");
    expect(typeof frame.requestId).toBe("string");
    reg.resolvePaste(sid, frame.requestId as string, {
      path: "/tmp/claude-net/pastes/paste-abc.txt",
    });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe("/tmp/claude-net/pastes/paste-abc.txt");
  });

  test("relayPaste rejects with agent error when ack carries one", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    reg.setAgentConnection(sid, {
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
    });
    const pending = reg.relayPaste(sid, "x", "web", 5000);
    // biome-ignore lint/style/noNonNullAssertion: send collected above
    const requestId = (JSON.parse(sent[0]!) as { requestId: string }).requestId;
    reg.resolvePaste(sid, requestId, { error: "disk full" });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("disk full");
    expect(result.status).toBe(502);
  });

  test("relayPaste times out when agent never acks", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const sid = r.entry.sid;
    reg.setAgentConnection(sid, {
      ws: { send: () => {} },
      wsIdentity: {},
    });
    const result = await reg.relayPaste(sid, "x", "web", 30);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.error).toContain("did not respond");
  });

  test("relayPaste rejects when session has no connected agent", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const result = await reg.relayPaste(r.entry.sid, "x", "web", 500);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
  });

  test("dashboard broadcast fires on session lifecycle", () => {
    const events: { event: string }[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as { event: string }));
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    reg.closeSession(r.entry.sid);
    const names = events.map((e) => e.event);
    expect(names).toContain("mirror:session_started");
    expect(names).toContain("mirror:session_ended");
  });

  test("attachAgent rewrites sessions matching (host, ccPid) and broadcasts", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    // Two mirror sessions belong to CC pid 1000 on host "laptop".
    reg.createSession(
      "skydeck:alice@laptop",
      "/work/skydeck",
      "s1",
      "laptop",
      1000,
    );
    reg.createSession(
      "skydeck:alice@laptop",
      "/work/skydeck",
      "s2",
      "laptop",
      1000,
    );
    // Third session belongs to a different CC pid — must NOT be touched.
    reg.createSession(
      "skydeck:alice@laptop",
      "/work/skydeck",
      "s3",
      "laptop",
      1001,
    );

    const affected = reg.attachAgent("laptop", 1000, "yos-docs:alice@laptop");
    expect(affected.sort()).toEqual(["s1", "s2"]);

    expect(reg.sessions.get("s1")?.ownerAgent).toBe("yos-docs:alice@laptop");
    expect(reg.sessions.get("s2")?.ownerAgent).toBe("yos-docs:alice@laptop");
    expect(reg.sessions.get("s3")?.ownerAgent).toBe("skydeck:alice@laptop");

    const rename = events.find((e) => e.event === "mirror:owner_renamed");
    expect(rename).toBeDefined();
    expect(rename?.new_owner).toBe("yos-docs:alice@laptop");
    expect((rename?.sids as string[]).sort()).toEqual(["s1", "s2"]);
  });

  test("attachAgent is a no-op when no sessions match", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    reg.createSession("other:u@h", "/x", "s1", "laptop", 1000);
    const affected = reg.attachAgent("laptop", 9999, "whatever:u@h");
    expect(affected.length).toBe(0);
    expect(
      events.find((e) => e.event === "mirror:owner_renamed"),
    ).toBeUndefined();
  });

  test("attachAgent skips sessions already on the target name", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    reg.createSession("a:u@h", "/x", "s1", "laptop", 1000);
    expect(reg.attachAgent("laptop", 1000, "a:u@h").length).toBe(0);
    expect(
      events.find((e) => e.event === "mirror:owner_renamed"),
    ).toBeUndefined();
  });

  test("attachAgent bails when host or pid is missing (no mass-rename)", () => {
    reg.createSession("a:u@h", "/x", "s1", "", null);
    expect(reg.attachAgent("", 1000, "b:u@h").length).toBe(0);
    expect(reg.attachAgent("laptop", Number.NaN, "b:u@h").length).toBe(0);
    expect(reg.sessions.get("s1")?.ownerAgent).toBe("a:u@h");
  });

  test("createSession applies agentLookup when (host, ccPid) resolves", () => {
    reg.setAgentLookup((host, pid) =>
      host === "laptop" && pid === 1000 ? "yos-docs:alice@laptop" : null,
    );
    const r = reg.createSession(
      "skydeck:alice@laptop",
      "/work/skydeck",
      "s1",
      "laptop",
      1000,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The cwd-derived "skydeck" label is overridden by the MCP agent's
    // chosen name — no rename broadcast needed because the session was
    // born with the right label.
    expect(r.entry.ownerAgent).toBe("yos-docs:alice@laptop");
  });

  test("createSession skips agentLookup when cc_pid is missing", () => {
    reg.setAgentLookup(() => "should-not-apply:x@y");
    const r = reg.createSession(
      "skydeck:alice@laptop",
      "/work/skydeck",
      "s1",
      "laptop",
      null,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.ownerAgent).toBe("skydeck:alice@laptop");
  });
});

// Auto-start flow: simulate the mirror-agent POSTing to /api/mirror/session
// (what happens on `register`) and confirm the session appears without any
// `mirror_on` MCP call or token handshake.
describe("mirror auto-start via POST /api/mirror/session", () => {
  test("session shows up immediately with no token in the response", async () => {
    const reg = new MirrorRegistry({ transcriptRing: 100, retentionMs: 0 });
    const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
    const port = app.server!.port;

    try {
      const res = await fetch(`http://localhost:${port}/api/mirror/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_agent: "agent-x:u@h",
          cwd: "/workspace",
          sid: "auto-sid-1",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sid).toBe("auto-sid-1");
      expect(body.restored).toBe(false);
      expect(body).not.toHaveProperty("owner_token");
      expect(body).not.toHaveProperty("mirror_url");
      expect(reg.sessions.has("auto-sid-1")).toBe(true);

      const transcript = await fetch(
        `http://localhost:${port}/api/mirror/auto-sid-1/transcript`,
      );
      expect(transcript.status).toBe(200);
      const payload = (await transcript.json()) as Record<string, unknown>;
      expect(payload.sid).toBe("auto-sid-1");
      expect(Array.isArray(payload.transcript)).toBe(true);
    } finally {
      app.stop();
    }
  });

  test("POST /:sid/rename renames only the targeted session", async () => {
    const reg = new MirrorRegistry({ transcriptRing: 10, retentionMs: 0 });
    const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
    const port = app.server!.port;

    try {
      // Fork-session case: two mirror sessions share one owner_agent.
      // Rename must touch only the targeted row so the sibling's MCP
      // doesn't get misattributed.
      reg.createSession("skydeck:apium@host", "/skydeck", "sid-a");
      reg.createSession("skydeck:apium@host", "/skydeck", "sid-b");

      const res = await fetch(
        `http://localhost:${port}/api/mirror/sid-a/rename`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner_agent: "yos-docs:apium@host" }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.owner_agent).toBe("yos-docs:apium@host");

      expect(reg.sessions.get("sid-a")?.ownerAgent).toBe("yos-docs:apium@host");
      expect(reg.sessions.get("sid-b")?.ownerAgent).toBe("skydeck:apium@host");
    } finally {
      app.stop();
    }
  });

  test("POST /:sid/rename rejects blank owner_agent", async () => {
    const reg = new MirrorRegistry({ transcriptRing: 10, retentionMs: 0 });
    const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
    const port = app.server!.port;

    try {
      reg.createSession("x:u@h", "/x", "sid-only");
      const res = await fetch(
        `http://localhost:${port}/api/mirror/sid-only/rename`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner_agent: "" }),
        },
      );
      expect(res.status).toBe(400);
    } finally {
      app.stop();
    }
  });

  test("orphan sweep closes sessions that lost their agent + are stale", async () => {
    // orphanCloseMs: 20 → sessions unbound from agent for >20ms get closed
    // on the next sweep.
    const quick = new MirrorRegistry({
      transcriptRing: 10,
      retentionMs: 0,
      orphanCloseMs: 20,
    });
    try {
      const r = quick.createSession("alice:u@h", "/home/alice");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const sid = r.entry.sid;
      // Back-date last_event_at so it looks stale.
      r.entry.lastEventAt = new Date(Date.now() - 60_000);
      // No agent bound → meets the orphan criteria.
      // Force a sweep by calling the private method via a cast.
      (quick as unknown as { sweepOrphans: () => void }).sweepOrphans();
      expect(r.entry.closedAt).not.toBeNull();
    } finally {
      quick.stop();
    }
  });

  test("orphan sweep spares sessions with a bound agent even if stale", () => {
    const quick = new MirrorRegistry({
      transcriptRing: 10,
      retentionMs: 0,
      orphanCloseMs: 20,
    });
    try {
      const r = quick.createSession("bob:u@h", "/home/bob");
      if (!r.ok) return;
      // Bind a fake agent.
      r.entry.agent = {
        ws: { send: () => {} },
        wsIdentity: {},
      };
      r.entry.lastEventAt = new Date(Date.now() - 60_000);
      (quick as unknown as { sweepOrphans: () => void }).sweepOrphans();
      expect(r.entry.closedAt).toBeNull();
    } finally {
      quick.stop();
    }
  });
});
