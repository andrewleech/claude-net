import { describe, expect, test } from "bun:test";
import { extractApiErrorText, isApiErrorRecord } from "@/mirror-agent/agent";

describe("isApiErrorRecord", () => {
  test("true when isApiErrorMessage === true", () => {
    expect(isApiErrorRecord({ isApiErrorMessage: true })).toBe(true);
  });

  test("false when isApiErrorMessage is absent", () => {
    expect(isApiErrorRecord({ type: "assistant" })).toBe(false);
  });

  test("false when isApiErrorMessage is any non-true value", () => {
    expect(isApiErrorRecord({ isApiErrorMessage: false })).toBe(false);
    expect(isApiErrorRecord({ isApiErrorMessage: "true" })).toBe(false);
    expect(isApiErrorRecord({ isApiErrorMessage: 1 })).toBe(false);
  });
});

describe("extractApiErrorText", () => {
  test("returns the first text block from message.content", () => {
    // The shape CC actually writes for an Overloaded error (verified
    // against a real JSONL transcript). The text body is what we want
    // to surface to the sender.
    const rec = {
      type: "assistant",
      isApiErrorMessage: true,
      apiErrorStatus: 529,
      error: "server_error",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "API Error: 529 Overloaded." }],
      },
    };
    expect(extractApiErrorText(rec)).toBe("API Error: 529 Overloaded.");
  });

  test("falls back to top-level `error` when content has no text block", () => {
    const rec = {
      isApiErrorMessage: true,
      error: "rate_limited",
      message: { role: "assistant", content: [{ type: "tool_use" }] },
    };
    expect(extractApiErrorText(rec)).toBe("rate_limited");
  });

  test("returns empty string when nothing is extractable", () => {
    expect(extractApiErrorText({})).toBe("");
    expect(extractApiErrorText({ message: {} })).toBe("");
    expect(extractApiErrorText({ message: { content: [] } })).toBe("");
  });

  test("skips non-text content blocks and picks the first text one", () => {
    const rec = {
      message: {
        content: [
          { type: "tool_use", id: "x" },
          { type: "text", text: "second is text" },
          { type: "text", text: "third is text" },
        ],
      },
    };
    expect(extractApiErrorText(rec)).toBe("second is text");
  });
});
