import { describe, expect, test } from "bun:test";
import { jsonlRecordToHistoryFrame } from "@/mirror-agent/jsonl-to-frame";

describe("jsonlRecordToHistoryFrame", () => {
  test("user record with string content", () => {
    const f = jsonlRecordToHistoryFrame("sid-1", {
      uuid: "u1",
      type: "user",
      timestamp: "2026-04-25T12:00:00Z",
      message: { content: "hello there" },
    });
    expect(f).not.toBeNull();
    expect(f?.kind).toBe("history_text");
    expect(f?.uuid).toBe("u1");
    expect(f?.payload.kind).toBe("history_text");
    if (f?.payload.kind === "history_text") {
      expect(f.payload.role).toBe("user");
      expect(f.payload.text).toBe("hello there");
    }
  });

  test("assistant record with text + tool_use blocks", () => {
    const f = jsonlRecordToHistoryFrame("sid-1", {
      uuid: "u2",
      type: "assistant",
      timestamp: "2026-04-25T12:00:01Z",
      message: {
        content: [
          { type: "text", text: "Reading the file." },
          { type: "tool_use", name: "Read" },
          { type: "text", text: "Done." },
        ],
      },
    });
    if (f?.payload.kind !== "history_text") {
      throw new Error("expected history_text payload");
    }
    expect(f.payload.role).toBe("assistant");
    expect(f.payload.text).toBe("Reading the file. [tool: Read] Done.");
  });

  test("tool_result block collapses to placeholder", () => {
    const f = jsonlRecordToHistoryFrame("sid-1", {
      uuid: "u3",
      type: "user",
      message: {
        content: [
          { type: "tool_result", is_error: false },
          { type: "text", text: "follow-up" },
        ],
      },
    });
    if (f?.payload.kind !== "history_text") {
      throw new Error("expected history_text payload");
    }
    expect(f.payload.text).toBe("[result] follow-up");
  });

  test("tool_result with is_error renders error placeholder", () => {
    const f = jsonlRecordToHistoryFrame("sid-1", {
      uuid: "u4",
      type: "user",
      message: {
        content: [{ type: "tool_result", is_error: true }],
      },
    });
    if (f?.payload.kind !== "history_text") {
      throw new Error("expected history_text payload");
    }
    expect(f.payload.text).toBe("[result: error]");
  });

  test("system record with content string", () => {
    const f = jsonlRecordToHistoryFrame("sid-1", {
      uuid: "u5",
      type: "system",
      content: "session started",
    });
    if (f?.payload.kind !== "history_text") {
      throw new Error("expected history_text payload");
    }
    expect(f.payload.role).toBe("system");
    expect(f.payload.text).toBe("session started");
  });

  test("unsupported types return null", () => {
    expect(jsonlRecordToHistoryFrame("sid-1", { type: "summary" })).toBeNull();
    expect(jsonlRecordToHistoryFrame("sid-1", {})).toBeNull();
  });

  test("empty content returns null", () => {
    const f = jsonlRecordToHistoryFrame("sid-1", {
      uuid: "u6",
      type: "user",
      message: { content: [] },
    });
    expect(f).toBeNull();
  });

  test("missing uuid generates a synthetic one", () => {
    const f = jsonlRecordToHistoryFrame("sid-1", {
      type: "user",
      message: { content: "hi" },
    });
    expect(f).not.toBeNull();
    expect(typeof f?.uuid).toBe("string");
    expect(f?.uuid.length).toBeGreaterThan(0);
  });

  test("invalid timestamp falls back to Date.now", () => {
    const before = Date.now();
    const f = jsonlRecordToHistoryFrame("sid-1", {
      uuid: "u7",
      type: "user",
      timestamp: "not a date",
      message: { content: "hi" },
    });
    const after = Date.now();
    expect(f?.ts).toBeGreaterThanOrEqual(before);
    expect(f?.ts).toBeLessThanOrEqual(after);
  });
});
