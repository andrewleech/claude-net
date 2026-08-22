/**
 * In-memory bounded ring buffer of the hub's own stdout/stderr lines.
 *
 * The hub already writes the diagnostics an operator wants — bundle-build
 * failures, store-append failures, orphan-sweep closes — straight to
 * `process.stderr`. Whether anything captures them depends on how the
 * process was launched: under Docker's journald driver with no captured
 * output, they are written and discarded, which leaves an operator with
 * no way to see why the hub misbehaved.
 *
 * Capturing into a ring keeps them queryable over the API without
 * writing anything to disk — the hub is deployed on hosts where disk
 * pressure is itself a suspected cause of trouble, so a log file is the
 * wrong answer. Contents do not survive a restart, and entries roll off
 * once the buffer fills. Same trade as EventLog: observability, not
 * audit.
 *
 * Bounded on BOTH line count and total bytes, because a single runaway
 * writer (a stack trace loop, a multi-megabyte error body) would
 * otherwise pin far more memory than the line count suggests.
 */

export type LogStream = "stdout" | "stderr";

export interface LogLine {
  /** Epoch millis captured when the line completed. */
  ts: number;
  stream: LogStream;
  /** The line, newline stripped, truncated to MAX_LINE_BYTES. */
  text: string;
}

export interface LogQueryOptions {
  /** Include only lines with `ts > since` (exclusive). */
  since?: number;
  /** Max lines returned, most recent kept when trimming. */
  limit?: number;
  /** Restrict to one stream. */
  stream?: LogStream;
}

const DEFAULT_CAPACITY = 2_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** Longest single line retained. Beyond this the tail is dropped. */
const MAX_LINE_BYTES = 8 * 1024;
/**
 * Cap on the not-yet-newline-terminated remainder held per stream. A
 * writer that never emits a newline would otherwise grow it without
 * bound; at the cap the partial is flushed as its own line.
 */
const MAX_PARTIAL_BYTES = MAX_LINE_BYTES;

export class LogRing {
  private readonly buffer: (LogLine | null)[];
  private readonly capacityValue: number;
  private readonly maxBytes: number;
  private head = 0;
  private countValue = 0;
  private bytes = 0;
  /** Lines evicted since start — surfaced so a gap is visible, not silent. */
  private droppedValue = 0;
  /** Per-stream remainder awaiting its newline. */
  private partial: Record<LogStream, string> = { stdout: "", stderr: "" };

  constructor(
    capacity: number = DEFAULT_CAPACITY,
    maxBytes = DEFAULT_MAX_BYTES,
  ) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(
        `LogRing capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.capacityValue = Math.floor(capacity);
    this.maxBytes = maxBytes;
    this.buffer = new Array(this.capacityValue).fill(null);
  }

  get capacity(): number {
    return this.capacityValue;
  }

  get size(): number {
    return this.countValue;
  }

  get dropped(): number {
    return this.droppedValue;
  }

  /**
   * Feed a raw chunk. Chunks are reassembled into lines, so a writer that
   * splits mid-line (or batches several lines into one write) still yields
   * one entry per line.
   */
  write(stream: LogStream, chunk: string): void {
    let rest = this.partial[stream] + chunk;
    let nl = rest.indexOf("\n");
    while (nl !== -1) {
      this.pushLine(stream, rest.slice(0, nl));
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
    // A writer with no trailing newline (process.stdout.write("x")) would
    // otherwise never land, so flush at the cap.
    if (rest.length > MAX_PARTIAL_BYTES) {
      this.pushLine(stream, rest);
      rest = "";
    }
    this.partial[stream] = rest;
  }

  /** Flush any pending partial lines, e.g. before reading at shutdown. */
  flush(): void {
    for (const stream of ["stdout", "stderr"] as LogStream[]) {
      const rest = this.partial[stream];
      if (rest.length > 0) {
        this.pushLine(stream, rest);
        this.partial[stream] = "";
      }
    }
  }

  private pushLine(stream: LogStream, raw: string): void {
    // Strip a trailing \r so CRLF writers don't leave it in the text.
    const stripped = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (stripped.length === 0) return;
    const text =
      stripped.length > MAX_LINE_BYTES
        ? stripped.slice(0, MAX_LINE_BYTES)
        : stripped;
    const entry: LogLine = { ts: Date.now(), stream, text };

    const evicted = this.buffer[this.head];
    if (evicted) {
      this.bytes -= evicted.text.length;
      this.droppedValue++;
    }
    this.buffer[this.head] = entry;
    this.bytes += text.length;
    this.head = (this.head + 1) % this.capacityValue;
    if (this.countValue < this.capacityValue) this.countValue++;

    // Byte ceiling: drop from the oldest end until back under budget.
    while (this.bytes > this.maxBytes && this.countValue > 1) {
      const oldestIdx =
        (this.head - this.countValue + this.capacityValue) % this.capacityValue;
      const oldest = this.buffer[oldestIdx];
      if (!oldest) break;
      this.buffer[oldestIdx] = null;
      this.bytes -= oldest.text.length;
      this.countValue--;
      this.droppedValue++;
    }
  }

  /** Matching lines, oldest first. The buffer itself is never exposed. */
  query(opts: LogQueryOptions = {}): LogLine[] {
    const { since, limit, stream } = opts;
    const results: LogLine[] = [];
    const start =
      (this.head - this.countValue + this.capacityValue) % this.capacityValue;
    for (let i = 0; i < this.countValue; i++) {
      const entry = this.buffer[(start + i) % this.capacityValue];
      if (!entry) continue;
      if (since !== undefined && entry.ts <= since) continue;
      if (stream !== undefined && entry.stream !== stream) continue;
      results.push(entry);
    }
    if (limit !== undefined && limit >= 0 && results.length > limit) {
      return results.slice(results.length - limit);
    }
    return results;
  }
}

type WriteFn = typeof process.stderr.write;

/**
 * Tee `process.stdout` and `process.stderr` into `ring`, leaving the
 * original writes intact so a host that *does* capture output still gets
 * everything. Returns a function that restores the original writers.
 *
 * Safe against reentrancy: a throw inside the ring must not recurse
 * through a stderr write of its own.
 */
export function captureProcessOutput(ring: LogRing): () => void {
  let inWrite = false;

  const tee = (stream: LogStream, original: WriteFn): WriteFn => {
    const wrapped: WriteFn = (
      chunk: string | Uint8Array,
      encodingOrCb?: unknown,
      cb?: unknown,
    ): boolean => {
      if (!inWrite) {
        inWrite = true;
        try {
          ring.write(
            stream,
            typeof chunk === "string"
              ? chunk
              : Buffer.from(chunk).toString("utf8"),
          );
        } catch {
          // Never let capture break the actual write.
        } finally {
          inWrite = false;
        }
      }
      // `original` is already bound to its own stream, so pass through
      // verbatim — including the optional encoding/callback arguments,
      // which a caller may rely on for backpressure.
      return (
        original as (
          c: string | Uint8Array,
          e?: unknown,
          f?: unknown,
        ) => boolean
      )(chunk, encodingOrCb, cb);
    };
    return wrapped;
  };

  // Keep the original property values, not bound copies, so release puts
  // back the exact same function objects. Restoring a bound copy would
  // layer a new closure on every capture/release cycle — one per hub in a
  // process that starts several.
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = tee("stdout", originalOut.bind(process.stdout));
  process.stderr.write = tee("stderr", originalErr.bind(process.stderr));

  return () => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  };
}
