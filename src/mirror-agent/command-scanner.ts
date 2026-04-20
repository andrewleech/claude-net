// Slash-command scanner for the mirror-agent.
//
// Walks the .claude directory trees for a given session's cwd and returns
// a deduplicated list of {name, description, source} tuples suitable for
// the web dashboard's autocomplete popover.
//
// Sources checked:
// - Claude Code built-ins (hard-coded list below).
// - ~/.claude/commands/**/*.md     — user commands (recursive).
// - <cwd>/.claude/commands/**/*.md — project-local commands (recursive).
// - ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/**/*.md
// - ~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/commands/**/*.md
//
// Command name = filename stem (e.g. `00-brainstorm.md` → `00-brainstorm`),
// which is what the user actually types. YAML frontmatter contributes the
// description only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SlashCommand {
  name: string;
  description?: string;
  source: string;
}

/** Claude Code's built-in slash commands. Names only — descriptions are
 *  sourced from the official docs. Not exhaustive, just the common ones a
 *  user types regularly. */
const BUILT_INS: SlashCommand[] = [
  { name: "help", description: "Show available commands", source: "builtin" },
  { name: "clear", description: "Clear the conversation", source: "builtin" },
  {
    name: "compact",
    description: "Compact the conversation",
    source: "builtin",
  },
  { name: "cost", description: "Show token usage + cost", source: "builtin" },
  {
    name: "doctor",
    description: "Diagnose Claude Code config",
    source: "builtin",
  },
  { name: "export", description: "Export the conversation", source: "builtin" },
  { name: "init", description: "Initialise CLAUDE.md", source: "builtin" },
  { name: "login", description: "Sign in to Anthropic", source: "builtin" },
  { name: "logout", description: "Sign out", source: "builtin" },
  { name: "mcp", description: "Manage MCP servers", source: "builtin" },
  { name: "memory", description: "Manage memory", source: "builtin" },
  { name: "model", description: "Switch model", source: "builtin" },
  { name: "pr-comments", description: "Review a PR", source: "builtin" },
  { name: "privacy", description: "Privacy settings", source: "builtin" },
  {
    name: "release-notes",
    description: "Show release notes",
    source: "builtin",
  },
  {
    name: "resume",
    description: "Resume a prior conversation",
    source: "builtin",
  },
  { name: "rewind", description: "Rewind the conversation", source: "builtin" },
  { name: "status", description: "Show Claude Code status", source: "builtin" },
  { name: "config", description: "Configure Claude Code", source: "builtin" },
];

export function scanCommands(cwd: string | undefined): SlashCommand[] {
  const out: SlashCommand[] = [...BUILT_INS];
  const home = os.homedir();

  // User commands (recursive).
  scanCommandsDir(path.join(home, ".claude", "commands"), "user", out);

  // Project-local commands (recursive).
  if (cwd && cwd.length > 0) {
    scanCommandsDir(path.join(cwd, ".claude", "commands"), "project", out);
  }

  // Plugin commands — two tree layouts on disk:
  //   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/**/*.md
  //   ~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/commands/**/*.md
  const cacheRoot = path.join(home, ".claude", "plugins", "cache");
  scanCacheRoot(cacheRoot, out);
  const marketplacesRoot = path.join(
    home,
    ".claude",
    "plugins",
    "marketplaces",
  );
  scanMarketplacesRoot(marketplacesRoot, out);

  // Deduplicate — first-seen wins so built-ins aren't clobbered by a
  // user command of the same name.
  const seen = new Set<string>();
  return out.filter((c) => {
    if (!c.name) return false;
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

function scanCommandsDir(
  dir: string,
  source: string,
  out: SlashCommand[],
  namePrefix = "",
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const cmd = parseCommandFile(fullPath, source, namePrefix);
      if (cmd) out.push(cmd);
    } else if (entry.isDirectory()) {
      // Nested subdirs extend the namespace, e.g.
      //   commands/idea-plan-execute/00-brainstorm.md → `<plugin>:idea-plan-execute:00-brainstorm`
      const nextPrefix = namePrefix
        ? `${namePrefix}:${entry.name}`
        : entry.name;
      scanCommandsDir(fullPath, source, out, nextPrefix);
    }
  }
}

function scanCacheRoot(cacheRoot: string, out: SlashCommand[]): void {
  // Layout: cache/<marketplace>/<plugin>/<version>/commands/
  forEachSubdir(cacheRoot, (_mk, mkDir) => {
    forEachSubdir(mkDir, (pluginName, pluginDir) => {
      forEachSubdir(pluginDir, (_version, versionDir) => {
        scanCommandsDir(
          path.join(versionDir, "commands"),
          `plugin:${pluginName}`,
          out,
          pluginName,
        );
      });
    });
  });
}

function scanMarketplacesRoot(root: string, out: SlashCommand[]): void {
  // Layout: marketplaces/<marketplace>/plugins/<plugin>/commands/
  forEachSubdir(root, (_mk, mkDir) => {
    const pluginsDir = path.join(mkDir, "plugins");
    forEachSubdir(pluginsDir, (pluginName, pluginDir) => {
      scanCommandsDir(
        path.join(pluginDir, "commands"),
        `plugin:${pluginName}`,
        out,
        pluginName,
      );
    });
  });
}

function forEachSubdir(
  dir: string,
  fn: (name: string, fullPath: string) => void,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    fn(entry.name, path.join(dir, entry.name));
  }
}

/** Parse YAML frontmatter at the top of a command .md file. Tolerant of
 *  missing / malformed frontmatter. `namePrefix` prepends the plugin /
 *  nested-dir namespace (joined by colons), matching how Claude Code
 *  dispatches `<plugin>:<subdir>:<file>` slash commands. */
export function parseCommandFile(
  filePath: string,
  source: string,
  namePrefix = "",
): SlashCommand | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const fallbackName = path.basename(filePath, ".md");
  const fm = parseFrontmatter(content);
  const bareName = (fm.name ?? fallbackName).trim();
  if (!bareName) return null;
  const name = namePrefix ? `${namePrefix}:${bareName}` : bareName;
  return {
    name,
    ...(fm.description ? { description: fm.description.trim() } : {}),
    source,
  };
}

/** Minimal YAML-frontmatter parser: extracts the `---` block at the top of
 *  a markdown file and returns a flat string→string map. Only handles the
 *  subset we actually see in Claude Code command files (simple `key: value`
 *  pairs); anything more exotic falls through as undefined. */
export function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) return result;
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) return result;
  const block = trimmed.slice(3, end).replace(/^\n/, "");
  const lines = block.split("\n");
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}
