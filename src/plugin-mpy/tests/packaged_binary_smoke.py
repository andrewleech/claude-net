#!/usr/bin/env python3
"""Smoke test for the packaged single-file claude-net plugin binary.

`parity_harness.py` and `ceremony_tests.py` invoke the mcp runtime as an
interpreter against the source-tree `plugin.py` (`[MPY_BINARY,
"plugin.py"]`) -- that is the P7 parity gate for plugin behaviour, and
this script does not replace it. `picolet build` (driven by
`picolet.toml` in this directory) instead appends the plugin's own romfs,
compiled to `.mpy`, to the runtime and produces a single-file,
argument-less executable (app-runner mode: the runtime auto-runs
`/rom/main.mpy`). This script is the packaging-specific counterpart: it
drives the packaged artifact through an MCP handshake to confirm the
appended romfs resolves `import plugin` / `import mpyfastmcp` /
`import mpyws` etc. with no sys.path hacks, and that tool/prompt
registration survives the packaging step unchanged.

Runs fully offline (no CLAUDE_NET_HUB) -- tool calls that need the hub are
expected to return their documented "not connected" error text, which is
itself evidence the call reached real `_hub`/`mpyws`/`mpyjsonrpc` code
loaded from the appended romfs rather than failing at import time.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

DEFAULT_BINARY = (
    Path(__file__).resolve().parents[1] / "target" / "linux-x64" / "claude-net-plugin"
)

EXPECTED_TOOL_NAMES = {
    "whoami",
    "register",
    "send_message",
    "send_team",
    "join_team",
    "leave_team",
    "list_agents",
    "list_teams",
    "ping",
    "_ack_channel",
    "hub_events",
}


class Session:
    def __init__(self, binary: Path):
        self.proc = subprocess.Popen(
            [str(binary)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin"},
            text=True,
            bufsize=1,
        )

    def send(self, msg: dict) -> None:
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def recv(self, timeout: float = 10.0) -> dict:
        line = self.proc.stdout.readline()
        if not line:
            stderr = self.proc.stderr.read()
            raise AssertionError(f"packaged binary exited with no response; stderr:\n{stderr}")
        return json.loads(line)

    def close(self) -> str:
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        return self.proc.stderr.read()


def run_smoke(binary: Path) -> None:
    if not binary.is_file():
        raise AssertionError(f"packaged binary not found: {binary}")

    session = Session(binary)

    session.send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "packaged-binary-smoke", "version": "0"},
            },
        }
    )
    init_resp = session.recv()
    assert "result" in init_resp, f"initialize failed: {init_resp}"
    assert "instructions" in init_resp["result"], "initialize response missing instructions text"

    session.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    session.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    tools_resp = session.recv()
    tool_names = {t["name"] for t in tools_resp["result"]["tools"]}
    assert tool_names == EXPECTED_TOOL_NAMES, (
        f"tool set mismatch: got {sorted(tool_names)}, "
        f"expected {sorted(EXPECTED_TOOL_NAMES)}"
    )

    session.send({"jsonrpc": "2.0", "id": 3, "method": "prompts/list", "params": {}})
    prompts_resp = session.recv()
    prompt_names = {p["name"] for p in prompts_resp["result"]["prompts"]}
    assert prompt_names == {"rename"}, f"prompt set mismatch: got {sorted(prompt_names)}"

    # Offline tool call: proves the call path (mpyfastmcp dispatch ->
    # plugin.py handler -> mpyjsonrpc/mpyws/_hub modules) executes for
    # real from the appended romfs, not just that tools/list metadata is
    # served.
    session.send(
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "ping", "arguments": {}}}
    )
    ping_resp = session.recv()
    ping_text = ping_resp["result"]["content"][0]["text"]
    assert "CLAUDE_NET_HUB" in ping_text, f"unexpected offline ping response: {ping_resp}"

    stderr = session.close()
    print(f"OK: {binary}")
    print(f"  tools: {len(tool_names)} ({', '.join(sorted(tool_names))})")
    print(f"  prompts: {', '.join(sorted(prompt_names))}")
    if stderr.strip():
        print(f"  stderr: {stderr.strip()}")


def main() -> int:
    binary = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_BINARY
    try:
        run_smoke(binary)
    except AssertionError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
