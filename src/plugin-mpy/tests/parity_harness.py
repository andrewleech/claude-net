#!/usr/bin/env python3
"""
Parity harness: run identical MCP client scenarios against both the bun
plugin and the mpy plugin, diff: tools/list, prompts/list, every tool
result, notifications, hub frames, and state-file contents.

This is the key gate (p7_plugin-parity.md item "Parity harness").
"""
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


class PluginRunner:
    """Launch and communicate with a claude-net plugin via its stdio MCP
    transport, capturing tools/list, prompts/list, and tool call results."""

    def __init__(
        self,
        name: str,
        binary: str,
        plugin_path: str,
        hub_url: str,
        env_extra: dict = None,
        cwd: str = None,
    ):
        self.name = name
        self.binary = binary
        self.plugin_path = plugin_path
        self.hub_url = hub_url
        self.env_extra = env_extra or {}
        self.cwd = cwd
        self.process = None
        self.tools = None
        self.prompts = None
        self.outputs = []  # all frames seen
        self.stderr_lines = []  # plugin log output, for log-based assertions
        self.registered_name = None
        self.channel_capable = None
        self.read_task = None
        self.stderr_task = None
        self.read_queue = asyncio.Queue()

    async def start(self):
        """Start the plugin subprocess."""
        env = os.environ.copy()
        if self.hub_url is not None:
            env["CLAUDE_NET_HUB"] = self.hub_url
        else:
            env.pop("CLAUDE_NET_HUB", None)
        env["NODE_PATH"] = "/home/anl/claude-net/node_modules"
        env.update(self.env_extra)

        cmd = []
        if self.binary == "bun":
            cmd = ["bun", "run", self.plugin_path]
        else:  # mpy
            cmd = [self.binary, self.plugin_path]

        print(f"[{self.name}] Starting: {' '.join(cmd)}")
        self.process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=self.cwd,
        )
        # Start background reader tasks. stderr must be drained too, not
        # just stdout — otherwise plugin log output fills the pipe buffer
        # and deadlocks the subprocess once it's full.
        self.read_task = asyncio.create_task(self._read_loop())
        self.stderr_task = asyncio.create_task(self._stderr_loop())
        await asyncio.sleep(0.5)

    async def _read_loop(self):
        """Background task that reads output and queues frames."""
        while True:
            try:
                line = await self.process.stdout.readline()
                if not line:
                    break
                text = line.decode().strip()
                if text:
                    try:
                        frame = json.loads(text)
                        self.outputs.append(frame)
                        await self.read_queue.put(frame)
                    except json.JSONDecodeError:
                        print(f"[{self.name}] Malformed JSON: {text}")
            except Exception as e:
                print(f"[{self.name}] Read error: {e}")
                break

    async def _stderr_loop(self):
        """Background task that drains and records stderr log lines."""
        while True:
            try:
                line = await self.process.stderr.readline()
                if not line:
                    break
                text = line.decode(errors="replace").rstrip()
                if text:
                    self.stderr_lines.append(text)
            except Exception:
                break

    def notifications(self, method: str = None):
        """Server->client notification frames seen so far (no `id`,
        `method` present), optionally filtered to one method name."""
        return [
            f
            for f in self.outputs
            if "id" not in f and "method" in f and (method is None or f.get("method") == method)
        ]

    async def send(self, frame: dict) -> None:
        """Send a JSON-RPC request frame to the plugin."""
        line = json.dumps(frame) + "\n"
        print(f"[{self.name}] -> {frame.get('method', '?')}")
        self.process.stdin.write(line.encode())
        await self.process.stdin.drain()

    async def recv_until(self, predicate, timeout: float = 5.0):
        """Read responses until predicate is true."""
        start = time.time()
        while time.time() - start < timeout:
            try:
                frame = await asyncio.wait_for(
                    self.read_queue.get(),
                    timeout=min(0.5, timeout - (time.time() - start)),
                )
                if predicate(frame):
                    return frame
            except asyncio.TimeoutError:
                pass
        raise TimeoutError(
            f"[{self.name}] Predicate timeout after {timeout}s, {len(self.outputs)} frames seen"
        )

    async def list_tools(self):
        """MCP tools/list request."""
        rid = str(uuid.uuid4())
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": rid,
                "method": "tools/list",
                "params": {},
            }
        )
        result = await self.recv_until(
            lambda f: f.get("id") == rid and f.get("result") is not None
        )
        self.tools = result.get("result", {}).get("tools", [])
        return self.tools

    async def list_prompts(self):
        """MCP prompts/list request."""
        rid = str(uuid.uuid4())
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": rid,
                "method": "prompts/list",
                "params": {},
            }
        )
        result = await self.recv_until(
            lambda f: f.get("id") == rid and f.get("result") is not None
        )
        self.prompts = result.get("result", {}).get("prompts", [])
        return self.prompts

    async def call_tool(self, name: str, arguments: dict = None, timeout: float = 10.0):
        """MCP tools/call request. `timeout` should exceed `_hub.
        REQUEST_TIMEOUT_S` (10s) by a comfortable margin for a call
        expected to hang at the hub and resolve via that timeout."""
        rid = str(uuid.uuid4())
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": rid,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": arguments or {},
                },
            }
        )
        result = await self.recv_until(
            lambda f: f.get("id") == rid
            and (f.get("result") is not None or f.get("error") is not None),
            timeout=timeout,
        )
        return result

    async def get_prompt(self, name: str, arguments: dict = None):
        """MCP prompts/get request."""
        rid = str(uuid.uuid4())
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": rid,
                "method": "prompts/get",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )
        result = await self.recv_until(
            lambda f: f.get("id") == rid
            and (f.get("result") is not None or f.get("error") is not None)
        )
        return result

    async def initialize(self, capabilities: dict = None):
        """MCP initialize handshake. `capabilities` defaults to
        advertising `experimental.claude/channel` — pass `{}` to test
        the channel-capability empirical self-test path instead."""
        if capabilities is None:
            capabilities = {"experimental": {"claude/channel": {}}}
        rid = str(uuid.uuid4())
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": rid,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": capabilities,
                    "clientInfo": {"name": "test-driver", "version": "1.0"},
                },
            }
        )
        # A generous timeout: bun's cold-start time (module resolution,
        # JIT warmup) grows noticeably when several instances are spawned
        # back to back, as the scripted scenarios below do.
        result = await self.recv_until(
            lambda f: f.get("id") == rid and f.get("result") is not None,
            timeout=15.0,
        )
        # The MCP lifecycle isn't complete until the client sends this
        # follow-up notification (no `id` — it gets no reply). Both
        # plugins gate their `on_initialized` hook (and so auto-register)
        # on it, not on merely having replied to the `initialize` request.
        await self.send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        return result

    async def close_stdin(self):
        """Close stdin only, to drive the stdin-EOF shutdown path without
        killing the process — the plugin is expected to exit on its own."""
        self.process.stdin.close()

    async def wait_exit(self, timeout: float = 5.0):
        """Wait for the subprocess to exit on its own, returning the exit
        code (`None` on timeout — caller decides whether that's a failure)."""
        try:
            await asyncio.wait_for(self.process.wait(), timeout=timeout)
            return self.process.returncode
        except asyncio.TimeoutError:
            return None

    async def close(self):
        """Stop the plugin subprocess."""
        if self.process and self.process.returncode is None:
            try:
                self.process.terminate()
                await asyncio.wait_for(self.process.wait(), timeout=2)
            except:
                self.process.kill()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=1)
                except:
                    pass
        for task in (self.read_task, self.stderr_task):
            if task:
                task.cancel()
                try:
                    await task
                except:
                    pass


async def run_mock_hub(
    port: int,
    collide: int = 0,
    upgrade_hint: str = None,
    nak_action: str = None,
    nak_error: str = None,
    silent: bool = False,
    frame_log: str = None,
    hang_action: str = None,
):
    """Start the mock hub on the given port, return process (with a
    `.captured_lines` list, appended to for as long as the process runs,
    for tests that need to observe its log — e.g. counting "client
    connected" lines to prove a watchdog-triggered reconnect happened).
    See `planning/spike/mock_hub.py`'s docstring for what each scripting
    flag does."""
    # `uv` is a standalone binary, not a Python module importable via
    # `-m` from an arbitrary interpreter — invoke it directly.
    cmd = [
        "uv",
        "run",
        str(Path(__file__).parent.parent.parent.parent / "planning/spike/mock_hub.py"),
        str(port),
    ]
    if collide:
        cmd.extend(["--collide", str(collide)])
    if upgrade_hint:
        cmd.extend(["--upgrade-hint", upgrade_hint])
    if nak_action:
        cmd.extend(["--nak-action", nak_action])
    if nak_error:
        cmd.extend(["--nak-error", nak_error])
    if silent:
        cmd.append("--silent")
    if frame_log:
        cmd.extend(["--frame-log", frame_log])
    if hang_action:
        cmd.extend(["--hang-action", hang_action])

    print(f"Starting mock hub on port {port}")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def _wait_ready():
        while True:
            line = await proc.stdout.readline()
            if not line:
                raise RuntimeError("mock hub exited before becoming ready")
            if b"listening on" in line:
                return

    # Wait for the hub's own readiness line rather than a fixed sleep —
    # `uv run` startup latency is not constant, and a plugin connecting
    # before the listener is up just burns a reconnect-backoff cycle
    # instead of failing outright, which would silently degrade a
    # scenario test to "both sides saw ECONNREFUSED" (a false pass).
    try:
        await asyncio.wait_for(_wait_ready(), timeout=10)
    except asyncio.TimeoutError:
        raise RuntimeError(f"mock hub on port {port} did not become ready within 10s")

    # Keep draining stdout afterwards so the hub's later log lines
    # (connect/register/etc) can't fill the pipe and stall it, recording
    # each line for tests that want to inspect the hub's log.
    proc.captured_lines = []

    async def _drain():
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            proc.captured_lines.append(line.decode(errors="replace").rstrip())

    asyncio.create_task(_drain())
    return proc


def read_frame_log(path: str, redact_uuids: bool = True):
    """Read back a `--frame-log`-produced JSONL file as a list of frame
    dicts (in receipt order), with UUID-shaped `requestId` values
    normalized to the placeholder `"<uuid>"` so frames sent by two
    independent runs can be structurally diffed despite each request's
    id being randomly generated."""
    frames = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                frame = entry["frame"]
                if redact_uuids and _looks_like_uuid(frame.get("requestId")):
                    frame = dict(frame)
                    frame["requestId"] = "<uuid>"
                frames.append(frame)
    except FileNotFoundError:
        pass
    return frames


def _looks_like_uuid(value):
    if not isinstance(value, str) or len(value) != 36:
        return False
    parts = value.split("-")
    return len(parts) == 5 and [len(p) for p in parts] == [8, 4, 4, 4, 12] and all(
        c in "0123456789abcdefABCDEF" for p in parts for c in p
    )


STATE_DIR = "/tmp/claude-net"


def _state_file_path():
    # Matches `_statusline._state_file_path()` / plugin.ts's
    # `writeSessionState`: keyed by the plugin subprocess's PARENT pid,
    # which is this driver process for every PluginRunner it starts.
    return os.path.join(STATE_DIR, "state-%d.json" % os.getpid())


def _read_state_file():
    try:
        with open(_state_file_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


_HUB_URL_RE = re.compile(r"^wss?://127\.0\.0\.1:\d+/ws$")


def _redact(obj):
    """Recursively replace UUID-shaped strings with `"<uuid>"`, mock-hub
    URLs with `"<hub-url>"`, and drop the `updated_at` timestamp field,
    so two independent runs (bun, mpy) — each against its own mock hub
    instance, on its own port, for scenario isolation — can be
    structurally diffed despite carrying different random ids, ports,
    and wall-clock times."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "updated_at":
                continue
            out[k] = _redact(v)
        return out
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    if _looks_like_uuid(obj):
        return "<uuid>"
    if isinstance(obj, str) and _HUB_URL_RE.match(obj):
        return "<hub-url>"
    return obj


async def _wait_for(check, timeout: float, poll: float = 0.3):
    """Poll `check()` (a zero-arg callable, possibly returning a
    truthy/falsy value) until truthy or `timeout` elapses. Returns the
    last truthy value, or `None` on timeout."""
    start = time.time()
    while time.time() - start < timeout:
        value = check()
        if value:
            return value
        await asyncio.sleep(poll)
    return None


async def _wait_for_registered(runner, timeout: float = 6.0):
    """Poll `whoami` until it no longer errors (auto-register completes
    in the background after `initialize`), returning the final result."""

    async def _poll():
        result = await runner.call_tool("whoami")
        content = result.get("result", {})
        if content.get("isError"):
            return None
        return result

    start = time.time()
    while time.time() - start < timeout:
        result = await _poll()
        if result:
            return result
        await asyncio.sleep(0.3)
    return None


MPY_BINARY = "/home/anl/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-mcp"

# Every scenario below wants a clean, reproducible starting environment
# regardless of what's ambient in the driver's own shell — in particular
# `CLAUDE_NET_CHANNELS_PATCHED` (this driver may itself be running inside
# a claude-net-patched session) would otherwise leak into the spawned
# plugin and short-circuit the channel-capability empirical self-test.
DETERMINISTIC_ENV = {"CLAUDE_NET_CHANNELS_PATCHED": "0"}


def _plugin_paths():
    bun_plugin = Path(__file__).parent.parent.parent / "plugin" / "plugin.ts"
    mpy_plugin = Path(__file__).parent.parent / "plugin.py"
    return bun_plugin, mpy_plugin


async def run_registration_scenario(runtime_label: str, binary: str, plugin_path: str, port: int):
    """Drive one plugin runtime through auto-register (no `claude/channel`
    capability declared, so the empirical self-test fires), the channel
    self-test ack, the synthetic inbound message the mock hub pushes, the
    statusline state file, and the stdin-EOF shutdown path. Captures
    every tool result, notification frame, hub frame sent, and
    state-file snapshot involved, for structural (redacted) diffing
    against the other runtime's run."""
    hub_url = f"http://127.0.0.1:{port}"
    frame_log = f"/tmp/claude-net-parity-frames-{runtime_label}-{port}.jsonl"
    try:
        os.remove(frame_log)
    except OSError:
        pass
    hub_proc = await run_mock_hub(port, frame_log=frame_log)
    captured = {}
    runner = PluginRunner(runtime_label, binary, plugin_path, hub_url, env_extra=DETERMINISTIC_ENV)
    try:
        await runner.start()
        await runner.initialize(capabilities={})

        whoami_result = await _wait_for_registered(runner)
        captured["whoami_after_register"] = _redact(whoami_result.get("result") if whoami_result else None)

        self_test = await _wait_for(
            lambda: next(
                (
                    n
                    for n in runner.notifications("notifications/claude/channel")
                    if n.get("params", {}).get("meta", {}).get("from") == "system@claude-net"
                ),
                None,
            ),
            timeout=4.0,
        )
        captured["self_test_notification"] = _redact(self_test.get("params") if self_test else None)

        inbound = await _wait_for(
            lambda: next(
                (
                    n
                    for n in runner.notifications("notifications/claude/channel")
                    if n.get("params", {}).get("meta", {}).get("from") == "tester:mock@hub"
                ),
                None,
            ),
            timeout=4.0,
        )
        captured["inbound_message_notification"] = _redact(inbound.get("params") if inbound else None)

        ack_result = await runner.call_tool("_ack_channel")
        captured["ack_result"] = _redact(ack_result.get("result"))

        whoami_after_ack = await runner.call_tool("whoami")
        captured["whoami_after_ack"] = _redact(whoami_after_ack.get("result"))

        captured["state_file_before_shutdown"] = _redact(_read_state_file())

        await runner.close_stdin()
        exit_code = await runner.wait_exit(timeout=5.0)
        captured["exit_code"] = exit_code
        captured["state_file_deleted_on_shutdown"] = _read_state_file() is None

        frames = read_frame_log(frame_log)
        register_frames = [f for f in frames if f.get("action") == "register"]
        captured["register_frames_sent"] = [
            {k: v for k, v in f.items() if k != "cc_pid"} for f in register_frames
        ]
    finally:
        await runner.close()
        try:
            hub_proc.terminate()
            await asyncio.wait_for(hub_proc.wait(), timeout=2)
        except Exception:
            try:
                hub_proc.kill()
            except Exception:
                pass
        try:
            os.remove(frame_log)
        except OSError:
            pass
    return captured


async def run_ping_scenario(runtime_label: str, binary: str, plugin_path: str, port: int):
    """Register, then call `ping` and capture both the tool result and
    the hub's echoed `notifications/claude/channel` "pong" frame."""
    hub_url = f"http://127.0.0.1:{port}"
    hub_proc = await run_mock_hub(port)
    captured = {}
    runner = PluginRunner(runtime_label, binary, plugin_path, hub_url, env_extra=DETERMINISTIC_ENV)
    try:
        await runner.start()
        await runner.initialize()
        await _wait_for_registered(runner)

        ping_result = await runner.call_tool("ping")
        captured["ping_result"] = _redact(ping_result.get("result"))

        pong = await _wait_for(
            lambda: next(
                (
                    n
                    for n in runner.notifications("notifications/claude/channel")
                    if n.get("params", {}).get("content") == "pong"
                ),
                None,
            ),
            timeout=4.0,
        )
        captured["pong_notification"] = _redact(pong.get("params") if pong else None)
    finally:
        await runner.close()
        try:
            hub_proc.terminate()
            await asyncio.wait_for(hub_proc.wait(), timeout=2)
        except Exception:
            try:
                hub_proc.kill()
            except Exception:
                pass
    return captured


async def run_offline_nak_scenario(runtime_label: str, binary: str, plugin_path: str, port: int):
    """Register, then `send_message` to a hub scripted to NAK the send
    (`--nak-action send`) as though the recipient were offline, and
    capture the resulting `isError` tool result verbatim."""
    hub_url = f"http://127.0.0.1:{port}"
    hub_proc = await run_mock_hub(
        port, nak_action="send", nak_error="recipient offline (reason: offline)"
    )
    captured = {}
    runner = PluginRunner(runtime_label, binary, plugin_path, hub_url, env_extra=DETERMINISTIC_ENV)
    try:
        await runner.start()
        await runner.initialize()
        await _wait_for_registered(runner)

        send_result = await runner.call_tool(
            "send_message", {"to": "nobody:x@y", "content": "hi"}
        )
        captured["send_result"] = _redact(send_result.get("result"))
    finally:
        await runner.close()
        try:
            hub_proc.terminate()
            await asyncio.wait_for(hub_proc.wait(), timeout=2)
        except Exception:
            try:
                hub_proc.kill()
            except Exception:
                pass
    return captured


async def run_collision_and_nudges_scenario(
    runtime_label: str, binary: str, plugin_path: str, port: int
):
    """Register against a hub scripted to force exactly one collision
    (`--collide 1`) and return an `upgrade_hint` on every register reply,
    then capture the first successful `whoami` result — it should carry
    both the one-shot upgrade-hint nudge and the guarded "Rename
    suggestion" nudge the -2-suffix retry queues (plugin.ts:1229-1240)."""
    hub_url = f"http://127.0.0.1:{port}"
    hub_proc = await run_mock_hub(
        port, collide=1, upgrade_hint="New version available: 0.3.0 — run /setup to upgrade."
    )
    captured = {}
    runner = PluginRunner(runtime_label, binary, plugin_path, hub_url, env_extra=DETERMINISTIC_ENV)
    try:
        await runner.start()
        await runner.initialize()
        whoami_result = await _wait_for_registered(runner)
        captured["whoami_after_collision"] = _redact(
            whoami_result.get("result") if whoami_result else None
        )
    finally:
        await runner.close()
        try:
            hub_proc.terminate()
            await asyncio.wait_for(hub_proc.wait(), timeout=2)
        except Exception:
            try:
                hub_proc.kill()
            except Exception:
                pass
    return captured


def _diff_scenario(area_prefix, bun_captured, mpy_captured, divergences, deliberate_keys=None):
    """Append a divergence for every top-level key where the two
    runtimes' captured scenario data differs."""
    deliberate_keys = deliberate_keys or {}
    keys = sorted(set(bun_captured) | set(mpy_captured))
    clean = True
    for key in keys:
        bun_val = bun_captured.get(key)
        mpy_val = mpy_captured.get(key)
        if bun_val != mpy_val:
            clean = False
            divergences.append(
                {
                    "area": f"{area_prefix}.{key}",
                    "bun": json.dumps(bun_val, indent=2, sort_keys=True),
                    "mpy": json.dumps(mpy_val, indent=2, sort_keys=True),
                    "deliberate": key in deliberate_keys,
                    "reason": deliberate_keys.get(key, ""),
                }
            )
    return clean


async def run_parity_test():
    """Run the full parity harness."""
    # Use a random port
    port = 9000 + (int(time.time()) % 1000)
    hub_url = f"http://127.0.0.1:{port}"

    hub_proc = await run_mock_hub(port)
    divergences = []
    results = []

    try:
        # Create runner instances
        bun_plugin = Path(__file__).parent.parent.parent / "plugin" / "plugin.ts"
        mpy_plugin = Path(__file__).parent.parent / "plugin.py"
        mpy_binary = "/home/anl/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-mcp"

        bun = PluginRunner("BUN", "bun", str(bun_plugin), hub_url, env_extra=DETERMINISTIC_ENV)
        mpy = PluginRunner("MPY", mpy_binary, str(mpy_plugin), hub_url, env_extra=DETERMINISTIC_ENV)

        await bun.start()
        await mpy.start()

        # Initialize both
        print("\n=== INITIALIZE ===")
        try:
            bun_init = await bun.initialize()
            print(f"[BUN] initialized")
        except Exception as e:
            print(f"[BUN] initialize failed: {e}")
            bun_init = {}

        try:
            mpy_init = await mpy.initialize()
            print(f"[MPY] initialized")
        except Exception as e:
            print(f"[MPY] initialize failed: {e}")
            mpy_init = {}

        # Compare server info
        bun_server = bun_init.get("result", {}).get("serverInfo", {})
        mpy_server = mpy_init.get("result", {}).get("serverInfo", {})

        if bun_server and mpy_server:
            if bun_server.get("name") != mpy_server.get("name"):
                divergences.append(
                    {
                        "area": "serverInfo.name",
                        "bun": bun_server.get("name"),
                        "mpy": mpy_server.get("name"),
                        "deliberate": False,
                    }
                )
            if bun_server.get("version") != mpy_server.get("version"):
                divergences.append(
                    {
                        "area": "serverInfo.version",
                        "bun": bun_server.get("version"),
                        "mpy": mpy_server.get("version"),
                        "deliberate": False,
                    }
                )

        # List tools
        print("\n=== TOOLS/LIST ===")
        try:
            bun_tools = await bun.list_tools()
            print(f"[BUN] got {len(bun_tools)} tools")
        except Exception as e:
            print(f"[BUN] tools/list failed: {e}")
            bun_tools = []

        try:
            mpy_tools = await mpy.list_tools()
            print(f"[MPY] got {len(mpy_tools)} tools")
        except Exception as e:
            print(f"[MPY] tools/list failed: {e}")
            mpy_tools = []

        bun_tools_by_name = {t["name"]: t for t in bun_tools}
        mpy_tools_by_name = {t["name"]: t for t in mpy_tools}

        if set(bun_tools_by_name.keys()) != set(mpy_tools_by_name.keys()):
            divergences.append(
                {
                    "area": "tools/list (tool names)",
                    "bun": sorted(bun_tools_by_name.keys()),
                    "mpy": sorted(mpy_tools_by_name.keys()),
                    "deliberate": False,
                }
            )
        else:
            for name in sorted(bun_tools_by_name.keys()):
                if bun_tools_by_name[name] != mpy_tools_by_name[name]:
                    divergences.append(
                        {
                            "area": f"tools/list ({name})",
                            "bun": json.dumps(
                                bun_tools_by_name[name], indent=2, sort_keys=True
                            ),
                            "mpy": json.dumps(
                                mpy_tools_by_name[name], indent=2, sort_keys=True
                            ),
                            "deliberate": False,
                        }
                    )

        # List prompts
        print("\n=== PROMPTS/LIST ===")
        try:
            bun_prompts = await bun.list_prompts()
            print(f"[BUN] got {len(bun_prompts)} prompts")
        except Exception as e:
            print(f"[BUN] prompts/list failed: {e}")
            bun_prompts = []

        try:
            mpy_prompts = await mpy.list_prompts()
            print(f"[MPY] got {len(mpy_prompts)} prompts")
        except Exception as e:
            print(f"[MPY] prompts/list failed: {e}")
            mpy_prompts = []

        if bun_prompts != mpy_prompts:
            divergences.append(
                {
                    "area": "prompts/list",
                    "bun": json.dumps(bun_prompts, indent=2, sort_keys=True),
                    "mpy": json.dumps(mpy_prompts, indent=2, sort_keys=True),
                    "deliberate": False,
                }
            )

        results.append(
            {
                "name": "serverInfo parity",
                "pass": len([d for d in divergences if "serverInfo" in d["area"]])
                == 0,
                "detail": "server info matches"
                if not any("serverInfo" in d["area"] for d in divergences)
                else "divergence found",
            }
        )
        results.append(
            {
                "name": "tools/list parity",
                "pass": len([d for d in divergences if "tools/list" in d["area"]])
                == 0,
                "detail": "tool schemas match"
                if not any("tools/list" in d["area"] for d in divergences)
                else "divergence found",
            }
        )
        results.append(
            {
                "name": "prompts/list parity",
                "pass": len([d for d in divergences if d["area"] == "prompts/list"])
                == 0,
                "detail": "prompt schemas match"
                if not any(d["area"] == "prompts/list" for d in divergences)
                else "divergence found",
            }
        )

        await bun.close()
        await mpy.close()

    finally:
        try:
            hub_proc.terminate()
            await asyncio.wait_for(hub_proc.wait(), timeout=2)
        except ProcessLookupError:
            pass
        except Exception:
            try:
                hub_proc.kill()
            except:
                pass

    # ── Scripted scenarios: byte-diff every tool result, notification
    # frame, hub frame sent, and state-file snapshot the ticket's key
    # gate calls for, not just the static tools/list & serverInfo shape
    # checked above. Each scenario gets its own mock hub instance (and
    # runs bun then mpy sequentially, not concurrently) so scripted
    # collision/NAK counters and the shared `/tmp/claude-net/state-
    # <ppid>.json` path — keyed by this driver's own pid for every
    # child it spawns — can't race between the two runtimes.
    bun_plugin, mpy_plugin = _plugin_paths()
    next_port = port + 1

    print("\n=== SCENARIO: registration, notifications, state file, EOF shutdown ===")
    reg_port_bun, reg_port_mpy = next_port, next_port + 1
    next_port += 2
    bun_reg = await run_registration_scenario("BUN", "bun", str(bun_plugin), reg_port_bun)
    mpy_reg = await run_registration_scenario("MPY", MPY_BINARY, str(mpy_plugin), reg_port_mpy)
    clean = _diff_scenario("registration-scenario", bun_reg, mpy_reg, divergences)
    results.append(
        {
            "name": "registration/notification/state-file/shutdown scenario parity",
            "pass": clean,
            "detail": "all captured frames match" if clean else "divergence found",
        }
    )

    print("\n=== SCENARIO: ping echo ===")
    ping_port_bun, ping_port_mpy = next_port, next_port + 1
    next_port += 2
    bun_ping = await run_ping_scenario("BUN", "bun", str(bun_plugin), ping_port_bun)
    mpy_ping = await run_ping_scenario("MPY", MPY_BINARY, str(mpy_plugin), ping_port_mpy)
    clean = _diff_scenario("ping-scenario", bun_ping, mpy_ping, divergences)
    results.append(
        {
            "name": "ping echo scenario parity",
            "pass": clean,
            "detail": "ping result + pong notification match" if clean else "divergence found",
        }
    )

    print("\n=== SCENARIO: offline NAK ===")
    nak_port_bun, nak_port_mpy = next_port, next_port + 1
    next_port += 2
    bun_nak = await run_offline_nak_scenario("BUN", "bun", str(bun_plugin), nak_port_bun)
    mpy_nak = await run_offline_nak_scenario("MPY", MPY_BINARY, str(mpy_plugin), nak_port_mpy)
    clean = _diff_scenario("offline-nak-scenario", bun_nak, mpy_nak, divergences)
    results.append(
        {
            "name": "offline NAK scenario parity",
            "pass": clean,
            "detail": "send_message error result matches" if clean else "divergence found",
        }
    )

    print("\n=== SCENARIO: collision cascade + nudge queue ===")
    col_port_bun, col_port_mpy = next_port, next_port + 1
    next_port += 2
    bun_col = await run_collision_and_nudges_scenario("BUN", "bun", str(bun_plugin), col_port_bun)
    mpy_col = await run_collision_and_nudges_scenario(
        "MPY", MPY_BINARY, str(mpy_plugin), col_port_mpy
    )
    clean = _diff_scenario("collision-and-nudges-scenario", bun_col, mpy_col, divergences)
    results.append(
        {
            "name": "collision cascade + nudge queue scenario parity",
            "pass": clean,
            "detail": "-2 suffix + drained nudges match" if clean else "divergence found",
        }
    )

    return {
        "parityClean": len([d for d in divergences if not d["deliberate"]]) == 0,
        "divergences": divergences,
        "results": results,
    }


if __name__ == "__main__":
    result = asyncio.run(run_parity_test())
    print("\n=== PARITY TEST RESULTS ===")
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["parityClean"] else 1)
