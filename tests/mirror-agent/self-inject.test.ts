import { describe, expect, test } from "bun:test";
import {
  type SelfInjectSessionCandidate,
  resolveSelfInject,
} from "@/mirror-agent/agent";

const MAX = 1024;

function session(
  partial: Partial<SelfInjectSessionCandidate>,
): SelfInjectSessionCandidate {
  return {
    sid: "s-1",
    ccPid: null,
    closed: false,
    tmuxPane: "%1",
    ...partial,
  };
}

describe("resolveSelfInject", () => {
  test("looks up by sid (Map)", () => {
    const sessions = new Map<string, SelfInjectSessionCandidate>([
      ["s-1", session({ sid: "s-1" })],
      ["s-2", session({ sid: "s-2" })],
    ]);
    const r = resolveSelfInject({ text: "hi", sid: "s-2" }, sessions, MAX);
    expect("session" in r).toBe(true);
    if ("session" in r) {
      expect(r.session.sid).toBe("s-2");
      expect(r.text).toBe("hi");
      expect(r.source).toBe("self");
    }
  });

  test("looks up by ccPid (iterable)", () => {
    const all = [
      session({ sid: "s-1", ccPid: 100 }),
      session({ sid: "s-2", ccPid: 200 }),
    ];
    const r = resolveSelfInject({ text: "hi", ccPid: 200 }, all, MAX);
    if (!("session" in r)) throw new Error("expected session");
    expect(r.session.sid).toBe("s-2");
  });

  test("ccPid lookup skips closed sessions", () => {
    const all = [
      session({ sid: "s-1", ccPid: 100, closed: true }),
      session({ sid: "s-2", ccPid: 100, closed: false }),
    ];
    const r = resolveSelfInject({ text: "hi", ccPid: 100 }, all, MAX);
    if (!("session" in r)) throw new Error("expected session");
    expect(r.session.sid).toBe("s-2");
  });

  test("sid wins over ccPid when both supplied", () => {
    const all = [
      session({ sid: "s-1", ccPid: 100 }),
      session({ sid: "s-2", ccPid: 200 }),
    ];
    const r = resolveSelfInject(
      { text: "hi", sid: "s-1", ccPid: 200 },
      new Map(all.map((s) => [s.sid, s])),
      MAX,
    );
    if (!("session" in r)) throw new Error("expected session");
    expect(r.session.sid).toBe("s-1");
  });

  test("custom source is preserved", () => {
    const sessions = new Map([["s-1", session({})]]);
    const r = resolveSelfInject(
      { text: "hi", sid: "s-1", source: "my-tool" },
      sessions,
      MAX,
    );
    if (!("session" in r)) throw new Error("expected session");
    expect(r.source).toBe("my-tool");
  });

  test("defaults source to 'self'", () => {
    const sessions = new Map([["s-1", session({})]]);
    const r = resolveSelfInject({ text: "hi", sid: "s-1" }, sessions, MAX);
    if (!("session" in r)) throw new Error("expected session");
    expect(r.source).toBe("self");
  });

  describe("error paths", () => {
    test("400 on non-object body", () => {
      const r = resolveSelfInject("bare string", new Map(), MAX);
      expect(r).toEqual({ error: "bad json", status: 400 });
    });

    test("400 on null body", () => {
      const r = resolveSelfInject(null, new Map(), MAX);
      expect(r).toEqual({ error: "bad json", status: 400 });
    });

    test("400 on missing text", () => {
      const r = resolveSelfInject({ sid: "s-1" }, new Map(), MAX);
      expect(r).toEqual({ error: "missing text", status: 400 });
    });

    test("400 on empty text", () => {
      const r = resolveSelfInject({ sid: "s-1", text: "" }, new Map(), MAX);
      expect(r).toEqual({ error: "missing text", status: 400 });
    });

    test("413 when text exceeds cap (UTF-8 byte count)", () => {
      const r = resolveSelfInject(
        { sid: "s-1", text: "x".repeat(MAX + 1) },
        new Map([["s-1", session({})]]),
        MAX,
      );
      expect(r.status).toBe(413);
      expect("error" in r && r.error).toContain("exceeds");
    });

    test("413 counts UTF-8 bytes not UTF-16 code units", () => {
      // 100 emoji × 4 UTF-8 bytes each = 400 bytes; UTF-16 length is 200.
      const text = "\u{1F600}".repeat(100);
      const r = resolveSelfInject(
        { sid: "s-1", text },
        new Map([["s-1", session({})]]),
        300,
      );
      expect(r.status).toBe(413);
    });

    test("400 when neither sid nor ccPid present", () => {
      const r = resolveSelfInject({ text: "hi" }, new Map(), MAX);
      expect(r).toEqual({ error: "missing sid or ccPid", status: 400 });
    });

    test("404 on unknown sid", () => {
      const r = resolveSelfInject(
        { text: "hi", sid: "nope" },
        new Map([["s-1", session({})]]),
        MAX,
      );
      expect(r).toEqual({ error: "no matching session", status: 404 });
    });

    test("404 on unknown ccPid", () => {
      const r = resolveSelfInject(
        { text: "hi", ccPid: 999 },
        [session({ ccPid: 100 })],
        MAX,
      );
      expect(r).toEqual({ error: "no matching session", status: 404 });
    });

    test("410 when matched session is closed", () => {
      // Closed sessions are only reachable via sid lookup — ccPid path
      // skips them. The closed check applies post-lookup.
      const r = resolveSelfInject(
        { text: "hi", sid: "s-1" },
        new Map([["s-1", session({ closed: true })]]),
        MAX,
      );
      expect(r).toEqual({ error: "session closed", status: 410 });
    });

    test("409 when matched session has no tmux pane", () => {
      const r = resolveSelfInject(
        { text: "hi", sid: "s-1" },
        new Map([["s-1", session({ tmuxPane: null })]]),
        MAX,
      );
      expect(r).toEqual({
        error: "session not running inside tmux",
        status: 409,
      });
    });

    test("ignores non-finite ccPid (treats as absent)", () => {
      const r = resolveSelfInject(
        { text: "hi", ccPid: Number.NaN },
        new Map(),
        MAX,
      );
      expect(r).toEqual({ error: "missing sid or ccPid", status: 400 });
    });
  });
});
