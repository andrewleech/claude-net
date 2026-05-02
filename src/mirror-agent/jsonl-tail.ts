// Tails a Claude Code session JSONL transcript for reconciliation with the
// hook stream. Yields one parsed record per complete line as it appears,
// starting from byte 0 (so the reconciler sees everything and dedupes by
// uuid). Uses fs.watch plus a fallback poller in case inotify doesn't fire
// (WSL / network filesystems).
//
// This is a safety net, not the primary capture — the hook stream delivers
// events in real time. JSONL reconciliation closes any gaps from dropped
// hooks and restores transcripts after a mirror-agent restart.

import * as fs from "node:fs";

const POLL_INTERVAL_MS = 1000;

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
    }
    if (stat.size === offset) return;

    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch (err) {
      opts.onError?.(err as Error);
      return;
    }
    try {
      const length = stat.size - offset;
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
