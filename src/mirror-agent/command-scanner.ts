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
// - Plugins, two on-disk layouts:
//     ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{commands,skills}/
//     ~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/{commands,skills}/
//   For each plugin we scan BOTH `commands/` and `skills/` (the v2+ plugin
//   format puts skills at `skills/<skill-name>/SKILL.md`, dispatched as
//   /<plugin>:<skill-name>).
//
// Command name = filename stem (e.g. `00-brainstorm.md` → `00-brainstorm`),
// which is what the user actually types. YAML frontmatter contributes the
// description only.
//
// Plugin-cache subtleties:
//   - Multiple versions can cohabit (1.1.0 + 2.1.0); only the highest is
//     loaded by Claude Code, so we scan only that one. Otherwise stale
//     command names from older versions surface as dead suggestions.
//   - Plugins commonly nest commands under a folder matching the plugin
//     name (`commands/<plugin>/<file>.md`). Claude Code dispatches these
//     as `<plugin>:<file>`, NOT `<plugin>:<plugin>:<file>`. We flatten
//     that duplicate level explicitly.

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

  // Plugin commands + skills — two tree layouts on disk.
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
      //   commands/foo/00-brainstorm.md → `<prefix>:foo:00-brainstorm`
      const nextPrefix = namePrefix
        ? `${namePrefix}:${entry.name}`
        : entry.name;
      scanCommandsDir(fullPath, source, out, nextPrefix);
    }
  }
}

function scanCacheRoot(cacheRoot: string, out: SlashCommand[]): void {
  // Layout: cache/<marketplace>/<plugin>/<version>/{commands,skills}/
  forEachSubdir(cacheRoot, (_mk, mkDir) => {
    forEachSubdir(mkDir, (pluginName, pluginDir) => {
      const versions: string[] = [];
      forEachSubdir(pluginDir, (v) => versions.push(v));
      const latest = pickLatestVersion(versions);
      if (!latest) return;
      const versionDir = path.join(pluginDir, latest);
      scanPluginCommands(path.join(versionDir, "commands"), pluginName, out);
      scanPluginSkills(path.join(versionDir, "skills"), pluginName, out);
    });
  });
}

function scanMarketplacesRoot(root: string, out: SlashCommand[]): void {
  // Layout: marketplaces/<marketplace>/plugins/<plugin>/{commands,skills}/
  forEachSubdir(root, (_mk, mkDir) => {
    const pluginsDir = path.join(mkDir, "plugins");
    forEachSubdir(pluginsDir, (pluginName, pluginDir) => {
      scanPluginCommands(path.join(pluginDir, "commands"), pluginName, out);
      scanPluginSkills(path.join(pluginDir, "skills"), pluginName, out);
    });
  });
}

/** Walk a plugin's `commands/` tree, flattening the
 *  `commands/<plugin-name>/` idiom. Top-level files are dispatched as
 *  `<plugin>:<file>`; non-matching subdirs as `<plugin>:<subdir>:<file>`. */
export function scanPluginCommands(
  commandsDir: string,
  pluginName: string,
  out: SlashCommand[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(commandsDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const cmd = parseCommandFile(full, `plugin:${pluginName}`, pluginName);
      if (cmd) out.push(cmd);
    } else if (entry.isDirectory()) {
      if (entry.name === pluginName) {
        // Plugins commonly nest commands under a folder named after the
        // plugin; Claude Code dispatches these as <plugin>:<file>, not
        // <plugin>:<plugin>:<file>. Flatten the duplicate.
        scanCommandsDir(full, `plugin:${pluginName}`, out, pluginName);
      } else {
        scanCommandsDir(
          full,
          `plugin:${pluginName}`,
          out,
          `${pluginName}:${entry.name}`,
        );
      }
    }
  }
}

/** Walk a plugin's `skills/` tree. Skills live at
 *  `skills/<skill-name>/SKILL.md` and are dispatched as
 *  `<plugin>:<skill-name>` — no further nesting. */
export function scanPluginSkills(
  skillsDir: string,
  pluginName: string,
  out: SlashCommand[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillFile = path.join(skillsDir, skillName, "SKILL.md");
    let description: string | undefined;
    try {
      const fm = parseFrontmatter(fs.readFileSync(skillFile, "utf-8"));
      if (fm.description) description = fm.description.trim();
    } catch {
      // SKILL.md missing or unreadable — still emit the directory name
      // so the autocomplete surfaces a discoverable skill.
    }
    out.push({
      name: `${pluginName}:${skillName}`,
      ...(description ? { description } : {}),
      source: `plugin:${pluginName}`,
    });
  }
}

/** Pick the highest semver-like version from a list of cache version
 *  directory names. Uses `localeCompare` with `numeric: true` so
 *  `2.10.0` sorts after `2.9.0` (lexical sort gets that wrong). Returns
 *  null on an empty list. */
export function pickLatestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;
  const sorted = [...versions].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  return sorted[sorted.length - 1] ?? null;
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
