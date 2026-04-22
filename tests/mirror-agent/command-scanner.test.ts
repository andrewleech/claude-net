import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseCommandFile,
  parseFrontmatter,
} from "@/mirror-agent/command-scanner";

describe("parseFrontmatter", () => {
  test("returns empty for content without frontmatter", () => {
    expect(parseFrontmatter("plain body\n")).toEqual({});
    expect(parseFrontmatter("")).toEqual({});
  });

  test("extracts simple key:value pairs", () => {
    const fm = parseFrontmatter(
      "---\nname: review\ndescription: run a review\n---\nbody",
    );
    expect(fm.name).toBe("review");
    expect(fm.description).toBe("run a review");
  });

  test("strips surrounding quotes", () => {
    const fm = parseFrontmatter(
      "---\nname: \"hello\"\ndescription: 'tricky: colons'\n---\n",
    );
    expect(fm.name).toBe("hello");
    expect(fm.description).toBe("tricky: colons");
  });

  test("tolerates a BOM before the opening fence", () => {
    const fm = parseFrontmatter("\uFEFF---\nname: bom\n---\n");
    expect(fm.name).toBe("bom");
  });

  test("returns empty when closing fence is missing", () => {
    expect(parseFrontmatter("---\nname: oops\nnot closed\n")).toEqual({});
  });

  test("ignores comment lines", () => {
    const fm = parseFrontmatter("---\n# a comment\nname: visible\n---\n");
    expect(fm.name).toBe("visible");
  });
});

describe("parseCommandFile", () => {
  test("uses frontmatter name when present", () => {
    const tmp = path.join(
      os.tmpdir(),
      `cmd-scanner-test-${process.pid}-${Date.now()}.md`,
    );
    fs.writeFileSync(
      tmp,
      "---\nname: explicit\ndescription: from frontmatter\n---\n\nbody",
    );
    try {
      const cmd = parseCommandFile(tmp, "user");
      expect(cmd).not.toBeNull();
      expect(cmd?.name).toBe("explicit");
      expect(cmd?.description).toBe("from frontmatter");
      expect(cmd?.source).toBe("user");
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test("falls back to filename stem when frontmatter is missing", () => {
    const tmp = path.join(
      os.tmpdir(),
      `fallback-name-${process.pid}-${Date.now()}.md`,
    );
    fs.writeFileSync(tmp, "no frontmatter here\n");
    try {
      const cmd = parseCommandFile(tmp, "project");
      expect(cmd?.name).toBe(path.basename(tmp, ".md"));
      expect(cmd?.description).toBeUndefined();
      expect(cmd?.source).toBe("project");
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test("returns null for missing files", () => {
    const cmd = parseCommandFile(
      path.join(os.tmpdir(), "this-file-really-does-not-exist.md"),
      "user",
    );
    expect(cmd).toBeNull();
  });
});
