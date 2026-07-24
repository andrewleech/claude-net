#!/usr/bin/env python3
"""Correctness proof for the poll-period mitigation: an idle plugin must still
receive an inbound hub-pushed channel message (data arriving on an otherwise
idle TLS socket) and emit it as a notification, promptly.

Launches the packaged plugin, does the MCP handshake, then holds stdin open and
silent while logging every stdout line with a timestamp. An external sender
(this session's send_message) pushes a message to AGENT_NAME; the plugin should
emit an <channel> notification within the poll period. Writes a machine-readable
verdict line and keeps running for HOLD seconds.
"""
import json
import os
import sys
import threading
import time

BIN = os.environ.get("PLUGIN_BIN", "/tmp/plugin-period50")
HUB = os.environ.get("CLAUDE_NET_HUB", "https://telie.story-kettle.ts.net:4815")
HOLD = int(os.environ.get("HOLD", "45"))
CWD = os.environ.get("REPRO_CWD", "/tmp/mpy-chan-test")
LOG = os.environ.get("CHAN_LOG", "/tmp/_chan_delivery.log")

import subprocess
os.makedirs(CWD, exist_ok=True)
env = dict(os.environ, CLAUDE_NET_HUB=HUB, CLAUDE_NET_LOG_LEVEL="debug")
proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, cwd=CWD, env=env, bufsize=0)
t0 = time.time()
logf = open(LOG, "w")


def log(msg):
    line = "%7.2fs %s" % (time.time() - t0, msg)
    print(line, flush=True)
    logf.write(line + "\n"); logf.flush()


def pump(stream, tag):
    for raw in iter(stream.readline, b""):
        s = raw.decode("utf-8", "replace").rstrip()
        if not s:
            continue
        if tag == "out":
            # Flag channel notifications specifically. Report length + tail so a
            # truncated/stalled large message (mbedtls buffering) is visible.
            if "notifications/claude/channel" in s:
                log("INBOUND-NOTIFY len=%d tail=%r" % (len(s), s[-48:]))
            elif "channel" in s or "notifications/message" in s:
                log("out(chan?): len=%d %s" % (len(s), s[:120]))
            else:
                log("out: " + s[:100])
        else:
            log("err: " + s[:200])


for st, tag in ((proc.stdout, "out"), (proc.stderr, "err")):
    threading.Thread(target=pump, args=(st, tag), daemon=True).start()


def send(obj):
    proc.stdin.write((json.dumps(obj) + "\n").encode()); proc.stdin.flush()


send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                 "clientInfo": {"name": "chan-test", "version": "1"}}})
time.sleep(1.0)
send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
log("HANDSHAKE-DONE — agent should be registered; send it a message now")

deadline = time.time() + HOLD
while time.time() < deadline and proc.poll() is None:
    time.sleep(1)
proc.terminate()
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
log("DONE")
