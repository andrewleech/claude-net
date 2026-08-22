// Discovery of Claude Code sessions that died without a graceful shutdown.
//
// Claude Code records `lastGracefulShutdown: false` against a project in
// ~/.claude.json while a session is live and flips it to true on a clean
// exit. A process killed by a host shutdown, an OOM, or a closed terminal
// leaves it false, which is the signal this scan keys on.
//
// Everything here is derived from local files. The restore RPC hands the
// dashboard opaque session ids and re-derives cwd from a fresh scan, so no
// caller-supplied path ever reaches the launcher.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RecoverableSession } from "@/shared/types";

/** Transcripts above this size are previewed from their tail, not counted. */
const MAX_FULL_PARSE_BYTES = 32 * 1024 * 1024;
/** Bytes read from the end of an oversized transcript for the preview. */
const TAIL_PARSE_BYTES = 2 * 1024 * 1024;
const PREVIEW_CHARS = 140;

export interface ScanOptions {
  home?: string;
  /**
   * Only surface transcripts written within this window. `null` means no
   * window at all: every matching transcript is returned regardless of
   * age. Omitted defaults to 24h, which is a listing convenience only,
   * not a correctness or security control.
   */
  withinHours?: number | null;
  now?: number;
  /** Session ids the daemon already knows are live. */
  liveSessionIds?: Set<string>;
  /** Working directories the daemon already knows are live. */
  liveCwds?: Set<string>;
  /** Exact-match tmux session probe. */
  tmuxSessionExists?: (name: string) => boolean;
  /** Applied to the preview before it leaves the host. */
  redact?: (text: string) => string;
  /**
   * Skip parsing the transcript body entirely. `label` falls back to the
   * directory basename, `turns` is null, and `preview` is empty. For
   * callers that only need session_id/cwd/needs_trust and want to avoid
   * reading transcript files that can be tens of megabytes each.
   */
  metadataOnly?: boolean;
}

interface ProjectMeta {
  lastGracefulShutdown?: unknown;
  hasTrustDialogAccepted?: unknown;
}

/**
 * Claude Code stores a project's transcripts under a directory named after
 * its cwd with every non-alphanumeric character replaced by a dash, e.g.
 * /home/a/.claude/x → -home-a--claude-x.
 */
export function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
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

export function scanRecoverable(opts: ScanOptions = {}): RecoverableSession[] {
  const home = opts.home ?? os.homedir();
  const now = opts.now ?? Date.now();
  const withinMs =
    opts.withinHours === null
      ? null
      : (opts.withinHours ?? 24) * 60 * 60 * 1000;
  const liveSessionIds = opts.liveSessionIds ?? new Set<string>();
  const liveCwds = opts.liveCwds ?? new Set<string>();
  const redact = opts.redact ?? ((s: string) => s);

  const projects = readProjects(path.join(home, ".claude.json"));
  if (!projects) return [];

  const out: RecoverableSession[] = [];
  for (const [cwd, meta] of Object.entries(projects)) {
    if (meta.lastGracefulShutdown !== false) continue;
    if (liveCwds.has(cwd)) continue;
    if (!isDirectory(cwd)) continue;

    const transcript = newestTranscript(
      path.join(home, ".claude", "projects", encodeProjectDirName(cwd)),
    );
    if (!transcript) continue;
    if (withinMs !== null && now - transcript.mtimeMs > withinMs) continue;

    const sessionId = path.basename(transcript.file, ".jsonl");
    if (liveSessionIds.has(sessionId)) continue;

    const parsed = opts.metadataOnly
      ? { turns: null, preview: "", title: null }
      : parseTranscript(transcript.file, transcript.size);
    const base = path.basename(cwd) || cwd;
    const tmuxName = sanitizeTmuxName(base);
    const conflict = opts.tmuxSessionExists?.(tmuxName) ? tmuxName : null;

    out.push({
      session_id: sessionId,
      cwd,
      label: parsed.title || base,
      last_active: new Date(transcript.mtimeMs).toISOString(),
      turns: parsed.turns,
      preview: redact(parsed.preview).slice(0, PREVIEW_CHARS),
      needs_trust: meta.hasTrustDialogAccepted !== true,
      tmux_conflict: conflict,
    });
  }

  out.sort((a, b) => b.last_active.localeCompare(a.last_active));
  return out;
}

function readProjects(
  claudeJsonPath: string,
): Record<string, ProjectMeta> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(claudeJsonPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { projects?: unknown };
    const projects = parsed.projects;
    if (!projects || typeof projects !== "object") return null;
    const out: Record<string, ProjectMeta> = {};
    for (const [k, v] of Object.entries(projects as Record<string, unknown>)) {
      if (v && typeof v === "object") out[k] = v as ProjectMeta;
    }
    return out;
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function newestTranscript(
  dir: string,
): { file: string; mtimeMs: number; size: number } | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number; size: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { file, mtimeMs: stat.mtimeMs, size: stat.size };
    }
  }
  return best;
}

interface ParsedTranscript {
  turns: number | null;
  preview: string;
  title: string | null;
}

/**
 * Pull the user-turn count, the last real user turn, and any /rename title
 * out of a transcript. Oversized transcripts are read from the tail only,
 * which yields a preview but no reliable turn count.
 */
function parseTranscript(file: string, size: number): ParsedTranscript {
  const truncated = size > MAX_FULL_PARSE_BYTES;
  let text: string;
  try {
    text = truncated
      ? readTail(file, TAIL_PARSE_BYTES)
      : fs.readFileSync(file, "utf8");
  } catch {
    return { turns: null, preview: "", title: null };
  }

  let turns = 0;
  let preview = "";
  let title: string | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A tail read starts mid-line; that one partial line is expected.
      continue;
    }
    if (obj.type === "custom-title" && typeof obj.customTitle === "string") {
      title = obj.customTitle || null;
      continue;
    }
    if (obj.type !== "user" || obj.isMeta === true) continue;
    const t = userText(obj);
    if (!t) continue;
    turns += 1;
    preview = t;
  }

  return { turns: truncated ? null : turns, preview, title };
}

/**
 * Text of a user turn, or "" for anything that isn't a person typing:
 * tool results carry no text parts, and hook/system injections are
 * wrapped in tags rather than prose.
 */
function userText(entry: Record<string, unknown>): string {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (part): part is { text: string } =>
          !!part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join(" ");
  } else {
    return "";
  }
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.startsWith("<")) return "";
  return trimmed;
}

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
