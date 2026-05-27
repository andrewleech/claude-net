// Tests for findReplacedByClear — the pure helper that picks stale
// mirror sessions to close when a fresh session_id arrives for the
// same Claude Code process (the /clear and /compact rotation cases).

import { describe, expect, test } from "bun:test";
import {
  type ClearReplaceCandidate,
  findReplacedByClear,
} from "@/mirror-agent/agent";

function s(
  sid: string,
  opts: Partial<ClearReplaceCandidate> = {},
): ClearReplaceCandidate {
  return {
    sid,
    ccPid: opts.ccPid ?? null,
    tmuxPane: opts.tmuxPane ?? null,
    closed: opts.closed ?? false,
  };
}

describe("findReplacedByClear", () => {
  test("flags a sibling session with the same ccPid", () => {
    const sessions = [
      s("old", { ccPid: 1234 }),
      s("new", { ccPid: 1234 }), // incoming
    ];
    expect(findReplacedByClear(sessions, "new", 1234, null)).toEqual(["old"]);
  });

  test("does not flag the incoming sid itself", () => {
    const sessions = [s("new", { ccPid: 1234 })];
    expect(findReplacedByClear(sessions, "new", 1234, null)).toEqual([]);
  });

  test("does not flag already-closed sessions", () => {
    const sessions = [
      s("old", { ccPid: 1234, closed: true }),
      s("new", { ccPid: 1234 }),
    ];
    expect(findReplacedByClear(sessions, "new", 1234, null)).toEqual([]);
  });

  test("does not flag fork-session siblings (different ccPid, same cwd)", () => {
    // Fork session opens a second CC process. Different ccPids. Both should remain.
    const sessions = [
      s("fork1", { ccPid: 1000, tmuxPane: null }),
      s("fork2", { ccPid: 2000, tmuxPane: null }), // incoming
    ];
    expect(findReplacedByClear(sessions, "fork2", 2000, null)).toEqual([]);
  });

  test("ccPid 0 / null / NaN / undefined falls back to pane-only matching", () => {
    // null ccPid in the incoming hook means we cannot use the strongest
    // signal — the pane fallback is the only thing we can match on.
    const sessions = [
      s("old", { tmuxPane: "%5" }),
      s("new", { tmuxPane: "%5" }),
    ];
    expect(findReplacedByClear(sessions, "new", undefined, "%5")).toEqual([
      "old",
    ]);
  });

  test("flags by tmuxPane when ccPid is absent on either side", () => {
    const sessions = [
      s("old", { ccPid: null, tmuxPane: "%5" }),
      s("new", { ccPid: null, tmuxPane: "%5" }),
    ];
    expect(findReplacedByClear(sessions, "new", undefined, "%5")).toEqual([
      "old",
    ]);
  });

  test("flags by either ccPid OR tmuxPane (OR semantics)", () => {
    // Two candidates: one matches by ccPid only, one matches by pane only.
    // Both should be closed.
    const sessions = [
      s("by_pid", { ccPid: 1234, tmuxPane: "%9" }),
      s("by_pane", { ccPid: 9999, tmuxPane: "%5" }),
      s("new", { ccPid: 1234, tmuxPane: "%5" }),
    ];
    expect(findReplacedByClear(sessions, "new", 1234, "%5").sort()).toEqual([
      "by_pane",
      "by_pid",
    ]);
  });

  test("missing ccPid AND missing pane returns no victims", () => {
    // Pre-rollout client with no identity at all — we can't safely
    // assume any session is stale, so do nothing.
    const sessions = [s("old"), s("new")];
    expect(findReplacedByClear(sessions, "new", undefined, null)).toEqual([]);
  });

  test("accepts a Map<string, candidate> for ergonomics", () => {
    const map = new Map<string, ClearReplaceCandidate>();
    map.set("old", s("old", { ccPid: 7 }));
    map.set("new", s("new", { ccPid: 7 }));
    expect(findReplacedByClear(map, "new", 7, null)).toEqual(["old"]);
  });

  test("multiple stale siblings are all flagged", () => {
    // After several /clear cycles, more than one orphan can have accumulated.
    const sessions = [
      s("orphan1", { ccPid: 42 }),
      s("orphan2", { ccPid: 42 }),
      s("orphan3", { ccPid: 42 }),
      s("new", { ccPid: 42 }),
    ];
    expect(findReplacedByClear(sessions, "new", 42, null).sort()).toEqual([
      "orphan1",
      "orphan2",
      "orphan3",
    ]);
  });
});
