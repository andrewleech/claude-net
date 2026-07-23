#!/usr/bin/env python3
"""
Ceremony tests for P7 plugin parity: the 17-item checklist from
p7_plugin-parity.md, each exercised against the real `mcp`-variant binary
(and, for the pure identity/hub-url helpers, invoked directly) rather than
asserted by inspection.

Every test either drives the actual plugin subprocess through a live mock
hub and asserts on the resulting tool results / notifications / wire
frames / state file, or invokes a pure helper function inside the
picolet binary via `-c` and checks its output. None of these return
`pass: True` without having exercised the behavior they name.
"""
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from parity_harness import (
    DETERMINISTIC_ENV,
    MPY_BINARY,
    PluginRunner,
    _looks_like_uuid,
    _plugin_paths,
    _wait_for,
    _wait_for_registered,
    read_frame_log,
    run_collision_and_nudges_scenario,
    run_mock_hub,
    run_registration_scenario,
)

_port_counter = [9500 + (int(time.time()) % 400) * 10]


def _next_port():
    _port_counter[0] += 1
    return _port_counter[0]


def _mpy_plugin_path():
    return str(_plugin_paths()[1])


async def _stop_hub(proc):
    try:
        proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=2)
    except ProcessLookupError:
        pass
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _cleanup_file(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _run_mpy_c(code, cwd=None, env_extra=None, timeout=15):
    """Run `code` inside the picolet `mcp` binary's `-c` mode with
    `_HERE`/`lib` already on `sys.path`, returning the completed
    `subprocess.CompletedProcess` (stdout carries both prints and any
    uncaught-exception traceback on this runtime)."""
    plugin_dir = str(Path(__file__).parent.parent)
    lib_dir = os.path.join(plugin_dir, "lib")
    prelude = (
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "sys.path.insert(0, %r)\n"
    ) % (lib_dir, plugin_dir)
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [MPY_BINARY, "-c", prelude + code],
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
        timeout=timeout,
    )


def _tool_text(call_result):
    """Extract the first text content block's string from a
    `tools/call` JSON-RPC response (as returned by `PluginRunner.call_tool`)."""
    return call_result["result"]["content"][0]["text"]


async def test_hub_url_derivation():
    """Work item 1: `_hub.derive_ws_url` converts `CLAUDE_NET_HUB` to the
    hub's `/ws` endpoint (http->ws, https->wss, trailing slash stripped),
    and hubless mode (`CLAUDE_NET_HUB` unset) makes every hub-backed tool
    return the documented "not set" error."""
    results = []

    code = """
from _hub import derive_ws_url
cases = [
    ("http://example.com", "ws://example.com/ws"),
    ("http://example.com/", "ws://example.com/ws"),
    ("https://example.com", "wss://example.com/ws"),
    ("https://example.com:8080", "wss://example.com:8080/ws"),
    ("", ""),
]
ok = all(derive_ws_url(inp) == expected for inp, expected in cases)
print("DERIVE_OK" if ok else "DERIVE_FAIL " + repr([derive_ws_url(i) for i, _ in cases]))
"""
    proc = _run_mpy_c(code)
    derive_ok = "DERIVE_OK" in proc.stdout
    results.append(
        {
            "name": "Hub URL derivation",
            "pass": derive_ok,
            "detail": "http/https -> ws/wss + trailing-slash-strip + /ws all matched"
            if derive_ok
            else f"mismatch: stdout={proc.stdout!r} stderr={proc.stderr!r}",
        }
    )

    # Hubless mode: no CLAUDE_NET_HUB -> every hub-backed tool errors with
    # the documented message, verified against the live plugin.
    mpy_plugin = _mpy_plugin_path()
    runner = PluginRunner("MPY", MPY_BINARY, mpy_plugin, None, env_extra=DETERMINISTIC_ENV)
    try:
        await runner.start()
        await runner.initialize()
        result = await runner.call_tool("ping")
        text = _tool_text(result)
        hubless_ok = result["result"].get("isError") and "CLAUDE_NET_HUB" in text
        results.append(
            {
                "name": "Hubless mode error",
                "pass": bool(hubless_ok),
                "detail": text if not hubless_ok else "hub-backed tool errors with CLAUDE_NET_HUB not set",
            }
        )
    finally:
        await runner.close()

    return results


async def test_identity_resolution():
    """Work item 2: default `cwd-basename:user@host` identity, and the
    freshest-of-{persisted-name, custom-title} resolution rule."""
    results = []

    code = """
import _identity as identity

# Default name shape: session:user@host, session = cwd basename.
default_name = identity.build_default_name()
parts_ok = default_name.count(":") == 1 and default_name.count("@") == 1
session = default_name.split(":")[0]
import os
cwd_ok = session == os.path.basename(os.getcwd())

# Freshest-of-{persisted, custom-title} resolution: persisted newer wins.
def build_full(session_part):
    return session_part + ":user@host"

resolved_persisted_newer = identity.resolve_startup_name(
    "default:user@host", ("persisted-name", 200.0), ("custom-title", 100.0), build_full
)
resolved_title_newer = identity.resolve_startup_name(
    "default:user@host", ("persisted-name", 100.0), ("custom-title", 200.0), build_full
)
resolved_neither = identity.resolve_startup_name("default:user@host", None, None, build_full)

ok = (
    parts_ok
    and cwd_ok
    and resolved_persisted_newer == "persisted-name"
    and resolved_title_newer == "custom-title:user@host"
    and resolved_neither == "default:user@host"
)
print("IDENTITY_OK" if ok else "IDENTITY_FAIL " + repr(
    (default_name, resolved_persisted_newer, resolved_title_newer, resolved_neither)
))
"""
    proc = _run_mpy_c(code)
    ok = "IDENTITY_OK" in proc.stdout
    results.append(
        {
            "name": "Identity resolution",
            "pass": ok,
            "detail": "default name is cwd-basename:user@host and freshest-of-persisted/custom-title wins"
            if ok
            else f"stdout={proc.stdout!r} stderr={proc.stderr!r}",
        }
    )
    return results


async def test_transcript_discovery():
    """Work item 3: newest UUID-named `.jsonl` under
    `~/.claude/projects/<encoded-cwd>/` is discovered; non-UUID-named
    files are rejected even if newer."""
    results = []

    with tempfile.TemporaryDirectory() as tmp:
        cwd = "/some/project"
        home = tmp
        encoded = "".join(ch if ch.isalnum() else "-" for ch in cwd)
        project_dir = os.path.join(home, ".claude", "projects", encoded)
        os.makedirs(project_dir)

        older_sid = str(uuid.uuid4())
        newer_sid = str(uuid.uuid4())
        older_path = os.path.join(project_dir, f"{older_sid}.jsonl")
        newer_path = os.path.join(project_dir, f"{newer_sid}.jsonl")
        not_uuid_path = os.path.join(project_dir, "not-a-uuid.jsonl")

        # Set mtimes explicitly (well-separated, whole seconds apart)
        # rather than relying on wall-clock sleeps between writes —
        # this runtime's `os.stat()` mtime has only whole-second
        # resolution, so a sub-second gap is not reliably distinguishable.
        now = time.time()
        for path, ts in (
            (older_path, now - 20),
            (not_uuid_path, now - 10),  # newer than older_path, but not UUID-named
            (newer_path, now),
        ):
            with open(path, "w") as f:
                f.write("{}\n")
            os.utime(path, (ts, ts))

        code = """
import _identity as identity
result = identity.find_active_session_for_cc_pid(%r, home=%r)
print("RESULT", result)
""" % (cwd, home)
        proc = _run_mpy_c(code)
        expected = f"RESULT ('{newer_sid}', '{newer_path}')"
        ok = expected in proc.stdout
        results.append(
            {
                "name": "Transcript discovery",
                "pass": ok,
                "detail": "newest UUID-named .jsonl found, non-UUID filename ignored"
                if ok
                else f"expected {expected!r}, got stdout={proc.stdout!r} stderr={proc.stderr!r}",
            }
        )
    return results


async def test_auto_register_collision_cascade():
    """Work item 4: a hub scripted to force exactly one collision
    (`--collide 1`) drives the plugin through the -2-suffix retry."""
    port = _next_port()
    mpy_plugin = _mpy_plugin_path()
    captured = await run_collision_and_nudges_scenario("MPY", MPY_BINARY, mpy_plugin, port)
    whoami = captured.get("whoami_after_collision") or {}
    text = (whoami.get("content") or [{}])[0].get("text", "")
    try:
        name = json.loads(text).get("name", "")
    except ValueError:
        name = ""
    suffix_ok = "-2:" in name  # e.g. "session-2:user@host"
    return [
        {
            "name": "Auto-register collision cascade",
            "pass": suffix_ok,
            "detail": f"registered as {name!r} after one forced collision"
            if suffix_ok
            else f"expected a -2-suffixed name, got {whoami!r}",
        }
    ]


async def test_register_gating():
    """Work item 5: register only fires once BOTH the MCP `initialize`
    handshake and the hub WebSocket are up. The hub here is reachable
    (and connects) well before the driver sends `initialize` — if the
    gate were missing, a register frame would appear on the wire before
    `initialize` completes."""
    port = _next_port()
    frame_log = f"/tmp/claude-net-ceremony-gating-{port}.jsonl"
    _cleanup_file(frame_log)
    hub_proc = await run_mock_hub(port, frame_log=frame_log)
    mpy_plugin = _mpy_plugin_path()
    runner = PluginRunner(
        "MPY", MPY_BINARY, mpy_plugin, f"http://127.0.0.1:{port}", env_extra=DETERMINISTIC_ENV
    )
    try:
        await runner.start()
        # The hub connection (and, if gating were broken, a register
        # attempt) has plenty of time to happen before `initialize` is
        # sent below.
        await asyncio.sleep(3.0)
        pre_init_frames = read_frame_log(frame_log)
        no_premature_register = not any(f.get("action") == "register" for f in pre_init_frames)

        await runner.initialize()
        whoami = await _wait_for_registered(runner, timeout=6.0)
        registered_after_init = whoami is not None

        pass_ = no_premature_register and registered_after_init
        return [
            {
                "name": "Register gating",
                "pass": pass_,
                "detail": "no register frame before initialize completed; registered after"
                if pass_
                else f"no_premature_register={no_premature_register} registered_after_init={registered_after_init}",
            }
        ]
    finally:
        await runner.close()
        await _stop_hub(hub_proc)
        _cleanup_file(frame_log)


async def test_channel_capability_self_test():
    """Work item 6: with `experimental.claude/channel` declared at
    `initialize`, no empirical self-test notification fires; without it,
    the self-test notification fires and `_ack_channel()` flips
    `channel_capable` to true."""
    mpy_plugin = _mpy_plugin_path()

    # Sub-case A: capability declared -> no self-test.
    port_a = _next_port()
    hub_a = await run_mock_hub(port_a)
    runner_a = PluginRunner(
        "MPY", MPY_BINARY, mpy_plugin, f"http://127.0.0.1:{port_a}", env_extra=DETERMINISTIC_ENV
    )
    try:
        await runner_a.start()
        await runner_a.initialize()  # default caps include experimental.claude/channel
        await _wait_for_registered(runner_a, timeout=6.0)
        await asyncio.sleep(3.0)
        self_test_absent = not any(
            n.get("params", {}).get("meta", {}).get("from") == "system@claude-net"
            for n in runner_a.notifications("notifications/claude/channel")
        )
    finally:
        await runner_a.close()
        await _stop_hub(hub_a)

    # Sub-case B: no capability declared -> self-test fires; ack flips flag.
    port_b = _next_port()
    hub_b = await run_mock_hub(port_b)
    runner_b = PluginRunner(
        "MPY", MPY_BINARY, mpy_plugin, f"http://127.0.0.1:{port_b}", env_extra=DETERMINISTIC_ENV
    )
    try:
        await runner_b.start()
        await runner_b.initialize(capabilities={})
        await _wait_for_registered(runner_b, timeout=6.0)
        self_test = await _wait_for(
            lambda: next(
                (
                    n
                    for n in runner_b.notifications("notifications/claude/channel")
                    if n.get("params", {}).get("meta", {}).get("from") == "system@claude-net"
                ),
                None,
            ),
            timeout=4.0,
        )
        self_test_present = self_test is not None

        await runner_b.call_tool("_ack_channel")
        whoami = await runner_b.call_tool("whoami")
        flag_flipped = json.loads(_tool_text(whoami)).get("channel_capable") is True
    finally:
        await runner_b.close()
        await _stop_hub(hub_b)

    pass_ = self_test_absent and self_test_present and flag_flipped
    return [
        {
            "name": "Channel capability self-test",
            "pass": pass_,
            "detail": (
                "capability declared -> no self-test; not declared -> self-test fires and "
                "_ack_channel flips channel_capable"
            )
            if pass_
            else f"self_test_absent={self_test_absent} self_test_present={self_test_present} flag_flipped={flag_flipped}",
        }
    ]


async def test_nudge_queue():
    """Work item 7: `upgrade_hint` from the register response and the
    guarded "Rename suggestion" (fired after a suffixed auto-register)
    are both drained into the next successful tool result, and never
    attached to `_ack_channel`'s own result."""
    port = _next_port()
    mpy_plugin = _mpy_plugin_path()
    captured = await run_collision_and_nudges_scenario("MPY", MPY_BINARY, mpy_plugin, port)
    whoami = captured.get("whoami_after_collision") or {}
    texts = [block.get("text", "") for block in whoami.get("content", [])]
    upgrade_hint_drained = any("New version available" in t for t in texts)
    rename_nudge_drained = any(t.startswith("Rename suggestion:") for t in texts)

    # _ack_channel's own result never gets nudges, even with nudges
    # still pending (guard the assertion by checking a fresh collision
    # + upgrade_hint run's _ack_channel call directly).
    port2 = _next_port()
    hub_proc = await run_mock_hub(
        port2, collide=1, upgrade_hint="New version available: 0.3.0 — run /setup to upgrade."
    )
    runner = PluginRunner(
        "MPY", MPY_BINARY, mpy_plugin, f"http://127.0.0.1:{port2}", env_extra=DETERMINISTIC_ENV
    )
    ack_clean = False
    try:
        await runner.start()
        await runner.initialize(capabilities={})  # no claude/channel -> self-test also queues nothing extra
        await _wait_for_registered(runner, timeout=6.0)
        ack_result = await runner.call_tool("_ack_channel")
        ack_clean = len(ack_result["result"]["content"]) == 1
    finally:
        await runner.close()
        await _stop_hub(hub_proc)

    pass_ = upgrade_hint_drained and rename_nudge_drained and ack_clean
    return [
        {
            "name": "Nudge queue draining",
            "pass": pass_,
            "detail": "upgrade_hint + rename suggestion both drained into whoami; _ack_channel's own result untouched"
            if pass_
            else f"upgrade_hint_drained={upgrade_hint_drained} rename_nudge_drained={rename_nudge_drained} ack_clean={ack_clean}",
        }
    ]


async def test_rename_watch():
    """Work item 8: the plugin polls the discovered transcript every 5s
    for a new `custom-title` line and re-registers under the sanitized
    new name within a couple of poll intervals."""
    with tempfile.TemporaryDirectory() as tmp:
        work_cwd = os.path.join(tmp, "myproj")
        os.makedirs(work_cwd)
        fake_home = os.path.join(tmp, "home")
        encoded = "".join(ch if ch.isalnum() else "-" for ch in work_cwd)
        project_dir = os.path.join(fake_home, ".claude", "projects", encoded)
        os.makedirs(project_dir)
        sid = str(uuid.uuid4())
        transcript = os.path.join(project_dir, f"{sid}.jsonl")
        with open(transcript, "w") as f:
            f.write(json.dumps({"type": "custom-title", "customTitle": "start-title"}) + "\n")

        port = _next_port()
        hub_proc = await run_mock_hub(port)
        mpy_plugin = _mpy_plugin_path()
        runner = PluginRunner(
            "MPY",
            MPY_BINARY,
            mpy_plugin,
            f"http://127.0.0.1:{port}",
            env_extra=dict(DETERMINISTIC_ENV, HOME=fake_home),
            cwd=work_cwd,
        )
        try:
            await runner.start()
            await runner.initialize()
            whoami1 = await _wait_for_registered(runner, timeout=6.0)
            name1 = json.loads(_tool_text(whoami1)).get("name", "") if whoami1 else ""
            initial_ok = name1.startswith("start-title:")

            # Force a file-size change so the poll's stat-size gate fires.
            with open(transcript, "a") as f:
                f.write(json.dumps({"type": "custom-title", "customTitle": "renamed-title"}) + "\n")

            new_name = None
            start = time.time()
            while time.time() - start < 9.0:
                await asyncio.sleep(0.5)
                whoami2 = await runner.call_tool("whoami")
                if not whoami2["result"].get("isError"):
                    current = json.loads(_tool_text(whoami2)).get("name", "")
                    if current.startswith("renamed-title:"):
                        new_name = current
                        break
            renamed_ok = new_name is not None
        finally:
            await runner.close()
            await _stop_hub(hub_proc)

        pass_ = initial_ok and renamed_ok
        return [
            {
                "name": "Rename transcript watch",
                "pass": pass_,
                "detail": f"initial={name1!r} -> renamed={new_name!r}"
                if pass_
                else f"initial_ok={initial_ok} (name={name1!r}) renamed_ok={renamed_ok}",
            }
        ]


async def test_rename_prompt():
    """Work item 9: the `rename` MCP prompt is registered and its
    `prompts/get` body drives both the mirror-agent `/rename` self-inject
    and a `register(name=...)` call."""
    port = _next_port()
    hub_proc = await run_mock_hub(port)

    try:
        mpy_plugin = _mpy_plugin_path()
        mpy = PluginRunner(
            "MPY", MPY_BINARY, mpy_plugin, f"http://127.0.0.1:{port}", env_extra=DETERMINISTIC_ENV
        )
        await mpy.start()
        await mpy.initialize()
        prompts = await mpy.list_prompts()
        prompt_names = [p["name"] for p in prompts]
        if "rename" not in prompt_names:
            await mpy.close()
            return [
                {
                    "name": "Rename prompt",
                    "pass": False,
                    "detail": f"rename prompt not found. prompts={prompt_names}",
                }
            ]

        got = await mpy.get_prompt("rename", {"name": "reviewer"})
        message_text = got["result"]["messages"][0]["content"]["text"]
        has_inject = "claude-net-mirror-agent inject '/rename reviewer'" in message_text
        has_register = 'register tool with name="reviewer"' in message_text
        await mpy.close()

        pass_ = has_inject and has_register
        return [
            {
                "name": "Rename prompt",
                "pass": pass_,
                "detail": "prompts/get body drives both the /rename self-inject and register(name=...)"
                if pass_
                else f"has_inject={has_inject} has_register={has_register}: {message_text!r}",
            }
        ]
    finally:
        await _stop_hub(hub_proc)


async def test_inbound_messages():
    """Work item 10: a hub `{event:"message"}` frame is forwarded to the
    client as a `notifications/claude/channel` notification carrying the
    `cn_`-prefixed meta fields."""
    port = _next_port()
    mpy_plugin = _mpy_plugin_path()
    captured = await run_registration_scenario("MPY", MPY_BINARY, mpy_plugin, port)
    notif = captured.get("inbound_message_notification")
    ok = bool(
        notif
        and notif.get("content") == "Hello from the mock hub!"
        and notif.get("meta", {}).get("from") == "tester:mock@hub"
        and notif.get("meta", {}).get("type") == "message"
        and notif.get("meta", {}).get("cn_message_id") == "<uuid>"
    )
    return [
        {
            "name": "Inbound message handling",
            "pass": ok,
            "detail": "hub message event forwarded as notifications/claude/channel with cn_ meta"
            if ok
            else f"got {notif!r}",
        }
    ]


async def test_request_correlation():
    """Work item 11: outbound hub requests carry a UUIDv4 `requestId`.

    Shutdown-on-EOF around a request stuck in-flight (`--hang-action`)
    is a confirmed, deliberate divergence from bun rather than a bug:
    `mpyjsonrpc.JsonRpcPeer.serve()` awaits every still-running handler
    task to completion before firing shutdown callbacks — so
    `HubClient.shutdown()`'s pending-rejection never actually runs while
    a handler is still in flight, and the stuck `hub_events` call instead
    resolves via its own 10s `_hub.REQUEST_TIMEOUT_S`, only after which
    does the process exit — but it *does* still get a real response
    written before exit, per that library's documented contract ("a
    request read just before EOF still gets its response written").
    Bun's `shutdown()` ends in `process.exit(0)`, which abandons an
    in-flight response outright and exits near-instantly instead —
    faster, but silently drops the reply. Verified directly rather than
    asserted as parity with bun, since the two are deliberately
    different here."""
    port = _next_port()
    frame_log = f"/tmp/claude-net-ceremony-corr-{port}.jsonl"
    _cleanup_file(frame_log)
    hub_proc = await run_mock_hub(port, frame_log=frame_log, hang_action="query_events")
    mpy_plugin = _mpy_plugin_path()
    runner = PluginRunner(
        "MPY", MPY_BINARY, mpy_plugin, f"http://127.0.0.1:{port}", env_extra=DETERMINISTIC_ENV
    )
    try:
        await runner.start()
        await runner.initialize()
        await _wait_for_registered(runner, timeout=6.0)

        frames = read_frame_log(frame_log, redact_uuids=False)
        register_frames = [f for f in frames if f.get("action") == "register"]
        uuid_ok = bool(register_frames) and _looks_like_uuid(register_frames[0].get("requestId"))

        # Fire the request directly (rather than through `call_tool`,
        # which awaits its own response) so a slow reply doesn't race a
        # second, independent timeout in this driver — the response is
        # instead read back from `runner.outputs` once the process has
        # actually exited.
        hang_rid = str(uuid.uuid4())
        await runner.send(
            {
                "jsonrpc": "2.0",
                "id": hang_rid,
                "method": "tools/call",
                "params": {"name": "hub_events", "arguments": {}},
            }
        )
        await asyncio.sleep(0.5)
        await runner.close_stdin()
        exit_code = await runner.wait_exit(timeout=15.0)
        await asyncio.sleep(0.3)  # let the reader loop drain any last buffered line
        hung_response = next((f for f in runner.outputs if f.get("id") == hang_rid), None)
        response_delivered = bool(
            hung_response
            and hung_response.get("result", {}).get("isError")
            and "timed out" in hung_response["result"]["content"][0]["text"].lower()
        )

        pass_ = uuid_ok and response_delivered and exit_code == 0
        return [
            {
                "name": "Request correlation",
                "pass": pass_,
                "detail": "requestId is UUIDv4-shaped; an in-flight request still gets a real "
                "response (its own 10s timeout) before clean exit — mpyjsonrpc's "
                "documented drain-before-shutdown behavior, deliberately slower than "
                "bun's process.exit(0) but never silently drops the reply"
                if pass_
                else f"uuid_ok={uuid_ok} response_delivered={response_delivered} exit_code={exit_code!r} hung_response={hung_response!r}",
            }
        ]
    finally:
        await runner.close()
        await _stop_hub(hub_proc)
        _cleanup_file(frame_log)


async def test_watchdog():
    """Work item 12: 31s with zero hub traffic (`--silent`: no control
    ping, no replies) makes the client close and reconnect on its own —
    observed here as a second "client connected" line in the hub's log."""
    port = _next_port()
    hub_proc = await run_mock_hub(port, silent=True)
    mpy_plugin = _mpy_plugin_path()
    runner = PluginRunner(
        "MPY", MPY_BINARY, mpy_plugin, f"http://127.0.0.1:{port}", env_extra=DETERMINISTIC_ENV
    )
    try:
        await runner.start()
        await runner.initialize()  # never completes app-level registration (hub is silent)

        def _connect_count():
            return sum(1 for line in hub_proc.captured_lines if "client connected" in line)

        reconnected = await _wait_for(lambda: _connect_count() >= 2, timeout=40.0, poll=1.0)
        return [
            {
                "name": "Watchdog timer",
                "pass": bool(reconnected),
                "detail": "client reconnected after ~31s of total hub silence"
                if reconnected
                else f"only {_connect_count()} connection(s) seen within 40s",
            }
        ]
    finally:
        await runner.close()
        await _stop_hub(hub_proc)


async def test_statusline_state_file():
    """Work item 13: `/tmp/claude-net/state-<ppid>.json` is written on
    register (`status: "online"`, `name`, `hub`, `cwd`, `updated_at`) and
    deleted on clean shutdown."""
    port = _next_port()
    mpy_plugin = _mpy_plugin_path()
    captured = await run_registration_scenario("MPY", MPY_BINARY, mpy_plugin, port)
    before = captured.get("state_file_before_shutdown") or {}
    shape_ok = (
        before.get("status") == "online"
        and isinstance(before.get("name"), str)
        and before.get("name")
        and isinstance(before.get("hub"), str)
        and isinstance(before.get("cwd"), str)
    )
    deleted_ok = captured.get("state_file_deleted_on_shutdown") is True
    pass_ = shape_ok and deleted_ok
    return [
        {
            "name": "Statusline state file",
            "pass": pass_,
            "detail": "state file has {name,status,hub,cwd} on register and is gone after clean shutdown"
            if pass_
            else f"shape_ok={shape_ok} deleted_ok={deleted_ok} before={before!r}",
        }
    ]


async def test_local_tools():
    """Work item 14: `whoami`/`register`/`_ack_channel` are present,
    tool calls are blocked (except `register`) until registered, and the
    unregistered `whoami` error carries the exact documented guidance
    text with bun's `"Error: "` prefix."""
    port = _next_port()
    # Registration never completes (hub silently drops it) so
    # `registered_name` reliably stays empty for the whole test —
    # otherwise the background auto-register races these gated checks.
    hub_proc = await run_mock_hub(port, hang_action="register")

    try:
        mpy_plugin = _mpy_plugin_path()
        mpy = PluginRunner(
            "MPY", MPY_BINARY, mpy_plugin, f"http://127.0.0.1:{port}", env_extra=DETERMINISTIC_ENV
        )
        await mpy.start()
        await mpy.initialize()
        tools = await mpy.list_tools()
        tool_names = {t["name"] for t in tools}
        required_tools = {"whoami", "register", "_ack_channel"}
        if not required_tools.issubset(tool_names):
            await mpy.close()
            return [
                {
                    "name": "Local tools",
                    "pass": False,
                    "detail": f"Missing tools: {required_tools - tool_names}",
                }
            ]

        whoami_result = await mpy.call_tool("whoami")
        text = _tool_text(whoami_result)
        whoami_gated = whoami_result["result"].get("isError") and text.startswith(
            'Error: Not registered. The default name "'
        )

        send_result = await mpy.call_tool("send_message", {"to": "x:y@z", "content": "hi"})
        send_gated = send_result["result"].get("isError") and "Not registered" in _tool_text(
            send_result
        )

        await mpy.close()
        pass_ = whoami_gated and send_gated
        return [
            {
                "name": "Local tools",
                "pass": pass_,
                "detail": "whoami/register/_ack_channel present; unregistered calls blocked with the documented text"
                if pass_
                else f"whoami_gated={whoami_gated} send_gated={send_gated} whoami_text={text!r}",
            }
        ]
    finally:
        await _stop_hub(hub_proc)


async def test_instructions_parity():
    """Work item 15: the `INSTRUCTIONS` string served at `initialize` is
    byte-identical to bun's `plugin.ts` constant, and `capabilities`
    match too."""
    port = _next_port()
    hub_proc = await run_mock_hub(port)

    results = []
    try:
        bun_plugin_path, mpy_plugin_path = _plugin_paths()

        # Byte-equality of the INSTRUCTIONS text itself: extract bun's
        # template literal and compare against _instructions.py's
        # constant, rather than only comparing the (identical either
        # way) `capabilities` object.
        ts_source = bun_plugin_path.read_text()
        start_marker = "export const INSTRUCTIONS = `"
        start = ts_source.index(start_marker) + len(start_marker)
        end = ts_source.index("`;", start)
        bun_instructions = ts_source[start:end].replace("\\`", "`")

        sys.path.insert(0, str(Path(__file__).parent.parent))
        import _instructions  # noqa: E402

        instructions_match = bun_instructions == _instructions.INSTRUCTIONS
        results.append(
            {
                "name": "INSTRUCTIONS byte parity",
                "pass": instructions_match,
                "detail": "INSTRUCTIONS text is byte-identical to plugin.ts's constant"
                if instructions_match
                else f"diverges: bun len={len(bun_instructions)} mpy len={len(_instructions.INSTRUCTIONS)}",
            }
        )

        bun = PluginRunner(
            "BUN", "bun", str(bun_plugin_path), f"http://127.0.0.1:{port}", env_extra=DETERMINISTIC_ENV
        )
        mpy = PluginRunner(
            "MPY", MPY_BINARY, str(mpy_plugin_path), f"http://127.0.0.1:{port}", env_extra=DETERMINISTIC_ENV
        )
        await bun.start()
        await mpy.start()

        bun_init = await bun.initialize()
        mpy_init = await mpy.initialize()

        bun_capabilities = bun_init.get("result", {}).get("capabilities", {})
        mpy_capabilities = mpy_init.get("result", {}).get("capabilities", {})
        capabilities_match = bun_capabilities == mpy_capabilities

        # Also confirm the *served* instructions field is the same text
        # captured above (not just the source-code constant).
        served_match = bun_init.get("result", {}).get("instructions") == mpy_init.get(
            "result", {}
        ).get("instructions")

        results.append(
            {
                "name": "capabilities parity",
                "pass": capabilities_match and served_match,
                "detail": "capabilities and served instructions match"
                if (capabilities_match and served_match)
                else f"capabilities_match={capabilities_match} served_match={served_match}",
            }
        )

        await bun.close()
        await mpy.close()
    finally:
        await _stop_hub(hub_proc)

    return results


async def test_lifecycle():
    """Work item 16: stdin EOF (with a hub configured) shuts the plugin
    down cleanly — process exits 0 and the state file is deleted — the
    load-bearing path since this runtime has no `signal` module."""
    port = _next_port()
    mpy_plugin = _mpy_plugin_path()
    captured = await run_registration_scenario("MPY", MPY_BINARY, mpy_plugin, port)
    exit_ok = captured.get("exit_code") == 0
    deleted_ok = captured.get("state_file_deleted_on_shutdown") is True
    pass_ = exit_ok and deleted_ok
    return [
        {
            "name": "Lifecycle - stdin EOF shutdown",
            "pass": pass_,
            "detail": "stdin EOF -> exit 0, state file deleted"
            if pass_
            else f"exit_code={captured.get('exit_code')!r} deleted={deleted_ok}",
        }
    ]


async def test_plugin_version():
    """Work item 17: `PLUGIN_VERSION` is a single, shared source and
    matches bun's `plugin.ts` constant."""
    mpy_version_file = Path(__file__).parent.parent / "_version.py"
    mpy_content = mpy_version_file.read_text()
    bun_plugin_path, _ = _plugin_paths()
    bun_content = bun_plugin_path.read_text()

    mpy_ok = 'PLUGIN_VERSION = "0.2.0"' in mpy_content
    bun_ok = 'PLUGIN_VERSION = "0.2.0"' in bun_content

    if mpy_ok and bun_ok:
        return [
            {
                "name": "PLUGIN_VERSION constant",
                "pass": True,
                "detail": "PLUGIN_VERSION = 0.2.0 in both _version.py and plugin.ts",
            }
        ]
    return [
        {
            "name": "PLUGIN_VERSION constant",
            "pass": False,
            "detail": f"mpy_ok={mpy_ok} bun_ok={bun_ok}",
        }
    ]


async def run_ceremony_tests():
    """Run all ceremony tests."""
    all_results = []

    ceremony_tests = [
        test_hub_url_derivation,
        test_identity_resolution,
        test_transcript_discovery,
        test_auto_register_collision_cascade,
        test_register_gating,
        test_channel_capability_self_test,
        test_nudge_queue,
        test_rename_watch,
        test_rename_prompt,
        test_inbound_messages,
        test_request_correlation,
        test_watchdog,
        test_statusline_state_file,
        test_local_tools,
        test_instructions_parity,
        test_lifecycle,
        test_plugin_version,
    ]

    for test_func in ceremony_tests:
        print(f"Running {test_func.__name__}...", flush=True)
        try:
            results = await test_func()
            all_results.extend(results)
        except Exception as e:
            print(f"  ERROR: {e}")
            all_results.append(
                {
                    "name": test_func.__name__,
                    "pass": False,
                    "detail": str(e),
                }
            )

    return all_results


if __name__ == "__main__":
    results = asyncio.run(run_ceremony_tests())
    all_pass = all(r["pass"] for r in results)

    print("\n=== CEREMONY TEST RESULTS ===")
    for r in results:
        status = "PASS" if r["pass"] else "FAIL"
        print(f"[{status}] {r['name']}: {r['detail']}")

    print(f"\nTotal: {len(results)} tests, {sum(1 for r in results if r['pass'])} passed")
    sys.exit(0 if all_pass else 1)
