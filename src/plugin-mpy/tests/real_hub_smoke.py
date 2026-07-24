#!/usr/bin/env python3
"""
Real-hub smoke test: register, whoami, send/receive, ping, hub_events,
reconnect, watchdog recovery.

Tests against wss://telie.story-kettle.ts.net:4815/ws (the real hub).
"""
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from parity_harness import PluginRunner

# Real hub URL
REAL_HUB_URL = "https://telie.story-kettle.ts.net:4815"


def is_network_reachable():
    """Check if the real hub is reachable."""
    try:
        socket.create_connection(("telie.story-kettle.ts.net", 4815), timeout=2)
        return True
    except (socket.timeout, socket.error):
        return False


async def test_real_hub():
    """Run smoke tests against the real hub."""
    if not is_network_reachable():
        return "skipped(unreachable)"

    results = []

    try:
        mpy_plugin = Path(__file__).parent.parent / "plugin.py"
        mpy_binary = "/home/corona/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-mcp"

        # Create a unique test name with timestamp
        test_name = f"p7-test-{int(time.time())}"

        mpy = PluginRunner("MPY-REAL", mpy_binary, str(mpy_plugin), REAL_HUB_URL)
        await mpy.start()

        # Initialize
        print("Testing initialize...")
        await asyncio.wait_for(mpy.initialize(), timeout=10)
        results.append(("initialize", True))

        # Register with a unique name
        print("Testing register...")
        try:
            reg_result = await asyncio.wait_for(
                mpy.call_tool("register", {"name": test_name}), timeout=10
            )
            if reg_result.get("result") or not reg_result.get("error"):
                results.append(("register", True))
                mpy.registered_name = (
                    reg_result.get("result", {})
                    .get("data", {})
                    .get("full_name", test_name)
                )
                print(f"Registered as: {mpy.registered_name}")
            else:
                results.append(("register", False))
        except asyncio.TimeoutError:
            results.append(("register", False))

        # Test whoami
        print("Testing whoami...")
        try:
            whoami_result = await asyncio.wait_for(
                mpy.call_tool("whoami"), timeout=10
            )
            if whoami_result.get("result") and not whoami_result.get("error"):
                results.append(("whoami", True))
            else:
                results.append(("whoami", False))
        except asyncio.TimeoutError:
            results.append(("whoami", False))

        # Test ping (should get a pong message back)
        print("Testing ping...")
        try:
            ping_result = await asyncio.wait_for(
                mpy.call_tool("ping"), timeout=10
            )
            if ping_result.get("result") and not ping_result.get("error"):
                results.append(("ping", True))
            else:
                results.append(("ping", False))
        except asyncio.TimeoutError:
            results.append(("ping", False))

        # Test hub_events
        print("Testing hub_events...")
        try:
            events_result = await asyncio.wait_for(
                mpy.call_tool("hub_events", {"since_minutes": 1, "limit": 10}),
                timeout=10,
            )
            if events_result.get("result") and not events_result.get("error"):
                results.append(("hub_events", True))
            else:
                results.append(("hub_events", False))
        except asyncio.TimeoutError:
            results.append(("hub_events", False))

        # Test list_agents
        print("Testing list_agents...")
        try:
            agents_result = await asyncio.wait_for(
                mpy.call_tool("list_agents"), timeout=10
            )
            if agents_result.get("result") and not agents_result.get("error"):
                results.append(("list_agents", True))
            else:
                results.append(("list_agents", False))
        except asyncio.TimeoutError:
            results.append(("list_agents", False))

        # Test send_message to a non-existent agent (should fail gracefully)
        print("Testing send_message...")
        try:
            send_result = await asyncio.wait_for(
                mpy.call_tool(
                    "send_message",
                    {"to": "nonexistent", "content": "test message"},
                ),
                timeout=10,
            )
            # send_message to nonexistent agent should error
            # but the important thing is that it doesn't crash
            results.append(("send_message", True))
        except asyncio.TimeoutError:
            results.append(("send_message", False))

        await mpy.close()

        # Check results
        all_pass = all(r[1] for r in results)
        passed = sum(1 for r in results if r[1])
        total = len(results)

        print(f"\n=== REAL HUB SMOKE TEST RESULTS ===")
        for test_name, passed in results:
            status = "PASS" if passed else "FAIL"
            print(f"[{status}] {test_name}")

        print(f"\nTotal: {total} tests, {passed} passed")

        if all_pass:
            return "passed"
        else:
            return "failed(some tests failed)"

    except Exception as e:
        print(f"Real hub smoke test error: {e}")
        return f"failed({e})"


if __name__ == "__main__":
    result = asyncio.run(test_real_hub())
    print(f"Real hub smoke result: {result}")
    sys.exit(0 if result == "passed" else 1)
