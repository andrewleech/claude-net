import { beforeEach, describe, expect, test } from "bun:test";
import {
  MirrorRegistry,
  type SessionWatcher,
  _resetSessionCreateLimiterForTest,
  mirrorPlugin,
} from "@/hub/mirror";
import { Scheduler } from "@/hub/scheduler";
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
      neverActiveMs: 0,
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
    // After an MCP rename the mirror-agent keeps re-POSTing the
    // cwd-derived owner because it doesn't track the chosen label —
    // the hub must accept those as keep-alives, otherwise WS reconnects
    // after a rename would wedge.
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

  test("createSession keeps the renamed owner on a same-sid keep-alive re-POST", () => {
    // The hub-side entry was renamed after creation (MCP-join / dashboard
    // rename); the daemon re-POSTs its original cwd-derived owner. The
    // re-POST is accepted as an idempotent keep-alive and the existing
    // (post-rename) label is preserved rather than reverted.
    const r1 = reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-h1",
      "laptop",
      4815,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    r1.entry.ownerAgent = "renamed-by-mcp:u@h"; // MCP rename happened
    const r2 = reg.createSession(
      "alice:u@h", // stale owner the agent is re-POSTing
      "/home/alice",
      "sid-h1",
      "laptop",
      4815,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.restored).toBe(true);
    // Existing post-rename label preserved.
    expect(r2.entry.ownerAgent).toBe("renamed-by-mcp:u@h");
  });

  test("createSession on a different host coexists at the same sid", () => {
    // Cross-host UUID collisions are real (resumed sessions, copied
    // JSONLs, the rare RNG dup). The hub keys sessions by `(host, sid)`
    // so two hosts can each own an entry with the same sid without
    // any wedge. Each entry tracks its own watchers + transcript.
    const r1 = reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-h2",
      "laptop",
      4815,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = reg.createSession(
      "other:u@h",
      "/home/other",
      "sid-h2",
      "different-host",
      9001,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.restored).toBe(false);
    // Both entries are present; `getSession(sid)` without a host hint
    // sees them as ambiguous and returns 409.
    const ambig = reg.getSession("sid-h2");
    expect(ambig.ok).toBe(false);
    if (ambig.ok) return;
    expect(ambig.status).toBe(409);
    expect(ambig.hosts?.sort()).toEqual(["different-host", "laptop"]);
    // Disambiguated lookups return the right entry per host.
    const onLaptop = reg.getSession("sid-h2", "laptop");
    expect(onLaptop.ok && onLaptop.entry.ownerAgent).toBe("alice:u@h");
    const onOther = reg.getSession("sid-h2", "different-host");
    expect(onOther.ok && onOther.entry.ownerAgent).toBe("other:u@h");
    // listAll surfaces both entries so the dashboard's session list
    // can render two distinct rows under their respective host groups.
    const summaries = reg.listAll().filter((s) => s.sid === "sid-h2");
    expect(summaries.map((s) => s.host).sort()).toEqual([
      "different-host",
      "laptop",
    ]);
  });

  test("relayInject scoped per (host, sid) when host hint supplied", () => {
    // The two-host collision case must allow inject to target the
    // right entry; without the host hint the resolver returns 404
    // (ambiguous) and the caller gets a clean failure rather than
    // a silent cross-host inject.
    const sent: string[] = [];
    reg.createSession("a:u@h", "/a", "sid-x", "laptop", 1);
    reg.createSession("b:u@h", "/b", "sid-x", "desktop", 2);
    reg.setAgentConnection(
      "sid-x",
      {
        ws: { send: (s: string) => sent.push(`laptop:${s}`) },
        wsIdentity: {},
        close: () => {},
      },
      "laptop",
    );
    reg.setAgentConnection(
      "sid-x",
      {
        ws: { send: (s: string) => sent.push(`desktop:${s}`) },
        wsIdentity: {},
        close: () => {},
      },
      "desktop",
    );
    // Ambiguous: no host hint, sid alone matches two entries — 404.
    const ambig = reg.relayInject("sid-x", "hi", "web");
    expect(ambig.ok).toBe(false);
    // Disambiguated: explicit host routes to that entry only.
    const r1 = reg.relayInject("sid-x", "to-laptop", "web", "laptop");
    expect(r1.ok).toBe(true);
    expect(sent.some((s) => s.startsWith("laptop:"))).toBe(true);
    expect(sent.some((s) => s.startsWith("desktop:"))).toBe(false);
  });

  test("createSession keeps the existing owner on a same-sid re-POST (no relabel, no 409)", () => {
    // A re-POST for an existing (host, sid) is the same session — accepted
    // as an idempotent keep-alive regardless of the incoming owner or
    // ccPid, so a renamed session can never wedge on "owner mismatch".
    // The incoming owner is ignored, so a stray peer can't relabel it.
    const r1 = reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-h3",
      "laptop",
      4815,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = reg.createSession(
      "evil:u@h",
      "/home/alice",
      "sid-h3",
      "laptop",
      9999,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.restored).toBe(true);
    expect(r2.entry.ownerAgent).toBe("alice:u@h");
  });

  test("createSession dedupes zombie placeholders sharing (host, ccPid)", () => {
    // An older-bundle agent that mints fresh UUIDs per probe will pile
    // up zombie entries on the hub — the sweeper can't touch them
    // because they're agent-bound. When a new session POST arrives with
    // the same (host, ccPid) but a different sid AND the existing
    // session has zero transcript, we close the existing zombie.
    const r1 = reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-z1",
      "laptop",
      9001,
    );
    expect(r1.ok).toBe(true);
    expect(reg.hasSession("sid-z1")).toBe(true);
    const r2 = reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-z2",
      "laptop",
      9001,
    );
    expect(r2.ok).toBe(true);
    // Zombie closed and dropped.
    expect(reg.hasSession("sid-z1")).toBe(false);
    // New session kept.
    expect(reg.hasSession("sid-z2")).toBe(true);
  });

  test("createSession dedup leaves entries with non-empty transcript alone", () => {
    // Sanity: a real session (any transcript content) is NOT closed by
    // the zombie dedup, even when a sibling sid arrives for the same
    // (host, ccPid). Only zero-transcript placeholders are sweepable.
    const r1 = reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-real",
      "laptop",
      9002,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // Simulate "a real event has flowed".
    r1.entry.transcript.push({
      action: "mirror_event",
      sid: "sid-real",
      uuid: "u-1",
      ts: 0,
      kind: "user_prompt",
      payload: { kind: "user_prompt", prompt: "hi", cwd: "/home/alice" },
    });
    const r2 = reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-newcomer",
      "laptop",
      9002,
    );
    expect(r2.ok).toBe(true);
    expect(reg.hasSession("sid-real")).toBe(true);
    expect(reg.hasSession("sid-newcomer")).toBe(true);
  });

  test("createSession dedup leaves sessions on a different ccPid alone", () => {
    reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-other-ccpid",
      "laptop",
      1234,
    );
    reg.createSession("alice:u@h", "/home/alice", "sid-new", "laptop", 5678);
    expect(reg.hasSession("sid-other-ccpid")).toBe(true);
    expect(reg.hasSession("sid-new")).toBe(true);
  });

  test("createSession dedup leaves sessions on a different host alone", () => {
    reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-other-host",
      "desktop",
      9003,
    );
    reg.createSession("alice:u@h", "/home/alice", "sid-laptop", "laptop", 9003);
    expect(reg.hasSession("sid-other-host")).toBe(true);
    expect(reg.hasSession("sid-laptop")).toBe(true);
  });

  test("createSession keeps existing owner on same-sid re-POST even when stored ccPid is null", () => {
    // This is the exact wedge the old 409 caused: a session created without
    // a ccPid (pre-CC_PID hook) then renamed on the hub. The daemon keeps
    // re-POSTing its cwd-derived owner; identity can't be proven by ccPid.
    // It must still succeed (keep-alive) with the renamed owner preserved,
    // rather than 409-ing forever and showing offline while Claude runs.
    const r1 = reg.createSession(
      "alice:u@h",
      "/home/alice",
      "sid-h4",
      "laptop",
      null,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    r1.entry.ownerAgent = "renamed-by-mcp:u@h"; // hub-side rename
    const r2 = reg.createSession(
      "alice:u@h", // daemon still re-POSTs the stale cwd-derived owner
      "/home/alice",
      "sid-h4",
      "laptop",
      null,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.entry.ownerAgent).toBe("renamed-by-mcp:u@h");
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

  test("activityState transitions: fresh session is awaiting_input", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.activityState).toBe("awaiting_input");
  });

  test("activityState: user_prompt → busy, Stop → awaiting_input", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    reg.recordEvent(sid, makeFrame(sid, "u-prompt"));
    expect(r.entry.activityState).toBe("busy");
    reg.recordEvent(
      sid,
      makeFrame(sid, "u-stop", {
        kind: "assistant_message",
        payload: {
          kind: "assistant_message",
          text: "done",
          stop_reason: "end_turn",
        },
      }),
    );
    expect(r.entry.activityState).toBe("awaiting_input");
  });

  test("activityState: SubagentStop preserves busy state", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    reg.recordEvent(sid, makeFrame(sid, "u-prompt"));
    expect(r.entry.activityState).toBe("busy");
    reg.recordEvent(
      sid,
      makeFrame(sid, "u-sub-stop", {
        kind: "assistant_message",
        payload: {
          kind: "assistant_message",
          text: "sub done",
          stop_reason: "end_turn",
          subagent: true,
        },
      }),
    );
    // Parent agent still busy — subagent stop is a no-op.
    expect(r.entry.activityState).toBe("busy");
  });

  test("activityState: SubagentStop while already awaiting stays awaiting", () => {
    // A subagent can finish AFTER the parent has already stopped (e.g. a
    // background Task whose stream lags the top-level Stop). The dot must
    // not flicker back to busy in that window.
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    reg.recordEvent(
      sid,
      makeFrame(sid, "u-stop", {
        kind: "assistant_message",
        payload: {
          kind: "assistant_message",
          text: "done",
          stop_reason: "end_turn",
        },
      }),
    );
    expect(r.entry.activityState).toBe("awaiting_input");
    reg.recordEvent(
      sid,
      makeFrame(sid, "u-sub-late", {
        kind: "assistant_message",
        payload: {
          kind: "assistant_message",
          text: "sub late",
          stop_reason: "end_turn",
          subagent: true,
        },
      }),
    );
    expect(r.entry.activityState).toBe("awaiting_input");
  });

  test("activityState: restored session preserves prior state", () => {
    // After a transient agent disconnect we re-bind the same sid; the
    // stored activityState should carry across so the dot doesn't reset
    // to a misleading default.
    const r = reg.createSession("a:u@h", "/a", "sid-restore");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    reg.recordEvent(r.entry.sid, makeFrame(r.entry.sid, "u-prompt"));
    expect(r.entry.activityState).toBe("busy");
    const r2 = reg.createSession("a:u@h", "/a", "sid-restore");
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.restored).toBe(true);
    expect(r2.entry.activityState).toBe("busy");
  });

  test("activityState: notification flips to awaiting_input", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    reg.recordEvent(sid, makeFrame(sid, "u-prompt"));
    expect(r.entry.activityState).toBe("busy");
    reg.recordEvent(
      sid,
      makeFrame(sid, "u-note", {
        kind: "notification",
        payload: { kind: "notification", text: "Permission required" },
      }),
    );
    expect(r.entry.activityState).toBe("awaiting_input");
  });

  test("activity broadcast carries activity_state to dashboards", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const dashSent: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((evt) => dashSent.push(evt));
    reg.recordEvent(
      sid,
      makeFrame(sid, "u-stop", {
        kind: "assistant_message",
        payload: {
          kind: "assistant_message",
          text: "done",
          stop_reason: "end_turn",
        },
      }),
    );
    const activity = dashSent.find((m) => m.event === "mirror:activity");
    expect(activity).toBeDefined();
    expect(activity?.activity_state).toBe("awaiting_input");
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

  test("relayFetchFile sends frame and resolves with the file bytes", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    reg.setAgentConnection(sid, {
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
    });
    const pending = reg.relayFetchFile(
      sid,
      "/a/assets/x.png",
      8 * 1024 * 1024,
      "web",
      5000,
    );
    expect(sent).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.event).toBe("mirror_fetch_file");
    expect(frame.path).toBe("/a/assets/x.png");
    expect(typeof frame.requestId).toBe("string");
    reg.resolveFetchFile(sid, frame.requestId as string, {
      data: Buffer.from("png-bytes").toString("base64"),
      media_type: "image/png",
      bytes: 9,
      name: "x.png",
    });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.media_type).toBe("image/png");
    expect(result.file.name).toBe("x.png");
    expect(Buffer.from(result.file.data, "base64").toString()).toBe(
      "png-bytes",
    );
  });

  test("relayFetchFile rejects 403 when the agent refuses the path", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    reg.setAgentConnection(sid, {
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
    });
    const pending = reg.relayFetchFile(sid, "/etc/shadow", 1024, "web", 5000);
    // biome-ignore lint/style/noNonNullAssertion: send collected above
    const requestId = (JSON.parse(sent[0]!) as { requestId: string }).requestId;
    reg.resolveFetchFile(sid, requestId, {
      error: "File is not available for this session.",
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toContain("not available");
  });

  test("relayFetchFile times out when the agent never replies", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const sid = r.entry.sid;
    reg.setAgentConnection(sid, { ws: { send: () => {} }, wsIdentity: {} });
    const result = await reg.relayFetchFile(sid, "/a/x", 1024, "web", 30);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
  });

  test("relayFetchFile rejects 503 with no connected agent", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const result = await reg.relayFetchFile(
      r.entry.sid,
      "/a/x",
      1024,
      "web",
      500,
    );
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

  // ── (host, cc_pid) join: attachAgent + agentLookup ─────────────────

  test("attachAgent rewrites sessions matching (host, ccPid) and broadcasts", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    // Two sessions belong to CC pid 1000 on host "laptop". This is the
    // legitimate "fork" shape (e.g. /clear or /compact starts a new
    // session_id with the same ccPid) — both have real transcript
    // content, so the zombie-dedup in createSession leaves them alone.
    const r1 = reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s1",
      "laptop",
      1000,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    r1.entry.transcript.push({
      action: "mirror_event",
      sid: "s1",
      uuid: "u1",
      ts: 0,
      kind: "user_prompt",
      payload: { kind: "user_prompt", prompt: "x", cwd: "/work/sky" },
    });
    const r2 = reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s2",
      "laptop",
      1000,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    r2.entry.transcript.push({
      action: "mirror_event",
      sid: "s2",
      uuid: "u2",
      ts: 0,
      kind: "user_prompt",
      payload: { kind: "user_prompt", prompt: "y", cwd: "/work/sky" },
    });
    // Third belongs to a different CC pid — must NOT be touched.
    reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s3",
      "laptop",
      1001,
    );

    const affected = reg.attachAgent("laptop", 1000, "yos:alice@laptop");
    expect(affected.sort()).toEqual(["s1", "s2"]);
    const g1 = reg.getSession("s1");
    expect(g1.ok && g1.entry.ownerAgent).toBe("yos:alice@laptop");
    const g2 = reg.getSession("s2");
    expect(g2.ok && g2.entry.ownerAgent).toBe("yos:alice@laptop");
    const g3 = reg.getSession("s3");
    expect(g3.ok && g3.entry.ownerAgent).toBe("skydeck:alice@laptop");

    const rename = events.find((e) => e.event === "mirror:owner_renamed");
    expect(rename).toBeDefined();
    expect(rename?.new_owner).toBe("yos:alice@laptop");
    expect((rename?.sids as string[]).sort()).toEqual(["s1", "s2"]);
  });

  test("attachAgent is a no-op when no sessions match", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    reg.createSession("other:u@h", "/x", "s1", "laptop", 1000);
    expect(reg.attachAgent("laptop", 9999, "x:u@h").length).toBe(0);
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

  test("attachAgent bails on empty host or non-finite ccPid", () => {
    reg.createSession("a:u@h", "/x", "s1", "", null);
    expect(reg.attachAgent("", 1000, "b:u@h").length).toBe(0);
    expect(reg.attachAgent("laptop", Number.NaN, "b:u@h").length).toBe(0);
    const ga = reg.getSession("s1");
    expect(ga.ok && ga.entry.ownerAgent).toBe("a:u@h");
  });

  test("createSession applies agentLookup at session birth", () => {
    reg.setAgentLookup((host, pid) =>
      host === "laptop" && pid === 1000 ? "yos:alice@laptop" : null,
    );
    const r = reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s1",
      "laptop",
      1000,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Cwd-derived "skydeck" overridden by the looked-up MCP name.
    expect(r.entry.ownerAgent).toBe("yos:alice@laptop");
  });

  test("createSession skips agentLookup when ccPid is null", () => {
    reg.setAgentLookup(() => "should-not-apply:x@y");
    const r = reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s1",
      "laptop",
      null,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.ownerAgent).toBe("skydeck:alice@laptop");
  });

  test("createSession on existing session re-runs lookup when ccPid changes (--continue)", () => {
    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    reg.setAgentLookup((host, pid) =>
      host === "laptop" && pid === 2222 ? "yos:alice@laptop" : null,
    );

    // Original session under pid 1111 — no agent registered for that pid.
    reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s1",
      "laptop",
      1111,
    );
    const gs = reg.getSession("s1");
    expect(gs.ok && gs.entry.ownerAgent).toBe("skydeck:alice@laptop");

    // --continue: same sid, new pid. The lookup now resolves.
    const r = reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s1",
      "laptop",
      2222,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.ownerAgent).toBe("yos:alice@laptop");
    expect(r.entry.ccPid).toBe(2222);

    const rename = events.find((e) => e.event === "mirror:owner_renamed");
    expect(rename).toBeDefined();
    expect(rename?.new_owner).toBe("yos:alice@laptop");
    expect(rename?.sids as string[]).toEqual(["s1"]);
  });

  test("createSession on existing session with same (host, ccPid) does not re-broadcast", () => {
    reg.setAgentLookup(() => "yos:alice@laptop");
    reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s1",
      "laptop",
      1111,
    );

    const events: Record<string, unknown>[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    // Re-POST with identical identity: keep-alive only, no rename event.
    reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "s1",
      "laptop",
      1111,
    );
    expect(
      events.find((e) => e.event === "mirror:owner_renamed"),
    ).toBeUndefined();
  });

  // ── agent-state broadcast lifecycle ────────────────────────────────

  test("setAgentConnection broadcasts mirror:agent_state with attached=true", () => {
    const events: Record<string, unknown>[] = [];
    const r = reg.createSession("a:u@h", "/a", "s1");
    expect(r.ok).toBe(true);
    const identity = {};
    const watcher = { id: "w1", ws: { send: () => {} }, wsIdentity: {} };
    reg.addWatcher("s1", watcher as SessionWatcher);
    reg.setDashboardBroadcast((e) => events.push(e as Record<string, unknown>));
    const sent: string[] = [];
    watcher.ws.send = (s: string) => sent.push(s);
    reg.setAgentConnection("s1", {
      ws: { send: () => {} },
      wsIdentity: identity,
    });
    const parsed = sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const stateEvt = parsed.find((e) => e.event === "mirror:agent_state");
    expect(stateEvt).toBeDefined();
    expect(stateEvt?.attached).toBe(true);
  });

  test("handleAgentDisconnect broadcasts mirror:agent_state with attached=false", () => {
    const r = reg.createSession("a:u@h", "/a", "s1");
    expect(r.ok).toBe(true);
    const identity = {};
    const sent: string[] = [];
    const watcher = {
      id: "w1",
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
    };
    reg.addWatcher("s1", watcher as SessionWatcher);
    reg.setAgentConnection("s1", {
      ws: { send: () => {} },
      wsIdentity: identity,
    });
    sent.length = 0;
    reg.handleAgentDisconnect(identity);
    const parsed = sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const stateEvt = parsed.find((e) => e.event === "mirror:agent_state");
    expect(stateEvt).toBeDefined();
    expect(stateEvt?.attached).toBe(false);
  });

  test("idempotent setAgentConnection does not double-broadcast", () => {
    const r = reg.createSession("a:u@h", "/a", "s1");
    expect(r.ok).toBe(true);
    const identity = {};
    const sent: string[] = [];
    const watcher = {
      id: "w1",
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
    };
    reg.addWatcher("s1", watcher as SessionWatcher);
    const conn = { ws: { send: () => {} }, wsIdentity: identity };
    reg.setAgentConnection("s1", conn);
    sent.length = 0;
    // Re-attach with same connection: no state change, no broadcast.
    reg.setAgentConnection("s1", conn);
    expect(
      sent.filter(
        (s) =>
          (JSON.parse(s) as Record<string, unknown>).event ===
          "mirror:agent_state",
      ).length,
    ).toBe(0);
  });

  test("mirror:init payload reflects current agent_attached state", () => {
    const r = reg.createSession("a:u@h", "/a", "s1");
    expect(r.ok).toBe(true);

    // No agent connected yet.
    const entry = reg.getSession("s1");
    expect(entry.ok && entry.entry.agent).toBeNull();

    reg.setAgentConnection("s1", {
      ws: { send: () => {} },
      wsIdentity: {},
    });
    const e2 = reg.getSession("s1");
    expect(e2.ok && e2.entry.agent).not.toBeNull();
  });

  // ── broadcastStatusline + lastStatusline on init ────────────────────

  test("broadcastStatusline fans out to all current watchers", () => {
    const r = reg.createSession("a:u@h", "/a", "s1");
    expect(r.ok).toBe(true);
    const sent1: string[] = [];
    const sent2: string[] = [];
    const w1 = {
      id: "w1",
      ws: { send: (s: string) => sent1.push(s) },
      wsIdentity: {},
    };
    const w2 = {
      id: "w2",
      ws: { send: (s: string) => sent2.push(s) },
      wsIdentity: {},
    };
    reg.addWatcher("s1", w1 as SessionWatcher);
    reg.addWatcher("s1", w2 as SessionWatcher);
    reg.broadcastStatusline("s1", {
      ctx_pct: 42,
      ctx_tokens: 84_000,
      ctx_window: 200_000,
      ts: 12345,
    });
    for (const sent of [sent1, sent2]) {
      const msgs = sent.map((s) => JSON.parse(s) as Record<string, unknown>);
      const sl = msgs.find((m) => m.event === "mirror:statusline");
      expect(sl).toBeDefined();
      expect(sl?.ctx_pct).toBe(42);
    }
  });

  test("watcher attaching after broadcast receives lastStatusline in init", () => {
    const r = reg.createSession("a:u@h", "/a", "s1");
    expect(r.ok).toBe(true);
    reg.broadcastStatusline("s1", {
      ctx_pct: 75,
      ctx_tokens: 150_000,
      ctx_window: 200_000,
      ts: 99999,
    });

    // buildInitMessage is tested indirectly: check the entry's lastStatusline
    // which is what the WS handler embeds in the init response.
    const entry = reg.getSession("s1");
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.entry.lastStatusline).toBeDefined();
    expect(entry.entry.lastStatusline?.ctx_pct).toBe(75);
    expect(entry.entry.lastStatusline?.ctx_tokens).toBe(150_000);
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
      expect(reg.hasSession("auto-sid-1")).toBe(true);

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

  test("POST /session returns canonical owner and never 409s a renamed re-POST", async () => {
    const reg = new MirrorRegistry({ transcriptRing: 100, retentionMs: 0 });
    const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
    const port = app.server!.port;
    try {
      const mk = (owner: string) =>
        fetch(`http://localhost:${port}/api/mirror/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            owner_agent: owner,
            cwd: "/workspace",
            sid: "own-1",
            host: "h",
            cc_pid: null,
          }),
        });

      let res = await mk("proj:u@h");
      expect(res.status).toBe(200);
      let body = (await res.json()) as Record<string, unknown>;
      expect(body.owner_agent).toBe("proj:u@h");

      // Hub-side rename (MCP join / dashboard rename).
      const found = reg.getSession("own-1", "h");
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      found.entry.ownerAgent = "renamed:u@h";

      // Daemon re-POSTs its stale cwd-derived owner: must NOT 409, and the
      // response carries the canonical owner so the daemon can adopt it.
      res = await mk("proj:u@h");
      expect(res.status).toBe(200);
      body = (await res.json()) as Record<string, unknown>;
      expect(body.restored).toBe(true);
      expect(body.owner_agent).toBe("renamed:u@h");
    } finally {
      app.stop();
    }
  });

  test("re-POST with an existing sid bypasses the rate limiter", async () => {
    // Mirror-agent restart + post-install hook burst can fire dozens of
    // POST /session calls for known sids in quick succession. The hub
    // should treat those as idempotent and skip the rate limit; the
    // limit only exists to throttle truly new sessions.
    _resetSessionCreateLimiterForTest();
    const reg = new MirrorRegistry({ transcriptRing: 10, retentionMs: 0 });
    const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
    const port = app.server!.port;

    try {
      // Seed an existing session so re-POSTs land in the restored branch.
      reg.createSession("agent-x:u@h", "/workspace", "known-sid");

      // Slam 100 POSTs for that sid — far above the 30/5min default budget.
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          fetch(`http://localhost:${port}/api/mirror/session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner_agent: "agent-x:u@h",
              cwd: "/workspace",
              sid: "known-sid",
            }),
          }),
        ),
      );
      // None should 429 — they're all idempotent restored returns.
      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 200)).toBe(true);
    } finally {
      app.stop();
    }
  });

  test("rate limiter still applies to bursts of new sids", async () => {
    // Sanity check that the bypass only fires for known sids: a flood of
    // distinct sids must still be capped by the limiter so abuse is
    // throttled (default 200/5min — see SESSION_CREATE_MAX). Send well
    // past the cap so the test stays robust if the default is bumped
    // moderately upward in future.
    _resetSessionCreateLimiterForTest();
    const reg = new MirrorRegistry({ transcriptRing: 10, retentionMs: 0 });
    const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
    const port = app.server!.port;

    try {
      const results = await Promise.all(
        Array.from({ length: 250 }, (_, i) =>
          fetch(`http://localhost:${port}/api/mirror/session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner_agent: "agent-x:u@h",
              cwd: "/workspace",
              sid: `new-sid-${i}`,
            }),
          }),
        ),
      );
      const statusCount = results.reduce<Record<number, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});
      // Expect at least one 200 (under the cap) and at least one 429 (past it).
      expect((statusCount[200] ?? 0) > 0).toBe(true);
      expect((statusCount[429] ?? 0) > 0).toBe(true);
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

      const ga = reg.getSession("sid-a");
      expect(ga.ok && ga.entry.ownerAgent).toBe("yos-docs:apium@host");
      const gb = reg.getSession("sid-b");
      expect(gb.ok && gb.entry.ownerAgent).toBe("skydeck:apium@host");
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

  test("orphan sweep closes but retains stale sessions (no agent)", async () => {
    // orphanCloseMs: 20 → sessions whose last event is >20ms ago get
    // closed on the next sweep. The session stays in the map as a closed
    // gravestone (reconnectable, dimmed in the sidebar) for the retention
    // window rather than vanishing — closeSession, not closeAndDrop.
    const quick = new MirrorRegistry({
      transcriptRing: 10,
      retentionMs: 60_000,
      orphanCloseMs: 20,
      neverActiveMs: 0,
    });
    try {
      const r = quick.createSession("alice:u@h", "/home/alice");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const sid = r.entry.sid;
      r.entry.lastEventAt = new Date(Date.now() - 60_000);
      (quick as unknown as { sweepOrphans: () => void }).sweepOrphans();
      // Retained as a closed gravestone, not dropped.
      expect(quick.hasSession(sid)).toBe(true);
      expect(r.entry.closedAt).not.toBeNull();
    } finally {
      quick.stop();
    }
  });

  test("orphan sweep spares stale sessions with a bound agent", () => {
    // Bun closes WSes silent for 120s, so a truly dead agent loses its
    // binding within ~2 min and becomes orphan-sweepable then. Until
    // then, a bound WS proves the agent is alive — possibly hosting an
    // idle CC session whose user just stopped typing. Sweeping those
    // would tear down legitimate sidebar entries.
    const quick = new MirrorRegistry({
      transcriptRing: 10,
      retentionMs: 60_000,
      orphanCloseMs: 20,
      neverActiveMs: 0,
    });
    try {
      const r = quick.createSession("bob:u@h", "/home/bob");
      if (!r.ok) return;
      const sid = r.entry.sid;
      r.entry.agent = {
        ws: { send: () => {} },
        wsIdentity: {},
      };
      r.entry.lastEventAt = new Date(Date.now() - 60_000);
      (quick as unknown as { sweepOrphans: () => void }).sweepOrphans();
      expect(quick.hasSession(sid)).toBe(true);
    } finally {
      quick.stop();
    }
  });

  test("never-active sweep drops probe-orphaned sessions (no agent)", () => {
    const quick = new MirrorRegistry({
      transcriptRing: 10,
      retentionMs: 60_000,
      orphanCloseMs: 0,
      neverActiveMs: 20,
    });
    try {
      const r = quick.createSession("probe:u@h", "/home/probe");
      if (!r.ok) return;
      const sid = r.entry.sid;
      // Back-date BOTH createdAt and lastEventAt — never-active sweep
      // looks for entries where these are equal and the age beats the cutoff.
      const longAgo = new Date(Date.now() - 60_000);
      r.entry.createdAt = longAgo;
      r.entry.lastEventAt = longAgo;
      // No agent bound — simulates probe-orphaned-at-birth.
      (quick as unknown as { sweepNeverActive: () => void }).sweepNeverActive();
      expect(quick.hasSession(sid)).toBe(false);
    } finally {
      quick.stop();
    }
  });

  test("never-active sweep spares bound sessions even with no events ever", () => {
    // Idle CC session: agent process alive, user hasn't typed yet.
    // createdAt == lastEventAt and arbitrarily old — but the bound
    // agent WS proves the session is legitimately live.
    const quick = new MirrorRegistry({
      transcriptRing: 10,
      retentionMs: 60_000,
      orphanCloseMs: 0,
      neverActiveMs: 20,
    });
    try {
      const r = quick.createSession("idle:u@h", "/home/idle");
      if (!r.ok) return;
      const sid = r.entry.sid;
      const longAgo = new Date(Date.now() - 60_000);
      r.entry.createdAt = longAgo;
      r.entry.lastEventAt = longAgo;
      r.entry.agent = {
        ws: { send: () => {} },
        wsIdentity: {},
      };
      (quick as unknown as { sweepNeverActive: () => void }).sweepNeverActive();
      expect(quick.hasSession(sid)).toBe(true);
    } finally {
      quick.stop();
    }
  });

  test("never-active sweep spares sessions that DID receive an event", () => {
    const quick = new MirrorRegistry({
      transcriptRing: 10,
      retentionMs: 60_000,
      orphanCloseMs: 0,
      neverActiveMs: 20,
    });
    try {
      const r = quick.createSession("active:u@h", "/home/active");
      if (!r.ok) return;
      const sid = r.entry.sid;
      // Created long ago AND received at least one event: lastEventAt > createdAt.
      r.entry.createdAt = new Date(Date.now() - 60_000);
      r.entry.lastEventAt = new Date(Date.now() - 30_000);
      (quick as unknown as { sweepNeverActive: () => void }).sweepNeverActive();
      expect(quick.hasSession(sid)).toBe(true);
    } finally {
      quick.stop();
    }
  });

  test("closeAndDrop removes the session from the map immediately", () => {
    const quick = new MirrorRegistry({
      transcriptRing: 10,
      retentionMs: 60_000, // would otherwise hold the entry for 60s
      orphanCloseMs: 0,
      neverActiveMs: 0,
    });
    try {
      const r = quick.createSession("c:u@h", "/home/c");
      if (!r.ok) return;
      const sid = r.entry.sid;
      quick.closeAndDrop(sid);
      expect(quick.hasSession(sid)).toBe(false);
    } finally {
      quick.stop();
    }
  });
});

describe("schedule-inject routes", () => {
  function setup() {
    const reg = new MirrorRegistry({ transcriptRing: 10, retentionMs: 0 });
    const fired: string[] = [];
    const scheduler = new Scheduler({
      fireInject: (_sid, text) => {
        fired.push(text);
        return { ok: true };
      },
    });
    const app = new Elysia().use(
      mirrorPlugin({ mirrorRegistry: reg, scheduler }),
    );
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
    const port = app.server!.port;
    const r = reg.createSession("agent-x:u@h", "/workspace", "sched-sid");
    if (!r.ok) throw new Error("session create failed");
    return { reg, scheduler, app, port, fired };
  }

  test("queues an inject and lists it as pending", async () => {
    const { app, port, scheduler } = setup();
    try {
      const res = await fetch(
        `http://localhost:${port}/api/mirror/sched-sid/schedule-inject`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "later", delayMs: 60_000 }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.id).toBe("string");
      expect(typeof body.fireAt).toBe("number");

      const listRes = await fetch(
        `http://localhost:${port}/api/mirror/sched-sid/scheduled`,
      );
      const list = (await listRes.json()) as {
        items: Array<{ status: string }>;
      };
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.status).toBe("pending");
    } finally {
      scheduler.stop();
      app.stop();
    }
  });

  test("rejects an empty prompt and a non-positive delay", async () => {
    const { app, port, scheduler } = setup();
    try {
      const empty = await fetch(
        `http://localhost:${port}/api/mirror/sched-sid/schedule-inject`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "   ", delayMs: 1000 }),
        },
      );
      expect(empty.status).toBe(400);

      const badDelay = await fetch(
        `http://localhost:${port}/api/mirror/sched-sid/schedule-inject`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "x", delayMs: 0 }),
        },
      );
      expect(badDelay.status).toBe(400);
    } finally {
      scheduler.stop();
      app.stop();
    }
  });

  test("404s scheduling against an unknown session", async () => {
    const { app, port, scheduler } = setup();
    try {
      const res = await fetch(
        `http://localhost:${port}/api/mirror/no-such-sid/schedule-inject`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "x", delayMs: 1000 }),
        },
      );
      expect(res.status).toBe(404);
    } finally {
      scheduler.stop();
      app.stop();
    }
  });

  test("cancels a pending queued inject", async () => {
    const { app, port, scheduler } = setup();
    try {
      const res = await fetch(
        `http://localhost:${port}/api/mirror/sched-sid/schedule-inject`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "x", delayMs: 60_000 }),
        },
      );
      const { id } = (await res.json()) as { id: string };
      const del = await fetch(
        `http://localhost:${port}/api/mirror/sched-sid/scheduled/${id}`,
        { method: "DELETE" },
      );
      expect(del.status).toBe(200);
      expect(scheduler.list("sched-sid")[0]?.status).toBe("cancelled");

      // Second cancel of the same id now 404s (no longer pending).
      const again = await fetch(
        `http://localhost:${port}/api/mirror/sched-sid/scheduled/${id}`,
        { method: "DELETE" },
      );
      expect(again.status).toBe(404);
    } finally {
      scheduler.stop();
      app.stop();
    }
  });
});

describe("file fetch route", () => {
  // A fake agent WS that, on receiving a mirror_fetch_file frame, replies
  // via resolveFetchFile — either with bytes or a refusal — driving the
  // full HTTP route → relay → Response path.
  function setup(reply: {
    data?: string;
    media_type?: string;
    bytes?: number;
    name?: string;
    error?: string;
  }) {
    const reg = new MirrorRegistry({ transcriptRing: 10, retentionMs: 0 });
    const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
    const port = app.server!.port;
    const r = reg.createSession("agent-x:u@h", "/workspace", "file-sid");
    if (!r.ok) throw new Error("session create failed");
    reg.setAgentConnection("file-sid", {
      ws: {
        send: (s: string) => {
          const frame = JSON.parse(s) as { requestId: string };
          reg.resolveFetchFile("file-sid", frame.requestId, reply);
        },
      },
      wsIdentity: {},
    });
    return { reg, app, port };
  }

  test("streams the file bytes with the agent-detected content-type", async () => {
    const raw = "PNG-BYTES-HERE";
    const { app, port } = setup({
      data: Buffer.from(raw).toString("base64"),
      media_type: "image/png",
      bytes: raw.length,
      name: "concept.png",
    });
    try {
      const res = await fetch(
        `http://localhost:${port}/api/mirror/file-sid/file?path=${encodeURIComponent("/workspace/concept.png")}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("content-disposition")).toContain("inline");
      expect(res.headers.get("content-disposition")).toContain("concept.png");
      expect(await res.text()).toBe(raw);
    } finally {
      app.stop();
    }
  });

  test("download=1 flips content-disposition to attachment", async () => {
    const { app, port } = setup({
      data: Buffer.from("x").toString("base64"),
      media_type: "text/plain",
      bytes: 1,
      name: "notes.txt",
    });
    try {
      const res = await fetch(
        `http://localhost:${port}/api/mirror/file-sid/file?path=${encodeURIComponent("/workspace/notes.txt")}&download=1`,
      );
      expect(res.headers.get("content-disposition")).toContain("attachment");
      await res.text();
    } finally {
      app.stop();
    }
  });

  test("returns 403 when the agent refuses the path", async () => {
    const { app, port } = setup({
      error: "File is not available for this session.",
    });
    try {
      const res = await fetch(
        `http://localhost:${port}/api/mirror/file-sid/file?path=${encodeURIComponent("/etc/shadow")}`,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not available");
    } finally {
      app.stop();
    }
  });

  test("returns 400 when path is missing", async () => {
    const { app, port } = setup({ error: "unused" });
    try {
      const res = await fetch(
        `http://localhost:${port}/api/mirror/file-sid/file`,
      );
      expect(res.status).toBe(400);
    } finally {
      app.stop();
    }
  });

  test("returns 404 for an unknown session", async () => {
    const { app, port } = setup({ error: "unused" });
    try {
      const res = await fetch(
        `http://localhost:${port}/api/mirror/nope-sid/file?path=${encodeURIComponent("/x/y")}`,
      );
      expect(res.status).toBe(404);
    } finally {
      app.stop();
    }
  });
});
