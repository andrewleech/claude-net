// Multi-account config-dir vocabulary shared by the hub and the
// mirror-agent daemon.
//
// A Claude Code account is identified by its config dir: the directory
// holding settings.json, a projects/ tree of session transcripts, and
// (for a non-default account) its own .claude.json. The default account
// uses <home>/.claude; any other account points CLAUDE_CONFIG_DIR at a
// sibling directory, e.g. ~/.claude-personal.
//
// src/plugin/plugin.ts is served to Claude Code as a single standalone
// file and cannot import this module - it keeps its own small inlined
// copy of the pieces it needs (see its own encodeProjectDirName comment).

import * as fs from "node:fs";
import * as path from "node:path";

/** The default account's config dir: <home>/.claude. */
export function defaultConfigDir(home: string): string {
  return path.join(home, ".claude");
}

/**
 * Absolute, trailing-slash-free, symlink-resolved form of a config dir,
 * so `~/.claude-personal`, `/home/x/.claude-personal/` and a symlinked
 * copy of the same directory all compare equal. realpath is applied only
 * when the directory exists - a not-yet-created dir still normalises to
 * a stable, comparable path.
 */
export function normalizeConfigDir(dir: string): string {
  let resolved = path.resolve(dir);
  if (resolved.length > 1) resolved = resolved.replace(/\/+$/, "");
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Not on disk (yet) or unreadable - keep the resolved-but-unlinked form.
  }
  return resolved;
}

/**
 * Resolve the config dir an environment names, or the default when it
 * names none. `env` is deliberately narrow (just the one key) so callers
 * can pass a `_mirror_env`-shaped object or `process.env` interchangeably.
 */
export function resolveConfigDir(
  env: { CLAUDE_CONFIG_DIR?: string | undefined | null },
  home: string,
): string {
  const raw = env.CLAUDE_CONFIG_DIR;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return normalizeConfigDir(raw);
  }
  return defaultConfigDir(home);
}

/**
 * The .claude.json path for a config dir. Asymmetric: the default
 * account keeps its project metadata at $HOME/.claude.json (there is no
 * ~/.claude/.claude.json on a normal install) and falls back there when
 * it hasn't got its own; a custom config dir always keeps its own
 * .claude.json alongside settings.json inside the dir itself, never the
 * default account's - the $HOME/.claude.json fallback is scoped to the
 * default dir only, so a custom account's scan can never read the
 * default account's project map.
 */
export function claudeJsonPath(configDir: string, home: string): string {
  const local = path.join(configDir, ".claude.json");
  if (isFile(local)) return local;
  if (
    normalizeConfigDir(configDir) === normalizeConfigDir(defaultConfigDir(home))
  ) {
    return path.join(home, ".claude.json");
  }
  return local;
}

const PROJECTS_MARKER = "/projects/";

/**
 * Recover the config dir a transcript path was written under. Claude
 * Code writes every transcript beneath <configDir>/projects/ - the main
 * session at <configDir>/projects/<encoded-cwd>/<sid>.jsonl, a sub-agent
 * at .../<sid>/subagents/agent-<id>.jsonl - so the config dir is
 * everything before the LAST "/projects/" segment. Matching on the last
 * occurrence, rather than counting a fixed number of dirnames, keeps this
 * correct regardless of how deep a sub-agent transcript path nests below
 * it. Works for both `transcript_path` and `agent_transcript_path`.
 * Returns null when the path doesn't contain "/projects/" at all.
 */
export function configDirFromTranscriptPath(
  p: string | undefined | null,
): string | null {
  if (!p) return null;
  const idx = p.lastIndexOf(PROJECTS_MARKER);
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

/**
 * Display label for a config dir: "" for the default account, otherwise
 * the directory's basename with a leading "." and a leading "claude-"
 * stripped (~/.claude-personal -> "personal").
 */
export function accountLabel(configDir: string, home: string): string {
  const normalized = normalizeConfigDir(configDir);
  if (normalized === normalizeConfigDir(defaultConfigDir(home))) return "";
  let base = path.basename(normalized);
  if (base.startsWith(".")) base = base.slice(1);
  if (base.startsWith("claude-")) base = base.slice("claude-".length);
  return base;
}

/**
 * tmux silently rewrites "." and ":" to "_" in a `-s` session name (both
 * are target-syntax delimiters: "session:window.pane"), so a name derived
 * from a directory basename must apply the same substitution before it is
 * compared against or used to create a tmux session - otherwise a
 * dotted or colon-bearing directory name never matches what tmux actually
 * named the session.
 */
export function sanitizeTmuxName(name: string): string {
  return name.replace(/[.:]/g, "_");
}

/**
 * tmux session base name for (cwd, configDir): the sanitized directory
 * basename, plus "-<label>" for a non-default account so the two
 * accounts never collide on the same tmux session name in a shared cwd.
 * The default account has no suffix: this is exactly
 * `sanitizeTmuxName(basename(cwd))`.
 */
export function tmuxSessionBase(
  cwd: string,
  configDir: string,
  home: string,
): string {
  const base = sanitizeTmuxName(path.basename(cwd) || cwd);
  const label = accountLabel(configDir, home);
  return label ? `${base}-${label}` : base;
}

/**
 * Every account config dir this host knows about on disk: the default
 * <home>/.claude first, then any <home>/.claude-* directory holding its
 * own .claude.json, sorted. Claude Code writes .claude.json inside a
 * custom CLAUDE_CONFIG_DIR but keeps the default account's copy in $HOME,
 * so the file marks a directory an account has actually run under. A
 * plain copy of ~/.claude (a backup, or a settings-only sync) has a
 * settings.json but no .claude.json and is not an account.
 * `CLAUDE_CONFIG_DIR` can point anywhere, so this is a starting point,
 * not the full picture - callers union it with config dirs actually
 * observed on live sessions.
 */
export function discoverConfigDirs(home: string): string[] {
  const defaultDir = normalizeConfigDir(defaultConfigDir(home));
  const out = [defaultDir];
  let entries: string[];
  try {
    entries = fs.readdirSync(home);
  } catch {
    return out;
  }
  const extra: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(".claude-")) continue;
    const full = path.join(home, name);
    if (!isDirectory(full)) continue;
    if (isFile(path.join(full, ".claude.json"))) {
      extra.push(normalizeConfigDir(full));
    }
  }
  extra.sort();
  for (const dir of extra) {
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
