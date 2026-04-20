// Smoke-test for the agent recovery path.
//
// We test the hub's reject behavior (returns 1008 + 'Session not found' when
// a WS tries to connect with a sid the registry doesn't know about), which is
// the trigger the agent uses to recreate a session. The agent's actual reconnect
// logic is exercised at the unit level by checking that createSession with the
// same sid succeeds after a hub "restart" (wipe of MirrorRegistry state).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "@/hub/mirror";
import { Elysia } from "elysia";

describe("mirror session loss + recovery", () => {
  let reg: MirrorRegistry;
  let app: Elysia;
  let port: number;

  beforeEach(() => {
    reg = new MirrorRegistry({ transcriptRing: 100, retentionMs: 0 });
    let a = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg, port: 0 }));
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
    const token = "a".repeat(32);
    const url = `ws://localhost:${port}/ws/mirror/${sid}?t=${token}&as=agent`;
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

  test("re-creating the same sid after registry wipe produces a fresh token", () => {
    const c1 = reg.createSession("a:u@h", "/a", "stable-sid");
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    const origToken = c1.token;

    // Simulate hub restart wiping in-memory state.
    reg.sessions.delete("stable-sid");

    const c2 = reg.createSession("a:u@h", "/a", "stable-sid");
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.token).not.toBe(origToken);
    expect(c2.entry.sid).toBe("stable-sid");
    // New token validates:
    const v = reg.validateToken("stable-sid", c2.token);
    expect(v.ok).toBe(true);
    // Old token does NOT validate:
    const bad = reg.validateToken("stable-sid", origToken);
    expect(bad.ok).toBe(false);
  });

  test("recreated session shares sid but has a distinct listAllWithTokens entry", () => {
    const c1 = reg.createSession("a:u@h", "/a", "rewind-sid");
    if (!c1.ok) return;
    reg.sessions.delete("rewind-sid");
    const c2 = reg.createSession("a:u@h", "/a", "rewind-sid");
    if (!c2.ok) return;
    const listed = reg.listAllWithTokens();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sid).toBe("rewind-sid");
    expect(listed[0]?.owner_token).toBe(c2.token);
  });
});
