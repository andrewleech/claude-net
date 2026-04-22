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
});
