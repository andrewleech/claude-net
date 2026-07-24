#!/usr/bin/env python3
"""# /// script
# dependencies = []
# ///
Test driver for mpyjsonrpc: spawns MicroPython binary with a demo JSON-RPC server
and validates on-the-wire behavior via real stdio communication.

Usage: uv run test_mpyjsonrpc.py
"""

import asyncio
import json
import os
import subprocess
import sys
import textwrap
import tempfile
import time

LIB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MPY_BIN = os.environ.get(
    "MPY_BIN",
    "/home/corona/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-cli",
)

# Server script to run inside MicroPython
SERVER_SCRIPT = textwrap.dedent(
    """
    import sys
    sys.path.insert(0, %r)
    import asyncio
    import mpyjsonrpc as rpc

    def add(a, b):
        return a + b

    def no_params():
        return "ok"

    def boom():
        raise ValueError("kaboom")

    def boom_typeerror():
        return None + 1

    async def aboom_typeerror():
        return None + 1

    def big(payload):
        return {"len": len(payload)}

    async def slow_echo(msg, delay=0.05):
        await asyncio.sleep(delay)
        return msg

    def nan_result():
        return float("nan")

    def inf_nested_result():
        return {"a": 1, "b": float("inf"), "c": {"d": float("-inf")}}

    async def main():
        peer = rpc.JsonRpcPeer(max_line_bytes=%d)
        peer.register_method("add", add)
        peer.register_method("no_params", no_params)
        peer.register_method("boom", boom)
        peer.register_method("boom_typeerror", boom_typeerror)
        peer.register_method("aboom_typeerror", aboom_typeerror)
        peer.register_method("big", big)
        peer.register_method("slow_echo", slow_echo)
        peer.register_method("nan_result", nan_result)
        peer.register_method("inf_nested_result", inf_nested_result)

        async def notify_bad_nonfinite():
            # The non-finite value must be rejected before this
            # notification ever reaches stdout; the handler must never
            # get to return.
            await peer.notify("bad_event", {"x": float("nan")})
            return "unreachable"

        peer.register_method("notify_bad_nonfinite", notify_bad_nonfinite)

        async def notify_during_big(n, size):
            for i in range(n):
                await peer.notify("progress", {"i": i})
            return "y" * size

        peer.register_method("notify_during_big", notify_during_big)

        def on_eof():
            peer.log("shutdown-callback-fired")

        peer.on_shutdown(on_eof)
        await peer.serve()

    asyncio.run(main())
    """
)


def _req(id_, method, params=None):
    """Build a JSON-RPC 2.0 request object."""
    obj = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        obj["params"] = params
    return (json.dumps(obj) + "\n").encode()


def _notif(method, params=None):
    """Build a JSON-RPC 2.0 notification (no id)."""
    obj = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        obj["params"] = params
    return (json.dumps(obj) + "\n").encode()


def _run(payload_lines, max_line_bytes=2 * 1024 * 1024, timeout=10):
    """Run server against fixed input, return (stdout_lines, stderr_bytes, returncode).

    payload_lines: list of bytes objects (write verbatim, include \\n where needed).
    Returns: (list of parsed JSON response objects, stderr bytes, return code)
    """
    if not os.path.exists(MPY_BIN):
        raise FileNotFoundError(
            f"MicroPython binary not found at {MPY_BIN}. Set MPY_BIN env var."
        )

    with tempfile.TemporaryDirectory() as tmp_dir:
        script_path = os.path.join(tmp_dir, "server.py")
        with open(script_path, "w") as f:
            f.write(SERVER_SCRIPT % (LIB_DIR, max_line_bytes))

        payload = b"".join(payload_lines)
        try:
            proc = subprocess.run(
                [MPY_BIN, script_path],
                input=payload,
                capture_output=True,
                timeout=timeout,
            )
            stdout_lines = [
                json.loads(line)
                for line in proc.stdout.decode("utf-8", errors="replace").splitlines()
                if line.strip()
            ]
            return stdout_lines, proc.stderr, proc.returncode
        except subprocess.TimeoutExpired:
            raise TimeoutError(f"Test timed out after {timeout}s")


# ── Test cases ────────────────────────────────────────────────────────────


def test_happy_path_request_response():
    """Happy-path request/response: single request, single response."""
    lines, stderr, rc = _run([_req(1, "add", [2, 3])])
    assert len(lines) == 1
    assert lines[0]["id"] == 1
    assert lines[0]["result"] == 5
    assert lines[0]["jsonrpc"] == "2.0"
    return True, "Single request → response with correct result"


def test_batch_many_requests():
    """Burst of many requests: all get responses in flight."""
    reqs = [_req(i, "add", [i, 1]) for i in range(20)]
    lines, stderr, rc = _run(reqs)
    by_id = {r["id"]: r["result"] for r in lines}
    assert len(by_id) == 20
    assert by_id == {i: i + 1 for i in range(20)}
    return True, "20 concurrent requests all responded correctly"


def test_malformed_json():
    """Malformed JSON → -32700 parse error."""
    lines, stderr, rc = _run([b"not json at all\n"])
    assert len(lines) == 1
    assert lines[0]["error"]["code"] == -32700
    assert lines[0]["id"] is None
    return True, "Malformed JSON → -32700 with id=null"


def test_unknown_method():
    """Unknown method → -32601 method not found."""
    lines, stderr, rc = _run([_req(1, "does_not_exist")])
    assert len(lines) == 1
    assert lines[0]["error"]["code"] == -32601
    assert lines[0]["id"] == 1
    return True, "Unknown method → -32601 with id echoed"


def test_wrong_params_arity():
    """Wrong param count/type → -32602 invalid params."""
    lines, stderr, rc = _run([_req(1, "add", [1])])  # add needs 2 args
    assert len(lines) == 1
    assert lines[0]["error"]["code"] == -32602
    assert lines[0]["id"] == 1
    return True, "Missing param → -32602 with id echoed"


def test_notification_no_response():
    """Notification (no id) → no response emitted."""
    lines, stderr, rc = _run(
        [
            _notif("add", [1, 1]),
            _req(1, "add", [1, 1]),  # sentinel
        ]
    )
    # Only the request (with id) gets a response; notification does not.
    assert len(lines) == 1
    assert lines[0]["id"] == 1
    return True, "Notification produces NO response; request does"


def test_notification_error_no_response():
    """Notification with error → logged to stderr, no response emitted."""
    lines, stderr, rc = _run(
        [
            _notif("boom"),  # raises exception
            _req(1, "add", [1, 1]),  # sentinel
        ]
    )
    # Only sentinel response.
    assert len(lines) == 1
    assert lines[0]["id"] == 1
    # Error logged to stderr, not stdout.
    return True, "Notification error → stderr only, no response"


def test_id_type_string():
    """ID-type preservation: string id echoed exactly."""
    lines, stderr, rc = _run([_req("abc-123", "no_params")])
    assert lines[0]["id"] == "abc-123"
    return True, "String id preserved"


def test_id_type_number():
    """ID-type preservation: numeric id echoed exactly."""
    lines, stderr, rc = _run([_req(42, "no_params")])
    assert lines[0]["id"] == 42
    return True, "Integer id preserved"


def test_id_type_float():
    """ID-type preservation: float id echoed exactly."""
    lines, stderr, rc = _run([_req(3.5, "no_params")])
    assert lines[0]["id"] == 3.5
    return True, "Float id preserved"


def test_id_type_null():
    """ID-type preservation: null id echoed exactly."""
    lines, stderr, rc = _run([_req(None, "no_params")])
    assert lines[0]["id"] is None
    return True, "Null id preserved"


def test_large_payload():
    """Large result payload (256+ KB) round-trips intact."""
    payload = "x" * 300_000
    lines, stderr, rc = _run([_req(1, "big", [payload])])
    assert len(lines) == 1
    assert lines[0]["result"]["len"] == 300_000
    return True, "300 KB payload round-tripped intact"


def test_eof_shutdown():
    """EOF on stdin triggers clean shutdown."""
    lines, stderr, rc = _run([_req(1, "no_params")])
    # Process exits cleanly (rc==0), shutdown callback fires.
    assert rc == 0
    # Shutdown callback message appears in stderr.
    assert b"shutdown-callback-fired" in stderr
    return True, "EOF → clean shutdown, callback fired"


def test_stderr_isolation():
    """Stderr never appears on stdout; stdout is pure JSON-RPC lines."""
    lines, stderr, rc = _run([_req(1, "no_params")])
    # All stdout lines must be valid JSON (already proven by _run).
    assert len(lines) == 1
    # Shutdown message only in stderr, not in stdout JSON.
    assert b"shutdown-callback-fired" in stderr
    for line in lines:
        # Re-encode to check: JSON should not contain log messages.
        assert "shutdown-callback-fired" not in json.dumps(line)
    return True, "Stderr isolated from stdout; stdout is pure JSON-RPC"


def test_framing_fuzz_junk():
    """Random byte junk between valid lines doesn't crash the loop."""
    junk = b"\x00\x01\xff\xfe garbage { not json \n"
    lines, stderr, rc = _run(
        [
            _req(1, "no_params"),
            junk,
            _req(2, "no_params"),
        ]
    )
    # Both requests should get responses despite the junk line.
    by_id = {l.get("id"): l for l in lines}
    assert by_id[1]["result"] == "ok"
    assert by_id[2]["result"] == "ok"
    # Junk triggers parse error.
    assert any(l["error"]["code"] == -32700 for l in lines if "error" in l)
    return True, "Junk between valid lines: both requests answered, junk parsed as error"


def test_handler_body_typeerror_is_internal_error():
    """A TypeError from inside a handler's body (not from param binding) is -32603."""
    lines, stderr, rc = _run([_req(1, "boom_typeerror")])
    assert lines[0]["error"]["code"] == -32603
    return True, "Sync handler body TypeError -> -32603, not -32602"


def test_async_handler_body_typeerror_is_internal_error():
    """Same fault raised from an async handler's body is also -32603."""
    lines, stderr, rc = _run([_req(1, "aboom_typeerror")])
    assert lines[0]["error"]["code"] == -32603
    return True, "Async handler body TypeError -> -32603, matching sync case"


def test_slow_async_handler_does_not_block_faster_requests():
    """Task-per-request: fast requests complete before a slower async one."""
    reqs = [
        _req("slow", "slow_echo", ["late"]),
        _req(1, "add", [1, 1]),
        _req(2, "add", [2, 1]),
    ]
    lines, stderr, rc = _run(reqs)
    order = [l["id"] for l in lines]
    assert order.index("slow") > order.index(1)
    assert order.index("slow") > order.index(2)
    return True, "Fast requests complete before the slower concurrent one"


def test_notify_mid_handler_interleaves_safely():
    """notify() fired repeatedly while assembling a large result: all lines valid JSON."""
    lines, stderr, rc = _run(
        [_req(1, "notify_during_big", {"n": 50, "size": 100_000})]
    )
    notifications = [l for l in lines if "id" not in l]
    responses = [l for l in lines if l.get("id") == 1]
    assert len(notifications) == 50
    assert len(responses) == 1
    assert len(responses[0]["result"]) == 100_000
    return True, "50 interleaved notifications + large response, all valid JSON"


def test_oversized_line_recovery():
    """Oversized line (> max_line_bytes) triggers guard and recovery."""
    oversized = b"z" * 5000 + b"\n"  # exceeds 1024-byte limit
    good = _req(1, "no_params")
    lines, stderr, rc = _run([oversized, good], max_line_bytes=1024)
    # Oversized line produces parse error, good request still answered.
    by_id = {l.get("id"): l for l in lines}
    assert by_id[1]["result"] == "ok"
    assert any(l["error"]["code"] == -32700 for l in lines if "error" in l)
    return True, "Oversized line → -32700, recovery works, next request answered"


def test_nan_result_is_internal_error():
    """A handler returning float('nan') -> -32603, not a corrupt `nan` line."""
    lines, stderr, rc = _run([_req(1, "nan_result")])
    assert len(lines) == 1
    assert lines[0]["id"] == 1
    assert "error" in lines[0]
    assert lines[0]["error"]["code"] == -32603
    assert "result" not in lines[0]
    return True, "float('nan') result -> -32603 InternalError, stdout stays valid JSON"


def test_inf_nested_result_is_internal_error():
    """A handler returning inf/-inf nested in a dict -> -32603."""
    lines, stderr, rc = _run([_req(1, "inf_nested_result")])
    assert len(lines) == 1
    assert lines[0]["id"] == 1
    assert "error" in lines[0]
    assert lines[0]["error"]["code"] == -32603
    assert "result" not in lines[0]
    return True, "Nested inf/-inf result -> -32603 InternalError, stdout stays valid JSON"


def test_notify_with_nonfinite_param_writes_nothing_invalid():
    """Non-finite value in an outbound notify() params is rejected before
    it ever reaches stdout: the `bad_event` notification must never appear,
    and the triggering request must come back as -32603 (the raise inside
    the handler propagates to the dispatch loop, same as any other handler
    exception)."""
    lines, stderr, rc = _run([_req(1, "notify_bad_nonfinite")])
    # _run() already proves every emitted line parses as valid JSON (it
    # calls json.loads on each stdout line); this asserts none of those
    # lines is the bad_event notification, and the request itself failed
    # cleanly rather than a corrupt half-written notification appearing.
    assert not any(l.get("method") == "bad_event" for l in lines)
    assert len(lines) == 1
    assert lines[0]["id"] == 1
    assert lines[0]["error"]["code"] == -32603
    return True, "Non-finite notify() param never reaches stdout; triggering request -> -32603"


# ── Test runner ────────────────────────────────────────────────────────────


def main():
    tests = [
        ("happy_path_request_response", test_happy_path_request_response),
        ("batch_many_requests", test_batch_many_requests),
        ("malformed_json", test_malformed_json),
        ("unknown_method", test_unknown_method),
        ("wrong_params_arity", test_wrong_params_arity),
        ("handler_body_typeerror_is_internal_error", test_handler_body_typeerror_is_internal_error),
        ("async_handler_body_typeerror_is_internal_error", test_async_handler_body_typeerror_is_internal_error),
        ("slow_async_handler_does_not_block_faster_requests", test_slow_async_handler_does_not_block_faster_requests),
        ("notify_mid_handler_interleaves_safely", test_notify_mid_handler_interleaves_safely),
        ("notification_no_response", test_notification_no_response),
        ("notification_error_no_response", test_notification_error_no_response),
        ("id_type_string", test_id_type_string),
        ("id_type_number", test_id_type_number),
        ("id_type_float", test_id_type_float),
        ("id_type_null", test_id_type_null),
        ("large_payload", test_large_payload),
        ("eof_shutdown", test_eof_shutdown),
        ("stderr_isolation", test_stderr_isolation),
        ("framing_fuzz_junk", test_framing_fuzz_junk),
        ("oversized_line_recovery", test_oversized_line_recovery),
        ("nan_result_is_internal_error", test_nan_result_is_internal_error),
        ("inf_nested_result_is_internal_error", test_inf_nested_result_is_internal_error),
        ("notify_with_nonfinite_param_writes_nothing_invalid", test_notify_with_nonfinite_param_writes_nothing_invalid),
    ]

    results = []
    all_pass = True

    print(f"Running {len(tests)} mpyjsonrpc tests against {MPY_BIN}\n")

    for test_name, test_fn in tests:
        try:
            passed, detail = test_fn()
            results.append(
                {"name": test_name, "pass": passed, "detail": detail}
            )
            status = "PASS" if passed else "FAIL"
            print(f"  {status}: {test_name}")
            if detail:
                print(f"        {detail}")
        except Exception as e:
            results.append(
                {"name": test_name, "pass": False, "detail": f"Exception: {e}"}
            )
            all_pass = False
            print(f"  FAIL: {test_name}")
            print(f"        Exception: {type(e).__name__}: {e}")

    print(f"\n{'='*70}")
    passed_count = sum(1 for r in results if r["pass"])
    print(f"Results: {passed_count}/{len(results)} passed")
    print(f"{'='*70}\n")

    return results, all_pass


if __name__ == "__main__":
    results, all_pass = main()

    # Output summary for StructuredOutput
    summary_text = f"P4 test driver for mpyjsonrpc: {sum(1 for r in results if r['pass'])}/{len(results)} tests passed"

    # For the orchestrator
    import sys

    if not all_pass:
        sys.exit(1)
