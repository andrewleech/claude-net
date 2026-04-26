// Stream-and-deque reader for backfilling history from a Claude Code
// transcript JSONL. Holds at most `limit` parsed records in memory at
// any time, regardless of file size — important because some long
// sessions produce JSONLs in the hundreds of MB.
//
// Algorithm: read the file once forward, parse each line, push onto a
// fixed-cap circular buffer. When we hit the first line whose record
// timestamp is >= the requested cutoff, the buffer already contains
// the `limit` preceding records (all strictly older than the cutoff)
// and we stop. EOF without crossing the cutoff means the cutoff is
// after every record on disk — return whatever's in the buffer.
//
// Time-based anchoring (rather than uuid-based) is robust against the
// fact that live frames carry synthetic uuids — none of them are
// guaranteed to be present in the JSONL byte-for-byte.

import * as fs from "node:fs";
import type { JsonlRecord } from "./jsonl-tail";

export interface ReadHistoryResult {
  records: JsonlRecord[];
  /** True if the agent reached BOF/EOF without filling `limit`. */
  exhausted: boolean;
}

const READ_CHUNK = 64 * 1024;

/**
 * Read up to `limit` records strictly older than `beforeTs` (epoch ms),
 * in chronological order (oldest first). Records without a parseable
 * timestamp are kept (they sort to "now" and will be returned only if
 * the cutoff is null or in the past — see below).
 *
 * If `beforeTs` is null, returns the last `limit` records from EOF —
 * useful for an "empty transcript" case where the dashboard wants to
 * pull the most-recent history without a known anchor.
 */
export async function readHistoryBefore(
  filePath: string,
  beforeTs: number | null,
  limit: number,
): Promise<ReadHistoryResult> {
  if (limit <= 0) {
    return { records: [], exhausted: true };
  }

  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return { records: [], exhausted: true };
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
        if (beforeTs !== null) {
          const recTs =
            typeof rec.timestamp === "string"
              ? Date.parse(rec.timestamp)
              : Number.NaN;
          // Stop on the first record AT OR AFTER the cutoff. The ring
          // already holds the strictly-older records we want.
          if (Number.isFinite(recTs) && recTs >= beforeTs) {
            stopRequested = true;
            break;
          }
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

  return {
    records: drainRing(),
    exhausted: ringSize < limit,
  };
}
