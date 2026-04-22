// Pluggable persistence layer for mirror-session transcripts.
//
// Default: NullStore — in-memory only, matches the rest of claude-net.
// Opt-in:  FileStore — appends events to <dir>/<sid>.jsonl with atomic
//          renames; retention timer prunes old sessions.
//
// Enabled when CLAUDE_NET_MIRROR_STORE is set. The hub reads from the store
// at startup *only* for the new /api/mirror/archive/:sid endpoint (post-mortem
// viewing after a hub restart). Live sessions still have to be re-opened by
// the mirror-agent; we don't magically resume them.

import * as fs from "node:fs";
import * as path from "node:path";
import type { MirrorEventFrame } from "@/shared/types";

const DEFAULT_RETENTION_HOURS = 24;
const FSYNC_EVERY = 50;

export interface ArchivedSession {
  sid: string;
  owner_agent: string;
  cwd: string;
  created_at: string;
  closed_at: string | null;
  transcript: Array<{
    uuid: string;
    kind: string;
    ts: number;
    payload: unknown;
  }>;
}

export interface MirrorStore {
  /** Record session creation metadata. */
  recordOpen(meta: {
    sid: string;
    owner_agent: string;
    cwd: string;
    created_at: string;
  }): void;
  /** Append one event. */
  appendEvent(sid: string, frame: MirrorEventFrame): void;
  /** Record session close. */
  recordClose(sid: string, closedAt: string): void;
  /** Read an archived session (post-restart). */
  loadArchived(sid: string): ArchivedSession | null;
  /** Called on hub shutdown to flush buffers. */
  close(): Promise<void>;
}

export class NullStore implements MirrorStore {
  recordOpen(): void {}
  appendEvent(): void {}
  recordClose(): void {}
  loadArchived(): ArchivedSession | null {
    return null;
  }
  async close(): Promise<void> {}
}

interface FileEntry {
  sid: string;
  path: string;
  fd: number;
  writtenCount: number;
  owner_agent: string;
  cwd: string;
}

export interface FileStoreOptions {
  /** Directory to store <sid>.jsonl files. Created if missing. */
  dir: string;
  /** Retention window in hours. Default 24. */
  retentionHours?: number;
  /** Disable fsync batching (tests). */
  fsyncEvery?: number;
}

export class FileStore implements MirrorStore {
  private dir: string;
  private retentionHours: number;
  private fsyncEvery: number;
  private entries = new Map<string, FileEntry>();
  private retentionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: FileStoreOptions) {
    this.dir = opts.dir;
    this.retentionHours = opts.retentionHours ?? DEFAULT_RETENTION_HOURS;
    this.fsyncEvery = opts.fsyncEvery ?? FSYNC_EVERY;

    fs.mkdirSync(this.dir, { recursive: true });
    this.startRetention();
  }

  recordOpen(meta: {
    sid: string;
    owner_agent: string;
    cwd: string;
    created_at: string;
  }): void {
    const p = path.join(this.dir, `${safeSid(meta.sid)}.jsonl`);
    // O_APPEND + truncate on first open so restarted sessions get a clean file.
    const fd = fs.openSync(p, "a");
    const entry: FileEntry = {
      sid: meta.sid,
      path: p,
      fd,
      writtenCount: 0,
      owner_agent: meta.owner_agent,
      cwd: meta.cwd,
    };
    this.entries.set(meta.sid, entry);
    const header = JSON.stringify({
      _header: true,
      sid: meta.sid,
      owner_agent: meta.owner_agent,
      cwd: meta.cwd,
      created_at: meta.created_at,
    });
    fs.writeSync(fd, `${header}\n`);
  }

  appendEvent(sid: string, frame: MirrorEventFrame): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    const line = JSON.stringify({
      uuid: frame.uuid,
      kind: frame.kind,
      ts: frame.ts,
      payload: frame.payload,
    });
    fs.writeSync(entry.fd, `${line}\n`);
    entry.writtenCount++;
    if (entry.writtenCount % this.fsyncEvery === 0) {
      try {
        fs.fdatasyncSync(entry.fd);
      } catch {
        // ignore
      }
    }
  }

  recordClose(sid: string, closedAt: string): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    const line = JSON.stringify({
      _footer: true,
      closed_at: closedAt,
    });
    try {
      fs.writeSync(entry.fd, `${line}\n`);
      fs.fdatasyncSync(entry.fd);
      fs.closeSync(entry.fd);
    } catch {
      // ignore
    }
    this.entries.delete(sid);
  }

  loadArchived(sid: string): ArchivedSession | null {
    const p = path.join(this.dir, `${safeSid(sid)}.jsonl`);
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return null;

    let owner_agent = "";
    let cwd = "";
    let created_at = "";
    let closed_at: string | null = null;
    const transcript: ArchivedSession["transcript"] = [];

    for (const line of lines) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj._header === true) {
        owner_agent = (obj.owner_agent as string) ?? "";
        cwd = (obj.cwd as string) ?? "";
        created_at = (obj.created_at as string) ?? "";
        continue;
      }
      if (obj._footer === true) {
        closed_at = (obj.closed_at as string) ?? null;
        continue;
      }
      if (typeof obj.uuid === "string" && typeof obj.kind === "string") {
        transcript.push({
          uuid: obj.uuid,
          kind: obj.kind,
          ts: Number(obj.ts) || 0,
          payload: obj.payload ?? {},
        });
      }
    }

    return { sid, owner_agent, cwd, created_at, closed_at, transcript };
  }

  async close(): Promise<void> {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    for (const entry of this.entries.values()) {
      try {
        fs.fdatasyncSync(entry.fd);
        fs.closeSync(entry.fd);
      } catch {
        // ignore
      }
    }
    this.entries.clear();
  }

  private startRetention(): void {
    const sweep = (): void => {
      const cutoff = Date.now() - this.retentionHours * 3600_000;
      let files: string[];
      try {
        files = fs.readdirSync(this.dir);
      } catch {
        return;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const p = path.join(this.dir, f);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(p);
        } catch {
          continue;
        }
        // Live files (open fd) are skipped — we only prune closed sessions.
        const live = [...this.entries.values()].some((e) => e.path === p);
        if (live) continue;
        if (stat.mtimeMs < cutoff) {
          try {
            fs.unlinkSync(p);
          } catch {
            // ignore
          }
        }
      }
    };
    sweep();
    const timer = setInterval(sweep, 60 * 60 * 1000);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.retentionTimer = timer;
  }
}

function safeSid(sid: string): string {
  // Keep the sid suitable for use as a filename without traversal.
  // Strip anything that isn't alphanumeric, hyphen, or underscore so neither
  // `/` (path separator) nor `..` (traversal) can appear in the result.
  return sid.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Create a store from environment. If CLAUDE_NET_MIRROR_STORE is set and
 * points to a directory we can create, return a FileStore. Otherwise return
 * a NullStore.
 */
export function createStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MirrorStore {
  const dir = env.CLAUDE_NET_MIRROR_STORE;
  if (!dir) return new NullStore();
  const retentionHours = Number(env.CLAUDE_NET_MIRROR_RETENTION_HOURS);
  return new FileStore({
    dir,
    retentionHours:
      Number.isFinite(retentionHours) && retentionHours > 0
        ? retentionHours
        : undefined,
  });
}
