// Smoke-test for the agent recovery path.
//
// The hub's reject behavior is the trigger the agent uses to recreate a
// session. We check that a WS connection to an unknown sid is closed with
// code 1008 + "not found", and that re-creating the same sid after a
// registry wipe succeeds.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "@/hub/mirror";
import { Elysia } from "elysia";

describe("mirror session loss + recovery", () => {
  let reg: MirrorRegistry;
  let app: Elysia;
  let port: number;

  beforeEach(() => {
    reg = new MirrorRegistry({ transcriptRing: 100, retentionMs: 0 });
    let a = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg }));
    a = wsMirrorPlugin(a, reg);
    a.listen(0);
    app = a;
    // biome-ignore lint/style/noNonNullAssertion: listen guarantees
    port = app.server!.port;
  });

  afterEach(() => {
    app.stop();
  });

  test("hub rejects WS with code 1008 + 'not found' reason when session is unknown", async () => {
    const sid = "ghost-sid";
    const url = `ws://localhost:${port}/ws/mirror/${sid}?as=agent`;
    const ws = new WebSocket(url);
    const closeInfo = await new Promise<{ code: number; reason: string }>(
      (resolve) => {
        ws.addEventListener("close", (e) => {
          resolve({ code: e.code, reason: e.reason });
        });
      },
    );
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason.toLowerCase()).toContain("not found");
  });

  test("re-creating the same sid after registry wipe works", () => {
    const c1 = reg.createSession("a:u@h", "/a", "stable-sid");
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;

    // Simulate hub restart wiping in-memory state.
    reg.sessions.delete("stable-sid");

    const c2 = reg.createSession("a:u@h", "/a", "stable-sid");
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.entry.sid).toBe("stable-sid");
    expect(c2.restored).toBe(false);
    // getSession finds the new entry.
    const found = reg.getSession("stable-sid");
    expect(found.ok).toBe(true);
  });

  test("recreated session shows up in listAll()", () => {
    const c1 = reg.createSession("a:u@h", "/a", "rewind-sid");
    if (!c1.ok) return;
    reg.sessions.delete("rewind-sid");
    const c2 = reg.createSession("a:u@h", "/a", "rewind-sid");
    if (!c2.ok) return;
    const listed = reg.listAll();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sid).toBe("rewind-sid");
  });

  test("POST /api/mirror/session round-trips host + cc_pid", async () => {
    const res = await fetch(`http://localhost:${port}/api/mirror/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner_agent: "skydeck:alice@laptop",
        cwd: "/work/sky",
        sid: "wire-sid",
        host: "laptop",
        cc_pid: 4242,
      }),
    });
    expect(res.ok).toBe(true);
    const entry = reg.sessions.get("wire-sid");
    expect(entry?.host).toBe("laptop");
    expect(entry?.ccPid).toBe(4242);
  });

  test("hub-restart rename flow: agent's pre-registered name re-applies to a freshly-POSTed session", () => {
    // Simulate the hub-restart sequence end-to-end at the registry level:
    //   1. MCP plugin re-registers with its chosen name + cc_pid.
    //   2. Mirror-agent re-POSTs the session (cwd-derived owner) with
    //      the same (host, cc_pid).
    //   3. Hub's agentLookup at session-creation time pulls the
    //      registered name and the session is born already-relabeled.
    // No persisted state — the join is rebuilt from live announcements.

    // Step 1: register the agent first.
    const namesByIdentity = new Map<string, string>();
    namesByIdentity.set("laptop|4242", "yos:alice@laptop");
    reg.setAgentLookup(
      (host, ccPid) => namesByIdentity.get(`${host}|${ccPid}`) ?? null,
    );

    // Step 2: mirror-agent POSTs the session (cwd-derived owner).
    const result = reg.createSession(
      "skydeck:alice@laptop",
      "/work/sky",
      "post-restart-sid",
      "laptop",
      4242,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Step 3: session is born under the registered name, not the
    // cwd-derived default. No mirror:owner_renamed broadcast needed
    // because the rename happened at session-creation time.
    expect(result.entry.ownerAgent).toBe("yos:alice@laptop");
    expect(result.entry.host).toBe("laptop");
    expect(result.entry.ccPid).toBe(4242);
  });
});
