#!/usr/bin/env python3
"""CPython harness that drives stdin_repro.py inside a picolet mcp binary.

It launches the child, writes N line-oriented bursts to the child's stdin
separated by deliberate GAP_S-second gaps (stdin stays open across gaps),
then closes stdin. A reader thread collects the child's per-read JSON output.
It then asserts, objectively:

  * read(n) mode is BROKEN: a single blocking read(4096) merges all bursts
    (one non-empty read instead of N) and freezes the event loop, so the
    concurrent 20ms ticker is starved; the next read returns empty (EOF).
  * readline() mode WORKS: each burst yields its own non-empty read whose
    dt_ms reflects the gap, and the ticker keeps ticking across every gap.

stdin is fed and stdout drained on separate threads; communicate() is NOT
used because it closes the child's stdin (instant spurious EOF).

Usage: stdin_repro_driver.py <binary> <script>
"""
import json
import subprocess
import sys
import threading
import time

BIN = sys.argv[1]
SCRIPT = sys.argv[2]

N_BURSTS = 3
GAP_S = 0.5
TICK_MS = 20  # must match stdin_repro.py ticker cadence


def run(mode):
    p = subprocess.Popen(
        [BIN, SCRIPT, mode],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )
    out_lines = []
    err_chunks = []

    def drain(stream, sink):
        for line in iter(stream.readline, b""):
            sink.append(line)

    to = threading.Thread(target=drain, args=(p.stdout, out_lines))
    te = threading.Thread(target=drain, args=(p.stderr, err_chunks))
    to.start()
    te.start()

    def feed():
        time.sleep(GAP_S)  # let the child reach its first stdin wait
        for i in range(N_BURSTS):
            try:
                p.stdin.write(b"burst-%d\n" % i)
                p.stdin.flush()
            except (BrokenPipeError, ValueError, OSError):
                return
            time.sleep(GAP_S)
        try:
            p.stdin.close()  # deliberate EOF after the last gap
        except (BrokenPipeError, ValueError, OSError):
            pass

    tf = threading.Thread(target=feed)
    tf.start()

    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill()
    tf.join()
    to.join()
    te.join()

    reads = []
    done = None
    for raw in out_lines:
        line = raw.decode().strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if "done" in obj:
            done = obj
        else:
            reads.append(obj)
    err = b"".join(err_chunks).decode()
    return reads, done, err


def summarize(mode, reads, done, err):
    print("=== mode=%s ===" % mode)
    for r in reads:
        print("  read i=%d len=%d dt_ms=%d ticks=%d" % (r["i"], r["len"], r["dt_ms"], r["ticks"]))
    if done:
        print("  done reads=%d final_ticks=%d" % (done["reads"], done["final_ticks"]))
    if err.strip():
        print("  stderr: %s" % err.strip().replace("\n", " | "))
    nonempty = [r for r in reads if r["len"] > 0]
    final_ticks = done["final_ticks"] if done else (reads[-1]["ticks"] if reads else 0)
    return {
        "n_reads": len(reads),
        "n_nonempty": len(nonempty),
        "final_ticks": final_ticks,
        "first_empty_i": next((r["i"] for r in reads if r["len"] == 0), None),
    }


def main():
    rb, db, eb = run("read")
    sb = summarize("read", rb, db, eb)
    rl, dl, el = run("readline")
    sl = summarize("readline", rl, dl, el)

    print("\n=== summary ===")
    print("read(n)    :", sb)
    print("readline() :", sl)

    # Objective expectations over N_BURSTS bursts fed across GAP_S gaps.
    #
    # readline() (correct): one non-empty read per burst, and the ticker keeps
    # ticking through every gap. Total wall time ~ (N_BURSTS+1)*GAP_S, so at a
    # TICK_MS cadence a healthy ticker accrues roughly
    #   (N_BURSTS+1)*GAP_S*1000 / TICK_MS
    # ticks. Use half of that as a robust floor.
    healthy_ticks = (N_BURSTS + 1) * GAP_S * 1000.0 / TICK_MS
    tick_floor = healthy_ticks * 0.5

    ok_readline = sl["n_nonempty"] == N_BURSTS and sl["final_ticks"] >= tick_floor

    # read(n) (broken): the blocking fill-to-n read merges bursts (fewer
    # non-empty reads than bursts) and freezes the loop, so far fewer ticks
    # accrue than the readline() control.
    broken_read = (
        sb["n_nonempty"] < N_BURSTS
        and sb["final_ticks"] <= sl["final_ticks"] * 0.5
    )

    print("\nhealthy tick estimate   : %.0f (floor %.0f)" % (healthy_ticks, tick_floor))
    print("readline() works        :", ok_readline)
    print("read(n) exhibits defect :", broken_read)
    verdict = "REPRODUCED" if (ok_readline and broken_read) else "NOT-REPRODUCED"
    print("VERDICT:", verdict)
    return 0 if verdict == "REPRODUCED" else 1


if __name__ == "__main__":
    sys.exit(main())
