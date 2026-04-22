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

  test("createSession rejects a different owner claiming an existing sid", () => {
    reg.createSession("alice:u@h", "/home/alice", "sid-1");
    const r2 = reg.createSession("bob:u@h", "/home/bob", "sid-1");
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toContain("different owner");
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

  test("renameOwner rewrites every matching session and broadcasts", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    const a = reg.createSession("skydeck:alice@host", "/work/skydeck");
    const b = reg.createSession("skydeck:alice@host", "/work/skydeck");
    const c = reg.createSession("other:alice@host", "/work/other");
    expect(a.ok && b.ok && c.ok).toBe(true);

    const affected = reg.renameOwner(
      "skydeck:alice@host",
      "thisisnew:alice@host",
    );
    expect(affected.length).toBe(2);

    // Both sessions in /work/skydeck got the new owner; the other cwd
    // is untouched.
    for (const entry of reg.sessions.values()) {
      if (entry.cwd === "/work/skydeck") {
        expect(entry.ownerAgent).toBe("thisisnew:alice@host");
      } else {
        expect(entry.ownerAgent).toBe("other:alice@host");
      }
    }

    const rename = events.find((e) => e.event === "mirror:owner_renamed");
    expect(rename).toBeDefined();
    expect(rename?.old_owner).toBe("skydeck:alice@host");
    expect(rename?.new_owner).toBe("thisisnew:alice@host");
    expect((rename?.sids as string[]).length).toBe(2);
  });

  test("renameOwner is a no-op when no sessions match", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    reg.createSession("other:u@h", "/x");
    const affected = reg.renameOwner("missing:u@h", "whatever:u@h");
    expect(affected.length).toBe(0);
    expect(
      events.find((e) => e.event === "mirror:owner_renamed"),
    ).toBeUndefined();
  });

  test("renameOwner with identical names does nothing", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    reg.createSession("a:u@h", "/x");
    expect(reg.renameOwner("a:u@h", "a:u@h").length).toBe(0);
    expect(
      events.find((e) => e.event === "mirror:owner_renamed"),
    ).toBeUndefined();
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
