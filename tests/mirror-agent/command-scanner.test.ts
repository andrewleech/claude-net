import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type SlashCommand,
  parseCommandFile,
  parseFrontmatter,
  pickLatestVersion,
  scanPluginCommands,
  scanPluginSkills,
} from "@/mirror-agent/command-scanner";

function mkdtemp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cmd-scanner-${label}-`));
}

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

describe("pickLatestVersion", () => {
  test("returns null on empty input", () => {
    expect(pickLatestVersion([])).toBeNull();
  });

  test("orders by numeric semver, not lexically", () => {
    // Lexical sort would put "2.10.0" before "2.9.0"; we want the
    // numeric sort that surfaces 2.10.0 as newer.
    expect(pickLatestVersion(["1.1.0", "2.1.0", "2.10.0", "2.9.0"])).toBe(
      "2.10.0",
    );
  });

  test("returns the only entry when there's just one", () => {
    expect(pickLatestVersion(["3.0.0"])).toBe("3.0.0");
  });
});

describe("scanPluginCommands", () => {
  test("flattens commands/<plugin-name>/<file>.md to <plugin>:<file>", () => {
    const root = mkdtemp("flatten");
    try {
      const sub = path.join(root, "idea-plan-execute");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(
        path.join(sub, "02-plan-spec.md"),
        "---\ndescription: plan it\n---\nbody",
      );
      const out: SlashCommand[] = [];
      scanPluginCommands(root, "idea-plan-execute", out);
      // Crucially NOT idea-plan-execute:idea-plan-execute:02-plan-spec.
      expect(out.map((c) => c.name)).toContain(
        "idea-plan-execute:02-plan-spec",
      );
      expect(out).toHaveLength(1);
      expect(out[0]?.description).toBe("plan it");
      expect(out[0]?.source).toBe("plugin:idea-plan-execute");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-matching subdir gets the standard <plugin>:<dir>:<file> form", () => {
    const root = mkdtemp("subdir");
    try {
      const sub = path.join(root, "helpers");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, "lookup.md"), "no fm");
      const out: SlashCommand[] = [];
      scanPluginCommands(root, "myplugin", out);
      expect(out.map((c) => c.name)).toEqual(["myplugin:helpers:lookup"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("top-level files become <plugin>:<file>", () => {
    const root = mkdtemp("toplevel");
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "init.md"), "no fm");
      const out: SlashCommand[] = [];
      scanPluginCommands(root, "myplugin", out);
      expect(out.map((c) => c.name)).toEqual(["myplugin:init"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing commands directory is a silent no-op", () => {
    const out: SlashCommand[] = [];
    scanPluginCommands("/nonexistent/path/here", "x", out);
    expect(out).toHaveLength(0);
  });
});

describe("scanPluginSkills", () => {
  test("emits <plugin>:<skill-name> from skills/<skill-name>/SKILL.md", () => {
    const root = mkdtemp("skills");
    try {
      const skillDir = path.join(root, "02-plan-spec");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\ndescription: plan a spec\n---\nbody",
      );
      const out: SlashCommand[] = [];
      scanPluginSkills(root, "idea-plan-execute", out);
      expect(out).toHaveLength(1);
      expect(out[0]?.name).toBe("idea-plan-execute:02-plan-spec");
      expect(out[0]?.description).toBe("plan a spec");
      expect(out[0]?.source).toBe("plugin:idea-plan-execute");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("emits skill name even when SKILL.md is missing", () => {
    // Skill directory exists but no SKILL.md — the dashboard should still
    // surface it so the user can discover it via autocomplete.
    const root = mkdtemp("skills-bare");
    try {
      fs.mkdirSync(path.join(root, "bare-skill"), { recursive: true });
      const out: SlashCommand[] = [];
      scanPluginSkills(root, "myplugin", out);
      expect(out).toHaveLength(1);
      expect(out[0]?.name).toBe("myplugin:bare-skill");
      expect(out[0]?.description).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores stray files at the skills/ top level", () => {
    const root = mkdtemp("skills-files");
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "README.md"), "ignore me");
      const out: SlashCommand[] = [];
      scanPluginSkills(root, "x", out);
      expect(out).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing skills directory is a silent no-op", () => {
    const out: SlashCommand[] = [];
    scanPluginSkills("/nonexistent/path/here", "x", out);
    expect(out).toHaveLength(0);
  });
});
