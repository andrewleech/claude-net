// Stream-and-deque reader for backfilling history from a Claude Code
// transcript JSONL. Holds at most `limit` parsed records in memory at
// any time, regardless of file size — important because some long
// sessions produce JSONLs in the hundreds of MB.
//
// Algorithm: read the file once forward, parse each line, push onto a
// fixed-cap circular buffer. When we hit the line whose record matches
// `beforeUuid`, the buffer already contains the `limit` preceding
// records and we stop. EOF without finding the uuid means the request
// either had no anchor (return what we have — the tail of the file) or
// the anchor was a stale uuid we don't have on disk (return empty).

import * as fs from "node:fs";
import type { JsonlRecord } from "./jsonl-tail";

export interface ReadHistoryResult {
  records: JsonlRecord[];
  /** True if the agent reached BOF without filling `limit`. */
  exhausted: boolean;
  /** True only when `beforeUuid` was non-null and never appeared in the file. */
  anchor_missing: boolean;
}

const READ_CHUNK = 64 * 1024;

/**
 * Read up to `limit` records preceding the line whose `uuid === beforeUuid`,
 * in chronological order (oldest first).
 *
 * If `beforeUuid` is null, returns the last `limit` records from EOF —
 * useful for an "empty transcript" case where the dashboard wants to
 * pull the most-recent history without a known anchor.
 */
export async function readHistoryBefore(
  filePath: string,
  beforeUuid: string | null,
  limit: number,
): Promise<ReadHistoryResult> {
  if (limit <= 0) {
    return { records: [], exhausted: true, anchor_missing: false };
  }

  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return { records: [], exhausted: true, anchor_missing: false };
  }

  // Circular buffer of the most-recent `limit` parsed records.
  const ring: JsonlRecord[] = new Array(limit);
  let ringHead = 0;
  let ringSize = 0;

  const pushRing = (rec: JsonlRecord): void => {
    ring[ringHead] = rec;
    ringHead = (ringHead + 1) % limit;
    if (ringSize < limit) ringSize++;
  };

  const drainRing = (): JsonlRecord[] => {
    const out: JsonlRecord[] = [];
    const start = (ringHead - ringSize + limit) % limit;
    for (let i = 0; i < ringSize; i++) {
      out.push(ring[(start + i) % limit] as JsonlRecord);
    }
    return out;
  };

  const buf = Buffer.alloc(READ_CHUNK);
  let lineBuf = "";
  let foundAnchor = false;
  let stopRequested = false;

  try {
    while (!stopRequested) {
      const bytesRead = fs.readSync(fd, buf, 0, READ_CHUNK, null);
      if (bytesRead === 0) break;
      lineBuf += buf.subarray(0, bytesRead).toString("utf8");

      while (true) {
        const idx = lineBuf.indexOf("\n");
        if (idx === -1) break;
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (line.length === 0) continue;
        let rec: JsonlRecord;
        try {
          rec = JSON.parse(line) as JsonlRecord;
        } catch {
          continue;
        }
        if (
          beforeUuid !== null &&
          typeof rec.uuid === "string" &&
          rec.uuid === beforeUuid
        ) {
          foundAnchor = true;
          stopRequested = true;
          break;
        }
        pushRing(rec);
      }
    }
    // Trailing partial line (no newline at EOF) is intentionally dropped.
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }

  const records = drainRing();

  if (beforeUuid === null) {
    // Pure tail-from-EOF read: caller can always ask for more later, so
    // exhaustion is meaningful only if we returned fewer than `limit`.
    return {
      records,
      exhausted: records.length < limit,
      anchor_missing: false,
    };
  }

  if (!foundAnchor) {
    // Anchor was specified but never found in the file. The dashboard
    // can decide what to do (most likely: stop trying — the JSONL was
    // rotated or truncated). Return empty.
    return { records: [], exhausted: true, anchor_missing: true };
  }

  // Anchor found: the ring holds up to `limit` records strictly before it.
  return {
    records,
    exhausted: records.length < limit,
    anchor_missing: false,
  };
}
