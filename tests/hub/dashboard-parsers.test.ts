// Regression tests for the dashboard response parsers.
//
// Each test loads a committed fixture from tests/hub/fixtures/tool-responses/
// and asserts the parser returns the expected shape. Assertions are shape-
// focused so fixture values can drift without breaking every test — only a
// structural payload change should fail the suite.
//
// Fixtures regenerate via `bun run capture-fixtures` against a live mirror.

import { describe, expect, test } from "bun:test";
import {
  buildAskUserQuestionKeys,
  extractCnList,
  extractImageBlocks,
  extractToolSearchNames,
  extractWebSearchResults,
  extractWebSearchSummary,
  hostFromUrl,
  parsePromptMenu,
  parseReadContent,
  toWebSearchText,
  unwrapMcpText,
} from "@/hub/dashboard/parsers.js";

import ReadFixture from "./fixtures/tool-responses/Read.json" with {
  type: "json",
};
import ToolSearchFixture from "./fixtures/tool-responses/ToolSearch.json" with {
  type: "json",
};
import WebSearchFixture from "./fixtures/tool-responses/WebSearch.json" with {
  type: "json",
};
import ListAgentsFixture from "./fixtures/tool-responses/mcp__claude-net__list_agents.json" with {
  type: "json",
};
import ListTeamsFixture from "./fixtures/tool-responses/mcp__claude-net__list_teams.json" with {
  type: "json",
};

describe("parseReadContent", () => {
  test("returns rows with numbered text for a structured file response", () => {
    const parsed = parseReadContent(ReadFixture.response);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows[0]).toHaveProperty("n");
    expect(parsed.rows[0]).toHaveProperty("text");
    expect(parsed.startLine).toBe(1);
    expect(typeof parsed.totalLines).toBe("number");
  });

  test("handles plain string input via line numbering", () => {
    const parsed = parseReadContent("first line\nsecond line\n");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].text).toBe("first line");
  });
});

describe("extractWebSearchResults", () => {
  test("pulls {title, url, snippet} entries from the native response", () => {
    const out = extractWebSearchResults(WebSearchFixture.response);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toHaveProperty("url");
    expect(out[0]).toHaveProperty("title");
    expect(out[0]).toHaveProperty("snippet");
  });

  test("returns an empty array for unrecognised input", () => {
    expect(extractWebSearchResults(null)).toEqual([]);
    expect(extractWebSearchResults({ nothing: true })).toEqual([]);
  });
});

describe("extractWebSearchSummary", () => {
  test("strips the REMINDER trailer from prose chunks", () => {
    const summary = extractWebSearchSummary(WebSearchFixture.response);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).not.toContain("REMINDER:");
  });
});

describe("toWebSearchText", () => {
  test("returns a string for every shape", () => {
    expect(typeof toWebSearchText(WebSearchFixture.response)).toBe("string");
    expect(toWebSearchText("raw string")).toBe("raw string");
    expect(toWebSearchText({ output: "via output" })).toBe("via output");
  });
});

describe("extractCnList", () => {
  test("pulls the agents array from a list_agents MCP envelope", () => {
    const list = extractCnList(ListAgentsFixture.response, "agents");
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty("name");
  });

  test("pulls the teams array from a list_teams MCP envelope", () => {
    const list = extractCnList(ListTeamsFixture.response, "teams");
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty("name");
    expect(list[0]).toHaveProperty("members");
  });

  test("returns [] for unrecognised payloads", () => {
    expect(extractCnList(null, "agents")).toEqual([]);
    expect(extractCnList({ nope: true }, "agents")).toEqual([]);
  });
});

describe("extractToolSearchNames", () => {
  test("finds tool names inside a <functions> block", () => {
    const text = unwrapMcpText(ToolSearchFixture.response) ?? "";
    const names = extractToolSearchNames(text);
    expect(names).toContain("Read");
    expect(names).toContain("Edit");
    expect(names).toContain("Grep");
  });

  test("returns empty array for empty input", () => {
    expect(extractToolSearchNames("")).toEqual([]);
    expect(extractToolSearchNames(null)).toEqual([]);
  });
});

describe("unwrapMcpText", () => {
  test("joins text blocks from an MCP envelope", () => {
    const wrapped = {
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    };
    expect(unwrapMcpText(wrapped)).toBe("hello world");
  });

  test("returns null for non-envelope inputs", () => {
    expect(unwrapMcpText("plain")).toBe(null);
    expect(unwrapMcpText({ other: true })).toBe(null);
    expect(unwrapMcpText(null)).toBe(null);
  });

  test("keeps text portion when array also contains non-text blocks", () => {
    // Used to return null and discard the text — see commit notes.
    const mixed = [
      { type: "text", text: "summary line" },
      {
        type: "image",
        source: { type: "base64", data: "AAAA", media_type: "image/png" },
      },
    ];
    expect(unwrapMcpText(mixed)).toBe("summary line");
  });

  test("returns null when no block has text", () => {
    const noText = [
      {
        type: "image",
        source: { type: "base64", data: "AAAA", media_type: "image/png" },
      },
    ];
    expect(unwrapMcpText(noText)).toBe(null);
  });
});

describe("extractImageBlocks", () => {
  // 1×1 transparent PNG (33 bytes decoded, ~44 bytes base64).
  const tinyPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  test("returns the image block from a bare top-level array", () => {
    const blocks = extractImageBlocks([
      {
        type: "image",
        source: { type: "base64", data: tinyPng, media_type: "image/png" },
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].media_type).toBe("image/png");
    expect(blocks[0].data).toBe(tinyPng);
    expect(blocks[0].bytes).toBeGreaterThan(0);
  });

  test("returns image blocks from an MCP {content:[]} envelope", () => {
    const blocks = extractImageBlocks({
      content: [
        { type: "text", text: "intro" },
        {
          type: "image",
          source: { type: "base64", data: tinyPng, media_type: "image/jpeg" },
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].media_type).toBe("image/jpeg");
  });

  test("returns multiple images in order", () => {
    const blocks = extractImageBlocks([
      {
        type: "image",
        source: { type: "base64", data: tinyPng, media_type: "image/png" },
      },
      {
        type: "image",
        source: { type: "base64", data: tinyPng, media_type: "image/webp" },
      },
    ]);
    expect(blocks.map((b) => b.media_type)).toEqual([
      "image/png",
      "image/webp",
    ]);
  });

  test("rejects image/svg+xml (script-bearing format)", () => {
    expect(
      extractImageBlocks([
        {
          type: "image",
          source: {
            type: "base64",
            data: tinyPng,
            media_type: "image/svg+xml",
          },
        },
      ]),
    ).toEqual([]);
  });

  test("rejects unknown / empty media_type", () => {
    expect(
      extractImageBlocks([
        {
          type: "image",
          source: { type: "base64", data: tinyPng, media_type: "" },
        },
        { type: "image", source: { type: "base64", data: tinyPng } },
      ]),
    ).toEqual([]);
  });

  test("returns empty for plain text / file-shape Read responses", () => {
    expect(extractImageBlocks("plain text")).toEqual([]);
    expect(extractImageBlocks({ file: { content: "lines" } })).toEqual([]);
    expect(extractImageBlocks(null)).toEqual([]);
  });

  test("surfaces the over-cap placeholder emitted by the mirror-agent", () => {
    const blocks = extractImageBlocks([
      {
        type: "image_placeholder",
        media_type: "image/png",
        bytes: 1_500_000,
        reason: "too_large",
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].data).toBeNull();
    expect(blocks[0].reason).toBe("too_large");
    expect(blocks[0].bytes).toBe(1_500_000);
  });

  test("does not recurse into source.data (no false positives in base64)", () => {
    // A pathological base64 payload that contains the literal substring
    // {"type":"image"...} would otherwise re-match if we recursed into
    // source.data. We don't — image blocks short-circuit.
    const blocks = extractImageBlocks([
      {
        type: "image",
        source: {
          type: "base64",
          // not a real PNG, but enough to satisfy the walker
          data: tinyPng,
          media_type: "image/png",
        },
      },
    ]);
    expect(blocks).toHaveLength(1);
  });
});

describe("hostFromUrl", () => {
  test("returns the host part of an absolute URL", () => {
    expect(hostFromUrl("https://example.com/path?q=1")).toBe("example.com");
  });

  test("returns the input unchanged when it isn't parseable", () => {
    expect(hostFromUrl("not a url")).toBe("not a url");
  });

  test("returns empty string for empty input", () => {
    expect(hostFromUrl("")).toBe("");
  });
});

describe("parsePromptMenu", () => {
  test("returns null on empty or non-string input", () => {
    expect(parsePromptMenu("")).toBe(null);
    expect(parsePromptMenu(null as unknown as string)).toBe(null);
    expect(parsePromptMenu(123 as unknown as string)).toBe(null);
  });

  test("returns null when no numbered options are present", () => {
    expect(parsePromptMenu("Claude needs your permission to use Write")).toBe(
      null,
    );
  });

  test("parses title + options from an augmented notification", () => {
    const text = [
      "Claude needs your permission to use Bash",
      "",
      "1. Host batch first, then #48",
      "2. Pod-side (the teammate's preferred split).",
      "3. Both",
    ].join("\n");
    const parsed = parsePromptMenu(text);
    expect(parsed).not.toBe(null);
    expect(parsed?.title).toBe("Claude needs your permission to use Bash");
    expect(parsed?.options).toEqual([
      { key: "1", label: "Host batch first, then #48" },
      { key: "2", label: "Pod-side (the teammate's preferred split)." },
      { key: "3", label: "Both" },
    ]);
  });

  test("supports two-digit option numbers", () => {
    const text = ["Pick a target", "", "1. one", "10. ten", "11. eleven"].join(
      "\n",
    );
    const parsed = parsePromptMenu(text);
    expect(parsed?.options).toHaveLength(3);
    expect(parsed?.options[2]).toEqual({ key: "11", label: "eleven" });
  });

  test("joins multi-line titles with a single space", () => {
    const text = [
      "Claude needs your permission",
      "to run Bash",
      "",
      "1. Yes",
      "2. No",
    ].join("\n");
    expect(parsePromptMenu(text)?.title).toBe(
      "Claude needs your permission to run Bash",
    );
  });
});

describe("buildAskUserQuestionKeys", () => {
  test("single question, first option → Enter, Enter (submit)", () => {
    const questions = [{ question: "Pick", options: [{ label: "A" }] }];
    const answers = [{ kind: "option", index: 0 }];
    expect(buildAskUserQuestionKeys(questions, answers)).toEqual([
      { type: "key", name: "Enter" },
      { type: "key", name: "Enter" },
    ]);
  });

  test("single question, third option → Down × 2, Enter, Enter", () => {
    const questions = [
      {
        question: "Pick",
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      },
    ];
    const answers = [{ kind: "option", index: 2 }];
    expect(buildAskUserQuestionKeys(questions, answers)).toEqual([
      { type: "key", name: "Down" },
      { type: "key", name: "Down" },
      { type: "key", name: "Enter" },
      { type: "key", name: "Enter" },
    ]);
  });

  test("free-text answer navigates past supplied options", () => {
    const questions = [
      {
        question: "Pick",
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      },
    ];
    const answers = [{ kind: "text", value: "hello" }];
    expect(buildAskUserQuestionKeys(questions, answers)).toEqual([
      { type: "key", name: "Down" },
      { type: "key", name: "Down" },
      { type: "key", name: "Down" },
      { type: "key", name: "Enter" },
      { type: "text", value: "hello" },
      { type: "key", name: "Enter" },
      { type: "key", name: "Enter" },
    ]);
  });

  test("multi-question batches answers and ends on a single submit Enter", () => {
    const questions = [
      { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
      {
        question: "Q2",
        options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
      },
    ];
    const answers = [
      { kind: "option", index: 1 },
      { kind: "option", index: 0 },
    ];
    expect(buildAskUserQuestionKeys(questions, answers)).toEqual([
      { type: "key", name: "Down" },
      { type: "key", name: "Enter" },
      { type: "key", name: "Enter" },
      { type: "key", name: "Enter" },
    ]);
  });

  test("free text with empty value still navigates and confirms", () => {
    // Defensive — the UI gates Submit on empty text, but the helper
    // shouldn't choke if it gets here anyway.
    const questions = [{ question: "Q", options: [{ label: "A" }] }];
    const answers = [{ kind: "text", value: "" }];
    expect(buildAskUserQuestionKeys(questions, answers)).toEqual([
      { type: "key", name: "Down" },
      { type: "key", name: "Enter" },
      { type: "key", name: "Enter" },
      { type: "key", name: "Enter" },
    ]);
  });
});
