"""Conformance suite for mpyjsonrpc, run against the actual MicroPython binary.

Spawns the picolet-runtime cli binary as a subprocess speaking real stdio
and drives it with hand-crafted request/notification/junk bytes, asserting
on the JSON-RPC responses (and, where relevant, stderr) it produces. This
is deliberately black-box: it never imports mpyjsonrpc from CPython (it
cannot — the module targets MicroPython's runtime primitives), it only
proves the on-the-wire behaviour of a MicroPython process using it.

Point `MPY_BIN` (env var) at the runtime binary if it isn't at the default
path used during Phase 4 development.
"""

import json
import os
import subprocess
import sys
import textwrap

import pytest

LIB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MPY_BIN = os.environ.get(
    "MPY_BIN",
    "/home/anl/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-cli",
)

pytestmark = pytest.mark.skipif(
    not os.path.exists(MPY_BIN),
    reason="picolet-runtime cli binary not found at %s (set MPY_BIN)" % MPY_BIN,
)

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

    def big(payload):
        return {"len": len(payload)}

    async def slow_echo(msg, delay=0.05):
        await asyncio.sleep(delay)
        return msg

    def unencodable_set():
        return {1, 2, 3}

    class Thing:
        pass

    def unencodable_object():
        return Thing()

    def boom_typeerror():
        return None + 1

    async def aboom_typeerror():
        return None + 1

    async def main():
        peer = rpc.JsonRpcPeer(max_line_bytes=%d)
        peer.register_method("add", add)
        peer.register_method("no_params", no_params)
        peer.register_method("boom", boom)
        peer.register_method("boom_typeerror", boom_typeerror)
        peer.register_method("aboom_typeerror", aboom_typeerror)
        peer.register_method("big", big)
        peer.register_method("slow_echo", slow_echo)
        peer.register_method("unencodable_set", unencodable_set)
        peer.register_method("unencodable_object", unencodable_object)

        async def notify_during_big(n, size):
            # Interleaves outbound notifications with assembling a large
            # result, so the single serialized writer is exercised against
            # a concurrent notify() call mid-handler, not just sequential
            # request/response traffic.
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


def _write_server(tmp_path, max_line_bytes=2 * 1024 * 1024):
    script = tmp_path / "server.py"
    script.write_text(SERVER_SCRIPT % (LIB_DIR, max_line_bytes))
    return str(script)


def _run(tmp_path, payload_lines, max_line_bytes=2 * 1024 * 1024, timeout=10):
    """Run the server against a fixed input, return (stdout_lines, stderr_bytes).

    `payload_lines` is a list of already-encoded bytes objects (each is
    written verbatim, back to back â€” include trailing `\\n` explicitly
    where a well-formed line is wanted).
    """
    script = _write_server(tmp_path, max_line_bytes)
    payload = b"".join(payload_lines)
    proc = subprocess.run(
        [MPY_BIN, script], input=payload, capture_output=True, timeout=timeout
    )
    stdout_lines = [
        json.loads(line) for line in proc.stdout.splitlines() if line.strip()
    ]
    return stdout_lines, proc.stderr


def _req(id_, method, params=None):
    obj = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        obj["params"] = params
    return (json.dumps(obj) + "\n").encode()


def _notif(method, params=None):
    obj = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        obj["params"] = params
    return (json.dumps(obj) + "\n").encode()


# ── Happy path ────────────────────────────────────────────────────────────


def test_happy_path_positional_and_named_params(tmp_path):
    lines, stderr = _run(
        tmp_path,
        [
            _req(1, "add", [2, 3]),
            _req("s1", "add", {"a": 10, "b": 5}),
        ],
    )
    by_id = {r["id"]: r for r in lines}
    assert by_id[1]["result"] == 5
    assert by_id["s1"]["result"] == 15


def test_no_params_call(tmp_path):
    lines, _ = _run(tmp_path, [_req(1, "no_params")])
    assert lines[0]["result"] == "ok"


# ── Batch-of-lines burst ────────────────────────────────────────────────


def test_batch_burst_all_get_responses(tmp_path):
    reqs = [_req(i, "add", [i, 1]) for i in range(20)]
    lines, _ = _run(tmp_path, reqs)
    by_id = {r["id"]: r["result"] for r in lines}
    assert by_id == {i: i + 1 for i in range(20)}


# ── JSON-RPC error objects ───────────────────────────────────────────────


def test_malformed_json_is_parse_error(tmp_path):
    lines, _ = _run(tmp_path, [b"not json at all\n"])
    assert lines[0]["error"]["code"] == -32700
    assert lines[0]["id"] is None


def test_unknown_method_is_method_not_found(tmp_path):
    lines, _ = _run(tmp_path, [_req(1, "does_not_exist")])
    assert lines[0]["error"]["code"] == -32601
    assert lines[0]["id"] == 1


def test_wrong_arity_params_is_invalid_params(tmp_path):
    lines, _ = _run(tmp_path, [_req(1, "add", [1])])
    assert lines[0]["error"]["code"] == -32602
    assert lines[0]["id"] == 1


def test_handler_exception_is_internal_error(tmp_path):
    lines, _ = _run(tmp_path, [_req(1, "boom")])
    assert lines[0]["error"]["code"] == -32603
    assert lines[0]["id"] == 1


def test_handler_body_typeerror_is_internal_error_not_invalid_params(tmp_path):
    # A TypeError raised by the handler's own body (not by `params` failing
    # to bind against its call signature) must be reported as -32603, the
    # same code as any other handler-side fault -- never -32602, which
    # would mislead the caller into thinking its arguments were wrong.
    lines, _ = _run(tmp_path, [_req(1, "boom_typeerror")])
    assert lines[0]["error"]["code"] == -32603
    assert lines[0]["id"] == 1


def test_async_handler_body_typeerror_is_internal_error(tmp_path):
    # Same fault as above, raised from an `async def` handler's body, must
    # produce the same -32603 code as the synchronous case.
    lines, _ = _run(tmp_path, [_req(1, "aboom_typeerror")])
    assert lines[0]["error"]["code"] == -32603
    assert lines[0]["id"] == 1


def test_wrong_arity_typeerror_is_invalid_params_not_internal_error(tmp_path):
    # Converse of the two tests above: a genuine call-signature mismatch
    # must still map to -32602, not regress to -32603.
    lines, _ = _run(tmp_path, [_req(1, "add", [1])])
    assert lines[0]["error"]["code"] == -32602
    assert lines[0]["id"] == 1


# ── Unencodable handler results never reach stdout as corrupt JSON ───────
#
# MicroPython's json.dumps doesn't raise on an unsupported type; it
# str()-renders it inline (e.g. `{"result": <Thing object at ...>}`), which
# would otherwise corrupt the response line. `_run` already round-trips
# every stdout line through `json.loads`, so a regression here would fail
# the harness itself (a `json.JSONDecodeError`) rather than just an
# assertion below — these tests exist to pin the -32603 behaviour on top
# of that.


def test_unencodable_set_result_is_internal_error(tmp_path):
    lines, _ = _run(tmp_path, [_req(1, "unencodable_set")])
    assert lines[0]["id"] == 1
    assert lines[0]["error"]["code"] == -32603


def test_unencodable_object_result_is_internal_error(tmp_path):
    lines, _ = _run(tmp_path, [_req(1, "unencodable_object")])
    assert lines[0]["id"] == 1
    assert lines[0]["error"]["code"] == -32603


def test_unencodable_notification_result_emits_no_response(tmp_path):
    # A notification's return value is never written to stdout at all (no
    # id to reply to), so an unencodable result is silently discarded
    # rather than surfaced anywhere -- this just pins that it doesn't
    # crash the loop or produce a stray line.
    lines, _ = _run(
        tmp_path,
        [
            _notif("unencodable_set"),
            _req(1, "no_params"),  # sentinel so we know the notif was processed
        ],
    )
    assert len(lines) == 1
    assert lines[0]["id"] == 1


def test_non_object_request_is_invalid_request(tmp_path):
    lines, _ = _run(tmp_path, [b"[1, 2, 3]\n"])
    assert lines[0]["error"]["code"] == -32600
    assert lines[0]["id"] is None


def test_missing_method_is_invalid_request(tmp_path):
    lines, _ = _run(tmp_path, [b'{"jsonrpc":"2.0","id":1}\n'])
    assert lines[0]["error"]["code"] == -32600
    assert lines[0]["id"] is None


# ── Notification handling ────────────────────────────────────────────────


def test_notification_emits_no_response(tmp_path):
    lines, _ = _run(
        tmp_path,
        [
            _notif("add", [1, 1]),
            _req(1, "add", [1, 1]),  # sentinel so we know the notif was processed
        ],
    )
    assert len(lines) == 1
    assert lines[0]["id"] == 1


def test_notification_error_does_not_respond(tmp_path):
    lines, _ = _run(
        tmp_path,
        [
            _notif("boom"),
            _req(1, "add", [1, 1]),
        ],
    )
    assert len(lines) == 1
    assert lines[0]["id"] == 1


# ── Id-type preservation ─────────────────────────────────────────────────


@pytest.mark.parametrize("id_value", [1, "abc", None, 3.5])
def test_id_type_is_echoed_exactly(tmp_path, id_value):
    lines, _ = _run(tmp_path, [_req(id_value, "no_params")])
    assert lines[0]["id"] == id_value


# ── Huge payload ─────────────────────────────────────────────────────────


def test_huge_payload_round_trips(tmp_path):
    payload = "x" * 300_000
    lines, _ = _run(tmp_path, [_req(1, "big", [payload])])
    assert lines[0]["result"]["len"] == 300_000


# ── Oversized-line guard / framing fuzz ─────────────────────────────────


def test_oversized_line_guard_recovers(tmp_path):
    oversized = b"z" * 5000 + b"\n"  # no newline until well past the tiny cap below
    good = _req(1, "no_params")
    lines, _ = _run(tmp_path, [oversized, good], max_line_bytes=1024)
    codes = [l["error"]["code"] for l in lines if "error" in l]
    assert -32700 in codes
    assert any(l.get("result") == "ok" for l in lines)


def test_framing_fuzz_junk_between_valid_lines_never_crashes(tmp_path):
    junk = b"\x00\x01\xff\xfe garbage { not json \n"
    lines, _ = _run(
        tmp_path,
        [_req(1, "no_params"), junk, _req(2, "no_params")],
    )
    by_id = {l.get("id"): l for l in lines}
    assert by_id[1]["result"] == "ok"
    assert by_id[2]["result"] == "ok"
    assert any(l["error"]["code"] == -32700 for l in lines if "error" in l)


# ── Concurrency: task-per-request completion order, notify() mid-handler ──


def test_slow_async_handler_does_not_block_faster_requests(tmp_path):
    # Task-per-request dispatch means a slow `async def` handler must not
    # stall the fast requests queued behind it in the same read burst: the
    # fast responses are expected to land before the slow one, i.e. NOT in
    # input order, proving the read loop doesn't serialize handler
    # execution sequentially per-connection.
    reqs = [
        _req("slow", "slow_echo", ["late"]),  # default delay 0.05s
        _req(1, "add", [1, 1]),
        _req(2, "add", [2, 1]),
        _req(3, "add", [3, 1]),
    ]
    lines, _ = _run(tmp_path, reqs)
    order = [l["id"] for l in lines]
    assert order.index("slow") > order.index(1)
    assert order.index("slow") > order.index(2)
    assert order.index("slow") > order.index(3)
    by_id = {l["id"]: l["result"] for l in lines}
    assert by_id == {"slow": "late", 1: 2, 2: 3, 3: 4}


def test_notify_fired_mid_handler_interleaves_safely_with_large_response(tmp_path):
    # The mandated concurrency-policy test: a handler that calls
    # `peer.notify()` repeatedly *while* assembling a large result exercises
    # the single serialized writer against real interleaving, not just
    # sequential request/response traffic. Every stdout line -- each
    # notification and the final response -- must still be a complete,
    # independently parseable JSON line; `_run` already round-trips every
    # line through `json.loads`, so a framing corruption would fail there
    # rather than in the assertions below.
    lines, _ = _run(
        tmp_path, [_req(1, "notify_during_big", {"n": 50, "size": 100_000})]
    )
    notifications = [l for l in lines if "id" not in l]
    responses = [l for l in lines if l.get("id") == 1]
    assert len(notifications) == 50
    assert [n["params"]["i"] for n in notifications] == list(range(50))
    assert len(responses) == 1
    assert len(responses[0]["result"]) == 100_000


# ── EOF / shutdown / stderr separation ───────────────────────────────────


def test_eof_fires_shutdown_callback(tmp_path):
    _, stderr = _run(tmp_path, [_req(1, "no_params")])
    assert b"shutdown-callback-fired" in stderr


def test_stderr_never_pollutes_stdout(tmp_path):
    lines, stderr = _run(tmp_path, [_req(1, "no_params")])
    assert lines[0]["result"] == "ok"
    assert b"shutdown-callback-fired" in stderr
    # every stdout line must be valid, complete JSON (already enforced by
    # `_run`'s json.loads over each line) and none of them contain the
    # log prefix that only ever goes to stderr
    for line in lines:
        assert "shutdown-callback-fired" not in json.dumps(line)
