// Tails a Claude Code session JSONL transcript for reconciliation with the
// hook stream. Yields one parsed record per complete line as it appears.
// Small files are read from the start; large files (> INITIAL_TAIL_MAX_BYTES)
// are read from a bounded window before EOF so a huge transcript isn't read
// whole. Dedup against the hook stream is by uuid, in the caller. Uses
// fs.watch plus a fallback poller in case inotify doesn't fire (WSL /
// network filesystems).
//
// This is a safety net, not the primary capture — the hook stream delivers
// events in real time. JSONL reconciliation closes gaps from dropped hooks
// and restores recent transcript after a mirror-agent restart.

import * as fs from "node:fs";

const POLL_INTERVAL_MS = 1000;
// On first attach to an existing transcript, read only this many bytes
// before EOF rather than the whole file — reading a multi-hundred-MB
// session whole would allocate a size-of-file buffer and block the event
// loop. The hook stream + the hub's bounded ring cover recent events, and
// deep history has its own on-demand backfill path.
const INITIAL_TAIL_MAX_BYTES = 512 * 1024;
// Cap bytes read per readMore() call so a single call can't allocate a
// giant buffer or block; the remainder is drained on later ticks.
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

export interface JsonlRecord {
  uuid?: string;
  type?: string;
  timestamp?: string;
  sessionId?: string;
  // Forward-compatible.
  [key: string]: unknown;
}

export interface TailOptions {
  onRecord: (record: JsonlRecord) => void;
  onError?: (err: Error) => void;
  pollIntervalMs?: number;
}

export interface TailHandle {
  stop(): void;
}

/**
 * Start tailing a JSONL file. If the file does not exist yet, poll for it.
 */
export function tailJsonl(filePath: string, opts: TailOptions): TailHandle {
  let offset = 0;
  let buffer = "";
  let stopped = false;
  let firstRead = true;
  // After a mid-file seek on the first read, the leading partial line is
  // dropped so the first parsed record is complete.
  let skipPartialLine = false;
  let drainScheduled = false;
  let watcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const pollInterval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  const readMore = (): void => {
    if (stopped) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return; // file doesn't exist yet
    }
    if (stat.size < offset) {
      // File was truncated or replaced — restart from beginning.
      offset = 0;
      buffer = "";
      firstRead = true;
      skipPartialLine = false;
    }
    if (firstRead) {
      firstRead = false;
      if (stat.size > INITIAL_TAIL_MAX_BYTES) {
        offset = stat.size - INITIAL_TAIL_MAX_BYTES;
        skipPartialLine = true;
      }
    }
    if (stat.size <= offset) return;

    // Track whether this call actually advanced. A readSync error or a
    // short/zero read (stat can transiently over-report readable size on
    // 9p/WSL/network mounts) must NOT re-arm the 0 ms drain below, or the
    // tail spins in a busy-loop re-firing onError every pass.
    const startOffset = offset;

    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch (err) {
      opts.onError?.(err as Error);
      return;
    }
    try {
      // Cap each read so one call can't allocate a huge buffer or block.
      const length = Math.min(stat.size - offset, READ_CHUNK_BYTES);
      const chunk = Buffer.alloc(length);
      const bytes = fs.readSync(fd, chunk, 0, length, offset);
      offset += bytes;
      buffer += chunk.subarray(0, bytes).toString("utf8");
    } catch (err) {
      opts.onError?.(err as Error);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }

    if (skipPartialLine) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) {
        // No line boundary in the window yet — drop it and wait for more.
        buffer = "";
      } else {
        buffer = buffer.slice(nl + 1);
        skipPartialLine = false;
      }
    }

    if (!skipPartialLine) {
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim().length > 0) {
          try {
            const rec = JSON.parse(line) as JsonlRecord;
            opts.onRecord(rec);
          } catch (err) {
            opts.onError?.(err as Error);
          }
        }
        newlineIdx = buffer.indexOf("\n");
      }
    }

    // A large backlog remains (capped read above) — continue on a fresh
    // tick so we yield the event loop between chunks instead of blocking.
    // Only reschedule if we made forward progress this pass; otherwise the
    // regular poll retries, so a persistent read error can't 0 ms-spin.
    if (
      !stopped &&
      offset > startOffset &&
      stat.size > offset &&
      !drainScheduled
    ) {
      drainScheduled = true;
      const t = setTimeout(() => {
        drainScheduled = false;
        readMore();
      }, 0);
      if (t && typeof t === "object" && "unref" in t) t.unref();
    }
  };

  const startWatcher = (): void => {
    try {
      watcher = fs.watch(filePath, { persistent: false }, () => {
        readMore();
      });
      // FSWatcher emits "error" on WSL2 / network filesystems. Without a
      // handler this is an uncaught exception that kills the process.
      watcher.on("error", (err: Error) => {
        opts.onError?.(err);
        try {
          watcher?.close();
        } catch {
          /* ignore */
        }
        watcher = null;
        // Poller will re-create the watcher on the next tick.
      });
    } catch {
      // fs.watch may not be available (e.g. file doesn't exist); rely on poller.
    }
  };

  const poll = (): void => {
    if (stopped) return;
    readMore();
    if (!watcher) startWatcher();
    pollTimer = setTimeout(poll, pollInterval);
    if (pollTimer && typeof pollTimer === "object" && "unref" in pollTimer) {
      pollTimer.unref();
    }
  };

  // Initial read + start watcher + start poller.
  readMore();
  startWatcher();
  pollTimer = setTimeout(poll, pollInterval);
  if (pollTimer && typeof pollTimer === "object" && "unref" in pollTimer) {
    pollTimer.unref();
  }

  return {
    stop(): void {
      stopped = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watcher = null;
      }
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    },
  };
}
