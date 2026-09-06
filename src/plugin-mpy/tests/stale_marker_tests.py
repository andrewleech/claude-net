#!/usr/bin/env python3
"""
P8 (Q6 hub-serving) test: a register response carrying `upgrade_hint`
must, in addition to the existing one-shot nudge-queue behaviour, touch
`$HOME/.claude-net/plugin/.stale` so the packaged binary's `launch`
wrapper re-downloads on its *next* invocation. Exercised against the
real `mcp`-variant binary through a mock hub, the same way every other
functional test in this directory works; none of these plugin behaviours
are reachable without going through the actual MCP/hub wire protocol.
"""
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///

import asyncio
import os
import stat
import sys
import tempfile
import time
from pathlib import Path

# Explicit, parameterized inserts (matching run_all_tests.py's own
# `tests_dir = Path(__file__).parent; sys.path.insert(0, str(tests_dir))`
# pattern) rather than relying on the CPython-implicit "script's own
# directory is sys.path[0]" behaviour that only holds when this file is
# executed directly as `python3 stale_marker_tests.py`; the `from
# parity_harness import` below needs the tests/ directory on sys.path
# regardless of how this module is invoked (direct run, or imported by
# run_all_tests.py).
_TESTS_DIR = Path(__file__).parent
sys.path.insert(0, str(_TESTS_DIR))
sys.path.insert(0, str(_TESTS_DIR.parent / "lib"))

from parity_harness import (
    DETERMINISTIC_ENV,
    MPY_BINARY,
    PluginRunner,
    _plugin_paths,
    _wait_for_registered,
    run_mock_hub,
)

_port_counter = [9900 + (int(time.time()) % 400) * 10]


def _next_port():
    _port_counter[0] += 1
    return _port_counter[0]


def _mpy_plugin_path():
    return str(_plugin_paths()[1])


def _tool_text(call_result):
    return call_result["result"]["content"][0]["text"]


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


async def test_stale_marker_written_on_upgrade_hint():
    """A register response with `upgrade_hint` writes an empty marker at
    `$HOME/.claude-net/plugin/.stale`, and the existing one-shot nudge
    (surfaced in the next successful tool result) is unchanged."""
    with tempfile.TemporaryDirectory() as fake_home:
        port = _next_port()
        hub_proc = await run_mock_hub(
            port, upgrade_hint="New version available: 0.3.0 — run /setup to upgrade."
        )
        mpy_plugin = _mpy_plugin_path()
        runner = PluginRunner(
            "MPY",
            MPY_BINARY,
            mpy_plugin,
            f"http://127.0.0.1:{port}",
            env_extra=dict(DETERMINISTIC_ENV, HOME=fake_home),
        )
        try:
            await runner.start()
            await runner.initialize()
            whoami = await _wait_for_registered(runner, timeout=6.0)
            registered = whoami is not None

            stale_path = os.path.join(fake_home, ".claude-net", "plugin", ".stale")
            marker_written = os.path.isfile(stale_path)
            marker_empty = marker_written and os.path.getsize(stale_path) == 0

            content = whoami.get("result", {}).get("content", []) if whoami else []
            texts = [b.get("text", "") for b in content]
            nudge_present = any("New version available" in t for t in texts)

            pass_ = registered and marker_written and marker_empty and nudge_present
            return [
                {
                    "name": "Stale marker written on upgrade_hint",
                    "pass": pass_,
                    "detail": (
                        f".stale written empty at {stale_path!r} and existing "
                        "upgrade_hint nudge still drained into whoami"
                        if pass_
                        else f"registered={registered} marker_written={marker_written} "
                        f"marker_empty={marker_empty} nudge_present={nudge_present} "
                        f"whoami={whoami!r}"
                    ),
                }
            ]
        finally:
            await runner.close()
            await _stop_hub(hub_proc)


async def test_no_stale_marker_without_upgrade_hint():
    """A register response with no `upgrade_hint` (hub version matches)
    must not create the marker; it would otherwise force every launch
    to redownload regardless of actual staleness."""
    with tempfile.TemporaryDirectory() as fake_home:
        port = _next_port()
        hub_proc = await run_mock_hub(port)  # no --upgrade-hint
        mpy_plugin = _mpy_plugin_path()
        runner = PluginRunner(
            "MPY",
            MPY_BINARY,
            mpy_plugin,
            f"http://127.0.0.1:{port}",
            env_extra=dict(DETERMINISTIC_ENV, HOME=fake_home),
        )
        try:
            await runner.start()
            await runner.initialize()
            whoami = await _wait_for_registered(runner, timeout=6.0)
            registered = whoami is not None

            stale_path = os.path.join(fake_home, ".claude-net", "plugin", ".stale")
            marker_absent = not os.path.exists(stale_path)

            pass_ = registered and marker_absent
            return [
                {
                    "name": "No stale marker without upgrade_hint",
                    "pass": pass_,
                    "detail": "no .stale file written when the hub reports no version mismatch"
                    if pass_
                    else f"registered={registered} marker_absent={marker_absent}",
                }
            ]
        finally:
            await runner.close()
            await _stop_hub(hub_proc)


async def test_stale_marker_write_failure_does_not_break_registration():
    """A failed `.stale` write must not disturb registration or the WS
    connection: best-effort, log-only, matching every other state-file
    writer's contract in this codebase (`_identity.write_persisted_agent_name`,
    `_statusline.write_session_state`). Forced by making `$HOME`
    read-only, so `_mark_plugin_binary_stale`'s `os.mkdir(...
    ".claude-net")` fails with EACCES rather than the file ever getting
    written."""
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return [
            {
                "name": "Stale marker write failure does not break registration",
                "pass": True,
                "detail": "skipped: running as root, permission bits are not enforced",
            }
        ]

    with tempfile.TemporaryDirectory() as fake_home:
        os.chmod(fake_home, stat.S_IRUSR | stat.S_IXUSR)  # r-x, no write
        try:
            port = _next_port()
            hub_proc = await run_mock_hub(
                port, upgrade_hint="New version available: 0.3.0 — run /setup to upgrade."
            )
            mpy_plugin = _mpy_plugin_path()
            runner = PluginRunner(
                "MPY",
                MPY_BINARY,
                mpy_plugin,
                f"http://127.0.0.1:{port}",
                env_extra=dict(DETERMINISTIC_ENV, HOME=fake_home),
            )
            try:
                await runner.start()
                await runner.initialize()
                whoami = await _wait_for_registered(runner, timeout=6.0)
                registered = whoami is not None

                content = whoami.get("result", {}).get("content", []) if whoami else []
                texts = [b.get("text", "") for b in content]
                nudge_present = any("New version available" in t for t in texts)

                # Proof the write attempt actually failed (rather than
                # this test silently not exercising the failure path at
                # all): the read-only directory must still contain no
                # .claude-net entry.
                claude_net_absent = not os.path.exists(
                    os.path.join(fake_home, ".claude-net")
                )

                pass_ = registered and nudge_present and claude_net_absent
                return [
                    {
                        "name": "Stale marker write failure does not break registration",
                        "pass": pass_,
                        "detail": (
                            "registration and nudge delivery succeed even though the "
                            ".stale write itself failed against a read-only $HOME "
                            "(best-effort, log-only)"
                            if pass_
                            else f"registered={registered} nudge_present={nudge_present} "
                            f"claude_net_absent={claude_net_absent}"
                        ),
                    }
                ]
            finally:
                await runner.close()
                await _stop_hub(hub_proc)
        finally:
            os.chmod(fake_home, stat.S_IRWXU)


async def run_stale_marker_tests():
    all_results = []
    tests = [
        test_stale_marker_written_on_upgrade_hint,
        test_no_stale_marker_without_upgrade_hint,
        test_stale_marker_write_failure_does_not_break_registration,
    ]
    for test_func in tests:
        print(f"Running {test_func.__name__}...", flush=True)
        try:
            results = await test_func()
            all_results.extend(results)
        except Exception as e:
            print(f"  ERROR: {e}")
            all_results.append(
                {"name": test_func.__name__, "pass": False, "detail": str(e)}
            )
    return all_results


if __name__ == "__main__":
    results = asyncio.run(run_stale_marker_tests())
    all_pass = all(r["pass"] for r in results)

    print("\n=== STALE MARKER TEST RESULTS ===")
    for r in results:
        status = "PASS" if r["pass"] else "FAIL"
        print(f"[{status}] {r['name']}: {r['detail']}")

    print(f"\nTotal: {len(results)} tests, {sum(1 for r in results if r['pass'])} passed")
    sys.exit(0 if all_pass else 1)
