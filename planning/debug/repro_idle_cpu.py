#!/usr/bin/env python3
"""Reproduce the packaged mpy plugin's idle CPU burn + ~31s hub reconnect loop.

Drives the packaged binary the way Claude Code does: MCP initialize handshake,
then stdin held open with NO further traffic. Samples /proc CPU and timestamps
every stderr breadcrumb so reconnect cadence is directly measurable.

Env: PLUGIN_BIN, CLAUDE_NET_HUB, DURATION (s), REPRO_CWD (sets the agent name).
"""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

BIN = os.environ.get("PLUGIN_BIN", "/home/corona/claude-net-mpy/build/claude-net-plugin-linux-x64")
HUB = os.environ.get("CLAUDE_NET_HUB", "https://telie.story-kettle.ts.net:4815")
DURATION = int(os.environ.get("DURATION", "120"))
CWD = os.environ.get("REPRO_CWD", "/tmp/mpy-repro-idle")
HZ = os.sysconf("SC_CLK_TCK")

os.makedirs(CWD, exist_ok=True)
env = dict(os.environ, CLAUDE_NET_HUB=HUB,
           CLAUDE_NET_LOG_LEVEL=os.environ.get("CLAUDE_NET_LOG_LEVEL", "debug"))

# ptrace_scope=1 forbids attaching to a non-descendant, so trace by spawning.
# STRACE_OUT -> syscall summary; STRACE_TIMELINE -> per-call timeline.
cmd = [BIN]
if os.environ.get("STRACE_OUT"):
    cmd = ["strace", "-f", "-c", "-o", os.environ["STRACE_OUT"]] + cmd
elif os.environ.get("STRACE_TIMELINE"):
    cmd = ["strace", "-f", "-tt", "-T",
           "-e", "trace=%s" % os.environ.get("STRACE_EVENTS", "poll,ppoll,select,epoll_wait,read,recvfrom,ioctl,clock_gettime"),
           "-o", os.environ["STRACE_TIMELINE"]] + cmd

proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, cwd=CWD, env=env, bufsize=0)
t0 = time.time()
events = []


def pump(stream, tag):
    for raw in iter(stream.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip()
        if line:
            events.append((time.time() - t0, tag, line))


for s, tag in ((proc.stderr, "err"), (proc.stdout, "out")):
    threading.Thread(target=pump, args=(s, tag), daemon=True).start()


def send(obj):
    proc.stdin.write((json.dumps(obj) + "\n").encode())
    proc.stdin.flush()


def cpu_ticks():
    try:
        with open("/proc/%d/stat" % proc.pid) as f:
            p = f.read().rsplit(") ", 1)[1].split()
        return int(p[11]) + int(p[12])          # utime + stime (after comm)
    except (OSError, IndexError, ValueError):
        return None


def rss_kb():
    try:
        with open("/proc/%d/status" % proc.pid) as f:
            for ln in f:
                if ln.startswith("VmRSS:"):
                    return int(ln.split()[1])
    except OSError:
        pass
    return None


print("pid=%d bin=%s hub=%s dur=%ds cwd=%s" % (proc.pid, BIN, HUB, DURATION, CWD))
send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                 "clientInfo": {"name": "repro-idle", "version": "1"}}})
time.sleep(1.5)
send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

# ---- idle: sample CPU, send nothing ----
base = cpu_ticks()
t_start = time.time()
samples = []
last_t, last_c = t_start, base
while time.time() - t_start < DURATION:
    time.sleep(10)
    if proc.poll() is not None:
        print("!! process exited early rc=%s" % proc.returncode)
        break
    c, now = cpu_ticks(), time.time()
    if c is None:
        break
    pct = 100.0 * ((c - last_c) / HZ) / (now - last_t)
    samples.append(pct)
    print("  t=%3ds  cpu=%5.2f%%  rss=%sKB" % (now - t_start, pct, rss_kb()))
    last_t, last_c = now, c

total = cpu_ticks()
elapsed = time.time() - t_start
# strace only writes its -c summary when it detaches cleanly: SIGINT, not SIGTERM.
proc.send_signal(signal.SIGINT if cmd[0] == "strace" else signal.SIGTERM)
try:
    proc.wait(timeout=8)
except subprocess.TimeoutExpired:
    proc.kill()

print("\n=== CPU ===")
if total is not None and base is not None:
    print("  mean over %.0fs: %.2f%% of one core  (healthy baseline ~0.2%%, bug ~3.5%%)"
          % (elapsed, 100.0 * ((total - base) / HZ) / elapsed))
if samples:
    print("  samples: %s" % " ".join("%.1f" % s for s in samples))

print("\n=== stderr timeline ===")
for t, tag, line in events:
    print("  %7.2fs [%s] %s" % (t, tag, line))

# ---- reconnect cadence ----
marks = [t for t, _, l in events
         if re.search(r"reconnect|watchdog|closed|connect|disconnect", l, re.I)]
print("\n=== reconnect/watchdog cadence ===")
if len(marks) >= 2:
    gaps = [b - a for a, b in zip(marks, marks[1:])]
    print("  %d events; gaps: %s" % (len(marks), " ".join("%.1f" % g for g in gaps)))
    print("  -> LOOP REPRODUCED" if any(25 < g < 40 for g in gaps)
          else "  -> no ~31s cadence")
else:
    print("  %d event(s) — no loop observed" % len(marks))
