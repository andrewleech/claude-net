import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore, NullStore } from "@/hub/mirror-store";
import type { MirrorEventFrame } from "@/shared/types";

function frame(uuid: string, kind: string): MirrorEventFrame {
  return {
    action: "mirror_event",
    sid: "s-1",
    uuid,
    kind: kind as MirrorEventFrame["kind"],
    ts: 0,
    payload:
      kind === "user_prompt"
        ? { kind: "user_prompt", prompt: `p-${uuid}`, cwd: "/tmp" }
        : { kind: "notification", text: `n-${uuid}` },
  };
}

describe("NullStore", () => {
  test("is a no-op", async () => {
    const s = new NullStore();
    s.recordOpen({
      sid: "x",
      owner_agent: "a",
      cwd: "/",
      created_at: "now",
    });
    s.appendEvent("x", frame("u-1", "user_prompt"));
    s.recordClose("x", "now");
    expect(s.loadArchived("x")).toBeNull();
    await s.close();
  });
});

describe("FileStore", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-store-"));
    store = new FileStore({ dir, fsyncEvery: 1 });
  });

  afterEach(async () => {
    await store.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("records session metadata and events, replays via loadArchived", () => {
    store.recordOpen({
      sid: "abc",
      owner_agent: "alice:u@h",
      cwd: "/home/alice",
      created_at: "2026-04-20T10:00:00Z",
    });
    store.appendEvent("abc", frame("u-1", "user_prompt"));
    store.appendEvent("abc", frame("u-2", "notification"));
    store.recordClose("abc", "2026-04-20T10:10:00Z");

    const archived = store.loadArchived("abc");
    expect(archived).not.toBeNull();
    if (!archived) return;
    expect(archived.sid).toBe("abc");
    expect(archived.owner_agent).toBe("alice:u@h");
    expect(archived.cwd).toBe("/home/alice");
    expect(archived.created_at).toBe("2026-04-20T10:00:00Z");
    expect(archived.closed_at).toBe("2026-04-20T10:10:00Z");
    expect(archived.transcript.map((e) => e.uuid)).toEqual(["u-1", "u-2"]);
  });

  test("loadArchived returns null for unknown sid", () => {
    expect(store.loadArchived("missing")).toBeNull();
  });

  test("sanitizes sids used in filenames", () => {
    store.recordOpen({
      sid: "../oops",
      owner_agent: "a",
      cwd: "/",
      created_at: "now",
    });
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.includes(".."))).toBe(false);
  });

  test("retention prunes old closed files on sweep", () => {
    // Create a FileStore with a tiny retention window (0.001 hours ≈ 3.6s).
    // Manually predate a closed file's mtime.
    store.recordOpen({
      sid: "old",
      owner_agent: "a",
      cwd: "/",
      created_at: "now",
    });
    store.appendEvent("old", frame("u-1", "notification"));
    store.recordClose("old", "then");
    const p = path.join(dir, "old.jsonl");
    const past = (Date.now() - 48 * 3600_000) / 1000;
    fs.utimesSync(p, past, past);

    const longRetention = new FileStore({ dir, retentionHours: 1 });
    // The constructor runs a sweep synchronously; file should be gone.
    // (Prune runs on files with mtime < cutoff.)
    expect(fs.existsSync(p)).toBe(false);
    void longRetention.close();
  });
});
