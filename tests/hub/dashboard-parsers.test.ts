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
  extractCnList,
  extractToolSearchNames,
  extractWebSearchResults,
  extractWebSearchSummary,
  hostFromUrl,
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
