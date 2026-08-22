// Persisted (ccPid, cwd) → session_id map, so a daemon restart re-attaches
// to the sessions it was already mirroring instead of re-deriving them.
//
// Every hook payload carries the authoritative `session_id`, so the daemon
// always knows the true sid for a live Claude Code. Startup rediscovery,
// running before any hook has fired, has to work it out from /proc and the
// on-disk transcripts instead — and in a directory holding several
// concurrent sessions there is nothing there to tell them apart, so
// `findActiveSessionForCcPid` correctly refuses to guess. The result is
// that multi-session projects stay unmirrored until each one happens to
// fire its next hook, which after a hub upgrade (every daemon self-updates
// and restarts at once) can black out most of a host.
//
// Recording what the hooks already told us removes the guess entirely for
// any session the daemon has seen. A session that has never fired a hook
// has no transcript to mirror yet, so nothing is lost.
//
// Deliberately under /tmp: the keys contain pids, which the kernel reuses
// freely across a reboot. A map that outlived the boot would confidently
// hand out sids for the wrong processes. Entries are re-validated against
// /proc on load regardless, since pids are reused within a boot too.

import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionIndexEntry {
  sid: string;
  cwd: string;
  ccPid: number;
  transcriptPath: string;
  /** Epoch ms the entry was last written. */
  ts: number;
}

/**
 * Entries older than this are dropped on load. A Claude Code alive for
 * longer than this is fine — the entry is refreshed on every session open,
 * and a live pid re-validates anyway; the bound exists so a file that
 * somehow survives (a /tmp that isn't cleared on reboot) can't accumulate
 * indefinitely.
 */
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard cap on retained entries, newest first. */
const MAX_ENTRIES = 512;

export function sessionIndexPath(stateDir: string): string {
  const uid = process.getuid?.() ?? 0;
  return path.join(stateDir, `mirror-sessions-${uid}.json`);
}

/** Key under which an entry is stored. cwd is part of it because a pid
 *  alone is not stable enough to trust after reuse. */
export function indexKey(ccPid: number, cwd: string): string {
  return `${ccPid}:${cwd}`;
}

/**
 * True when `ccPid` is still a live process whose cwd matches. This is the
 * pid-reuse guard: a recycled pid running something else, or the same
 * program in a different directory, must not inherit the mapping.
 */
export function entryStillValid(
  entry: SessionIndexEntry,
  procRoot = "/proc",
): boolean {
  let cwd: string;
  try {
    cwd = fs.readlinkSync(path.join(procRoot, String(entry.ccPid), "cwd"));
  } catch {
    return false;
  }
  if (cwd !== entry.cwd) return false;
  // A transcript that has since been removed (project dir cleaned, session
  // deleted) would make the tail fail on every read.
  try {
    fs.accessSync(entry.transcriptPath, fs.constants.R_OK);
  } catch {
    return false;
  }
  return true;
}

/**
 * Load the index, dropping entries that are stale, malformed, or whose
 * process is gone. Returns an empty map when the file is absent or
 * unreadable — rediscovery then falls back to its heuristics, which is the
 * pre-index behaviour.
 */
export function loadSessionIndex(
  stateDir: string,
  procRoot = "/proc",
  now: number = Date.now(),
): Map<string, SessionIndexEntry> {
  const out = new Map<string, SessionIndexEntry>();
  let raw: string;
  try {
    raw = fs.readFileSync(sessionIndexPath(stateDir), "utf8");
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    const entry = coerceEntry(item);
    if (!entry) continue;
    if (now - entry.ts > MAX_ENTRY_AGE_MS) continue;
    if (!entryStillValid(entry, procRoot)) continue;
    out.set(indexKey(entry.ccPid, entry.cwd), entry);
  }
  return out;
}

/**
 * Write the index. Best-effort: a failure here costs a fallback to the
 * heuristics on the next start, never a running session.
 */
export function saveSessionIndex(
  stateDir: string,
  entries: Iterable<SessionIndexEntry>,
): void {
  const list = [...entries].sort((a, b) => b.ts - a.ts).slice(0, MAX_ENTRIES);
  const file = sessionIndexPath(stateDir);
  try {
    // Write-then-rename so a crash mid-write can't leave a truncated file
    // that the next start would discard wholesale.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // ignore
  }
}

function coerceEntry(v: unknown): SessionIndexEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const sid = typeof o.sid === "string" ? o.sid : "";
  const cwd = typeof o.cwd === "string" ? o.cwd : "";
  const transcriptPath =
    typeof o.transcriptPath === "string" ? o.transcriptPath : "";
  const ccPid = typeof o.ccPid === "number" ? o.ccPid : Number.NaN;
  const ts = typeof o.ts === "number" ? o.ts : Number.NaN;
  if (!sid || !cwd || !transcriptPath) return null;
  if (!Number.isFinite(ccPid) || ccPid <= 0) return null;
  if (!Number.isFinite(ts)) return null;
  // The sid is a Claude Code session UUID; anything else means the file was
  // hand-edited or corrupted.
  if (!/^[0-9a-f-]{32,40}$/i.test(sid)) return null;
  return { sid, cwd, ccPid, transcriptPath, ts };
}

/**
 * In-memory view of the index that flushes to disk on change. One per
 * daemon; `record` is called whenever a session's identity is known.
 */
export class SessionIndex {
  private entries = new Map<string, SessionIndexEntry>();

  constructor(
    private readonly stateDir: string,
    private readonly procRoot = "/proc",
  ) {}

  /** Load from disk, discarding anything no longer valid. */
  load(now: number = Date.now()): void {
    this.entries = loadSessionIndex(this.stateDir, this.procRoot, now);
  }

  /** Entry for a live (ccPid, cwd), or undefined. */
  get(ccPid: number, cwd: string): SessionIndexEntry | undefined {
    return this.entries.get(indexKey(ccPid, cwd));
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Record a session's identity. No-op unless all three facts are known —
   * a session without a ccPid can't be keyed, and one without a transcript
   * path has nothing to re-attach to.
   */
  record(
    sid: string,
    cwd: string | undefined,
    ccPid: number | null | undefined,
    transcriptPath: string | undefined,
    now: number = Date.now(),
  ): void {
    if (!sid || !cwd || !transcriptPath) return;
    if (ccPid === null || ccPid === undefined || !Number.isFinite(ccPid))
      return;
    const key = indexKey(ccPid, cwd);
    const prev = this.entries.get(key);
    if (
      prev &&
      prev.sid === sid &&
      prev.transcriptPath === transcriptPath &&
      now - prev.ts < 60_000
    ) {
      // Unchanged and recently written — skip the disk write so a busy
      // session doesn't rewrite the file on every hook.
      return;
    }
    this.entries.set(key, { sid, cwd, ccPid, transcriptPath, ts: now });
    this.flush();
  }

  /** Forget a session, e.g. once its Claude Code has exited. */
  forget(ccPid: number | null | undefined, cwd: string | undefined): void {
    if (ccPid === null || ccPid === undefined || !cwd) return;
    if (this.entries.delete(indexKey(ccPid, cwd))) this.flush();
  }

  private flush(): void {
    saveSessionIndex(this.stateDir, this.entries.values());
  }
}
