import { describe, expect, test } from "bun:test";
import { ingestHook } from "@/mirror-agent/hook-ingest";

describe("ingestHook", () => {
  test("returns null when session_id is missing", () => {
    expect(
      ingestHook({ hook_event_name: "UserPromptSubmit", prompt: "hi" }),
    ).toBeNull();
  });

  test("returns null when hook_event_name is missing", () => {
    expect(ingestHook({ session_id: "s-1", prompt: "hi" })).toBeNull();
  });

  test("SessionStart → session_start payload", () => {
    const out = ingestHook({
      hook_event_name: "SessionStart",
      session_id: "s-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      source: "resume",
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.sid).toBe("s-1");
    expect(out.frame.kind).toBe("session_start");
    expect(out.frame.payload).toEqual({
      kind: "session_start",
      source: "resume",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
    });
  });

  test("SessionStart coerces invalid source to 'startup'", () => {
    const out = ingestHook({
      hook_event_name: "SessionStart",
      session_id: "s-1",
      source: "garbage",
    });
    expect(out).not.toBeNull();
    if (!out) return;
    if (out.frame.payload.kind !== "session_start")
      throw new Error("wrong kind");
    expect(out.frame.payload.source).toBe("startup");
  });

  test("UserPromptSubmit → user_prompt payload", () => {
    const out = ingestHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-1",
      prompt: "hello world",
      cwd: "/tmp",
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.frame.kind).toBe("user_prompt");
    if (out.frame.payload.kind !== "user_prompt") throw new Error("wrong kind");
    expect(out.frame.payload.prompt).toBe("hello world");
  });

  test("Stop → assistant_message payload", () => {
    const out = ingestHook({
      hook_event_name: "Stop",
      session_id: "s-1",
      last_assistant_message: "done",
      stop_reason: "end_turn",
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.frame.kind).toBe("assistant_message");
    if (out.frame.payload.kind !== "assistant_message")
      throw new Error("wrong kind");
    expect(out.frame.payload.text).toBe("done");
    expect(out.frame.payload.stop_reason).toBe("end_turn");
    expect(out.frame.payload.subagent).toBeUndefined();
  });

  test("SubagentStop tags payload with subagent: true", () => {
    const out = ingestHook({
      hook_event_name: "SubagentStop",
      session_id: "s-1",
      last_assistant_message: "subdone",
      stop_reason: "end_turn",
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.frame.kind).toBe("assistant_message");
    if (out.frame.payload.kind !== "assistant_message")
      throw new Error("wrong kind");
    expect(out.frame.payload.subagent).toBe(true);
  });

  test("PreToolUse → tool_call payload", () => {
    const out = ingestHook({
      hook_event_name: "PreToolUse",
      session_id: "s-1",
      tool_use_id: "use-1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.frame.kind).toBe("tool_call");
    if (out.frame.payload.kind !== "tool_call") throw new Error("wrong kind");
    expect(out.frame.payload.tool_name).toBe("Bash");
    expect(out.frame.payload.input).toEqual({ command: "ls" });
  });

  test("PostToolUse → tool_result payload", () => {
    const out = ingestHook({
      hook_event_name: "PostToolUse",
      session_id: "s-1",
      tool_use_id: "use-1",
      tool_name: "Bash",
      tool_response: "file1\nfile2\n",
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.frame.kind).toBe("tool_result");
  });

  test("PreCompact and PostCompact map to compact with phase", () => {
    const pre = ingestHook({
      hook_event_name: "PreCompact",
      session_id: "s-1",
    });
    const post = ingestHook({
      hook_event_name: "PostCompact",
      session_id: "s-1",
    });
    expect(pre?.frame.payload.kind).toBe("compact");
    expect(post?.frame.payload.kind).toBe("compact");
    if (pre?.frame.payload.kind === "compact") {
      expect(pre.frame.payload.phase).toBe("pre");
    }
    if (post?.frame.payload.kind === "compact") {
      expect(post.frame.payload.phase).toBe("post");
    }
  });

  test("Unknown hook names return null", () => {
    expect(
      ingestHook({ hook_event_name: "WeirdHook", session_id: "s-1" }),
    ).toBeNull();
  });

  test("Large strings are truncated and flagged", () => {
    const big = "x".repeat(300 * 1024);
    const out = ingestHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-1",
      prompt: big,
    });
    expect(out).not.toBeNull();
    if (!out) return;
    if (out.frame.payload.kind !== "user_prompt") throw new Error("wrong kind");
    expect(out.frame.payload.truncated).toBe(true);
    expect(out.frame.payload.prompt.length).toBeLessThan(big.length);
  });

  test("frame includes session_id, fresh uuid, and ts", () => {
    const out = ingestHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-42",
      prompt: "p",
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.frame.sid).toBe("s-42");
    expect(out.frame.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof out.frame.ts).toBe("number");
  });
});
