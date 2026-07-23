"""Conformance suite for mpyfastmcp, run against the actual MicroPython binary.

Spawns the picolet-runtime cli binary running `demo_server.py` (this
directory) as a real stdio subprocess and drives it as an MCP client would:
`initialize` handshake, `tools/list`, `tools/call` (success, validation
error, handler exception, unknown tool), `prompts/list`, `prompts/get`
(success and unknown prompt), a custom notification fired from the
server's `on_initialized` hook, and an unknown JSON-RPC method. Black-box
on purpose — it never imports `mpyfastmcp` from CPython (it cannot; see
`mpyjsonrpc`'s own conformance suite for why), it only proves the on-the-
wire behaviour of a MicroPython process using it.

Point `MPY_BIN` (env var) at the runtime binary if it isn't at the default
path used during Phase 6 development.
"""

import json
import os
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO_SERVER = os.path.join(HERE, "demo_server.py")
MPY_BIN = os.environ.get(
    "MPY_BIN",
    "/home/anl/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-cli",
)

pytestmark = pytest.mark.skipif(
    not os.path.exists(MPY_BIN),
    reason="picolet-runtime cli binary not found at %s (set MPY_BIN)" % MPY_BIN,
)


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


def _run(payload_lines, script=DEMO_SERVER, timeout=10):
    """Run `script` against a fixed scripted input, return (lines, stderr).

    Every line of stdout is round-tripped through `json.loads` here, so a
    framing corruption (a spliced or truncated line) fails the harness
    itself with a `JSONDecodeError` rather than a downstream assertion.
    """
    payload = b"".join(payload_lines)
    proc = subprocess.run(
        [MPY_BIN, script], input=payload, capture_output=True, timeout=timeout
    )
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return lines, proc.stderr


def _by_id(lines):
    return {l["id"]: l for l in lines if "id" in l}


INIT_REQ = _req(
    1,
    "initialize",
    {
        "protocolVersion": "2025-06-18",
        "capabilities": {"experimental": {"probe": True}},
        "clientInfo": {"name": "conformance-client", "version": "0.0.1"},
    },
)
INITIALIZED_NOTIF = _notif("notifications/initialized")


# ── initialize handshake ─────────────────────────────────────────────────


def test_initialize_echoes_known_protocol_version():
    lines, _ = _run([INIT_REQ])
    result = _by_id(lines)[1]["result"]
    assert result["protocolVersion"] == "2025-06-18"


def test_initialize_falls_back_to_latest_for_unknown_protocol_version():
    lines, _ = _run([_req(1, "initialize", {"protocolVersion": "1999-01-01"})])
    result = _by_id(lines)[1]["result"]
    assert result["protocolVersion"] == "2025-06-18"


def test_initialize_result_shape():
    lines, _ = _run([INIT_REQ])
    result = _by_id(lines)[1]["result"]
    assert result["serverInfo"] == {"name": "mpyfastmcp-demo", "version": "0.1.0"}
    assert result["capabilities"] == {"tools": {}, "prompts": {}}
    assert "instructions" in result


def test_oninitialized_notification_fires_after_handshake():
    # demo_server's on_initialized hook fires a custom notification once
    # `notifications/initialized` is received -- must land as its own,
    # separately-parseable line (no id), never corrupting other framing.
    lines, _ = _run([INIT_REQ, INITIALIZED_NOTIF, _req(2, "tools/list")])
    notifications = [l for l in lines if "id" not in l]
    assert any(n["method"] == "notifications/demo/ready" for n in notifications)
    assert _by_id(lines)[2]["result"]["tools"]


# ── tools/list ────────────────────────────────────────────────────────────


def test_tools_list_golden_schema():
    lines, _ = _run([INIT_REQ, _req(2, "tools/list")])
    tools = _by_id(lines)[2]["result"]["tools"]
    by_name = {t["name"]: t for t in tools}
    assert set(by_name) == {"echo", "add"}
    assert by_name["echo"]["inputSchema"] == {
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "Text to echo back"},
            "shout": {
                "type": "number",
                "description": "Non-zero to uppercase the echoed text",
            },
        },
        "required": ["message"],
    }
    assert by_name["add"]["inputSchema"] == {
        "type": "object",
        "properties": {
            "a": {"type": "number", "description": "First addend"},
            "b": {"type": "number", "description": "Second addend"},
        },
        "required": ["a", "b"],
    }
    # Registration order preserved (see mpyfastmcp docstring on why plain
    # dicts can't be relied on for this on MicroPython).
    assert [t["name"] for t in tools] == ["echo", "add"]


# ── tools/call ────────────────────────────────────────────────────────────


def test_tools_call_success_returns_content_shape():
    lines, _ = _run(
        [
            INIT_REQ,
            _req(2, "tools/call", {"name": "add", "arguments": {"a": 2, "b": 3}}),
        ]
    )
    result = _by_id(lines)[2]["result"]
    assert "isError" not in result
    assert result["content"] == [{"type": "text", "text": json.dumps({"sum": 5})}]


def test_tools_call_validation_error_is_isError_result_not_rpc_error():
    lines, _ = _run(
        [
            INIT_REQ,
            _req(2, "tools/call", {"name": "add", "arguments": {"a": "nope"}}),
        ]
    )
    response = _by_id(lines)[2]
    assert "error" not in response
    result = response["result"]
    assert result["isError"] is True
    assert "content" in result


def test_tools_call_unknown_tool_is_isError_result():
    lines, _ = _run(
        [INIT_REQ, _req(2, "tools/call", {"name": "does_not_exist", "arguments": {}})]
    )
    result = _by_id(lines)[2]["result"]
    assert result["isError"] is True
    assert "does_not_exist" in result["content"][0]["text"]


def test_tools_call_handler_exception_is_isError_result(tmp_path):
    script = tmp_path / "boom_server.py"
    script.write_text(
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "import asyncio\n"
        "from mpyfastmcp import MCPServer\n"
        "server = MCPServer('boom-demo', '0.0.1')\n"
        "\n"
        "@server.tool('boom', 'always raises', params=[])\n"
        "def boom():\n"
        "    raise ValueError('kaboom')\n"
        "\n"
        "server.run()\n" % os.path.dirname(HERE)
    )
    lines, _ = _run(
        [INIT_REQ, _req(2, "tools/call", {"name": "boom", "arguments": {}})],
        script=str(script),
    )
    result = _by_id(lines)[2]["result"]
    assert result["isError"] is True
    assert "kaboom" in result["content"][0]["text"]


def test_tools_call_dict_with_content_str_key_is_json_encoded(tmp_path):
    # A handler's natural return value may itself be a dict that happens to
    # have a `content` key (e.g. a file-read result, a message frame) whose
    # value is a plain string, not a content-block array. `tool_result` must
    # not mistake that for an already-shaped MCP result -- it has to fall
    # through to JSON-encoding, and a registered result middleware appending
    # to `result["content"]` (a list) must keep working against it.
    script = tmp_path / "raw_frame_server.py"
    script.write_text(
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "import asyncio\n"
        "from mpyfastmcp import MCPServer\n"
        "server = MCPServer('raw-frame-demo', '0.0.1')\n"
        "\n"
        "@server.tool('raw_frame', 'returns a dict with a content str key', params=[])\n"
        "def raw_frame():\n"
        "    return {'content': 'raw text body', 'path': '/x'}\n"
        "\n"
        "@server.on_tool_result\n"
        "def _tag(_tool_name, result):\n"
        "    result['content'].append({'type': 'text', 'text': 'tagged'})\n"
        "    return result\n"
        "\n"
        "server.run()\n" % os.path.dirname(HERE)
    )
    lines, _ = _run(
        [INIT_REQ, _req(2, "tools/call", {"name": "raw_frame", "arguments": {}})],
        script=str(script),
    )
    result = _by_id(lines)[2]["result"]
    assert "isError" not in result
    assert isinstance(result["content"], list)
    texts = [c["text"] for c in result["content"]]
    assert json.dumps({"content": "raw text body", "path": "/x"}) in texts
    assert "tagged" in texts


def test_result_middleware_appends_content_block():
    # demo_server's middleware appends a one-shot notice queued by its
    # on_initialized hook onto the *next* tool result's content array.
    lines, _ = _run(
        [
            INIT_REQ,
            INITIALIZED_NOTIF,
            _req(2, "tools/call", {"name": "echo", "arguments": {"message": "hi"}}),
        ]
    )
    result = _by_id(lines)[2]["result"]
    texts = [c["text"] for c in result["content"]]
    assert "hi" in texts
    assert "demo server says hello" in texts


# ── prompts/list, prompts/get ────────────────────────────────────────────


def test_prompts_list_golden_schema():
    lines, _ = _run([INIT_REQ, _req(2, "prompts/list")])
    prompts = _by_id(lines)[2]["result"]["prompts"]
    assert prompts == [
        {
            "name": "greet",
            "description": "Produce a greeting message for `name`.",
            "arguments": [
                {"name": "name", "description": "Who to greet", "required": True}
            ],
        }
    ]


def test_prompts_get_success_returns_messages_shape():
    lines, _ = _run(
        [INIT_REQ, _req(2, "prompts/get", {"name": "greet", "arguments": {"name": "Andrew"}})]
    )
    result = _by_id(lines)[2]["result"]
    assert result["description"] == "Greet Andrew"
    assert result["messages"][0]["role"] == "user"
    assert "Andrew" in result["messages"][0]["content"]["text"]


def test_prompts_get_unknown_prompt_is_invalid_params_rpc_error():
    lines, _ = _run([INIT_REQ, _req(2, "prompts/get", {"name": "nope"})])
    error = _by_id(lines)[2]["error"]
    assert error["code"] == -32602


# ── Unknown JSON-RPC method ───────────────────────────────────────────────


def test_unknown_method_is_method_not_found():
    lines, _ = _run([INIT_REQ, _req(2, "totally/unknown")])
    error = _by_id(lines)[2]["error"]
    assert error["code"] == -32601


# ── Notification framing under concurrent load ───────────────────────────


def test_notify_mid_session_does_not_corrupt_framing_around_tool_calls():
    # notifications/demo/ready fires as soon as notifications/initialized
    # is handled, concurrently with the tools/call requests queued right
    # behind it in the same input burst (mpyjsonrpc dispatches each line
    # as its own task) -- every line must still round-trip through
    # json.loads (already enforced by `_run`) and every request must still
    # get its own correctly-correlated response.
    lines, _ = _run(
        [
            INIT_REQ,
            INITIALIZED_NOTIF,
            _req(2, "tools/call", {"name": "add", "arguments": {"a": 1, "b": 1}}),
            _req(3, "tools/call", {"name": "add", "arguments": {"a": 2, "b": 2}}),
            _req(4, "tools/call", {"name": "add", "arguments": {"a": 3, "b": 3}}),
        ]
    )
    by_id = _by_id(lines)
    assert json.loads(by_id[2]["result"]["content"][0]["text"]) == {"sum": 2}
    assert json.loads(by_id[3]["result"]["content"][0]["text"]) == {"sum": 4}
    assert json.loads(by_id[4]["result"]["content"][0]["text"]) == {"sum": 6}
    notifications = [l for l in lines if "id" not in l]
    assert any(n["method"] == "notifications/demo/ready" for n in notifications)


# ── PRE-FREEZE fixes: run()/serve(), on_initialized isolation, prompts/get
# error code, lifecycle gating, on_tool_result rename, log_prefix ─────────


def test_serve_is_awaitable_and_run_drives_it(tmp_path):
    """`serve()` is the coroutine form (must be awaited to do anything);
    `run()` is the blocking wrapper that drives it without a caller-side
    `asyncio.run()`. A bare `server.serve()` call with no `await` and no
    surrounding `asyncio.run()` produces an un-awaited coroutine that never
    runs -- the server never touches stdin and emits nothing."""
    unawaited_script = tmp_path / "unawaited_serve_server.py"
    unawaited_script.write_text(
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "from mpyfastmcp import MCPServer\n"
        "server = MCPServer('unawaited-demo', '0.0.1')\n"
        "server.serve()\n"  # not awaited, no asyncio.run() -- must be a no-op
        % os.path.dirname(HERE)
    )
    lines, _ = _run([INIT_REQ], script=str(unawaited_script))
    assert lines == [], "bare server.serve() (unawaited) must not serve requests"

    awaited_script = tmp_path / "awaited_serve_server.py"
    awaited_script.write_text(
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "import asyncio\n"
        "from mpyfastmcp import MCPServer\n"
        "server = MCPServer('awaited-demo', '0.0.1')\n"
        "asyncio.run(server.serve())\n"  # awaited via asyncio.run -- must serve
        % os.path.dirname(HERE)
    )
    lines, _ = _run([INIT_REQ], script=str(awaited_script))
    result = _by_id(lines)[1]["result"]
    assert result["serverInfo"]["name"] == "awaited-demo"

    run_script = tmp_path / "run_server.py"
    run_script.write_text(
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "from mpyfastmcp import MCPServer\n"
        "server = MCPServer('run-demo', '0.0.1')\n"
        "server.run()\n"  # blocking wrapper -- must serve without asyncio.run()
        % os.path.dirname(HERE)
    )
    lines, _ = _run([INIT_REQ], script=str(run_script))
    result = _by_id(lines)[1]["result"]
    assert result["serverInfo"]["name"] == "run-demo"


def test_on_initialized_callbacks_are_exception_isolated(tmp_path):
    """A raising `on_initialized` callback must not stop later callbacks
    from running, matching `on_shutdown`'s isolation."""
    script = tmp_path / "oninit_isolation_server.py"
    script.write_text(
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "from mpyfastmcp import MCPServer\n"
        "server = MCPServer('oninit-isolation-demo', '0.0.1')\n"
        "\n"
        "@server.on_initialized\n"
        "def _first():\n"
        "    raise ValueError('first callback blew up')\n"
        "\n"
        "@server.on_initialized\n"
        "async def _second():\n"
        "    await server.notify('notifications/second/ran', {'ok': True})\n"
        "\n"
        "server.run()\n" % os.path.dirname(HERE)
    )
    lines, _ = _run(
        [INIT_REQ, INITIALIZED_NOTIF, _req(2, "tools/list")], script=str(script)
    )
    notifications = [l for l in lines if "id" not in l]
    assert any(
        n["method"] == "notifications/second/ran" for n in notifications
    ), "second on_initialized callback must still run after the first raises"


def test_prompts_get_bad_argument_is_invalid_params_rpc_error():
    """A `prompts/get` argument that fails `mpyschema.validate()` (here: the
    required `name` argument is missing) must surface as JSON-RPC
    `-32602` (`InvalidParams`), not `-32603` (`InternalError`)."""
    lines, _ = _run([INIT_REQ, _req(2, "prompts/get", {"name": "greet", "arguments": {}})])
    error = _by_id(lines)[2]["error"]
    assert error["code"] == -32602


def test_lifecycle_gating_rejects_pre_initialize_requests():
    """`tools/list`, `tools/call`, `prompts/list`, `prompts/get` must be
    rejected before `initialize` completes, and must work once it has."""
    lines, _ = _run([_req(1, "tools/list")])
    error = _by_id(lines)[1]["error"]
    assert error["code"] == -32002

    lines, _ = _run(
        [_req(1, "tools/call", {"name": "add", "arguments": {"a": 1, "b": 1}})]
    )
    assert _by_id(lines)[1]["error"]["code"] == -32002

    lines, _ = _run([_req(1, "prompts/list")])
    assert _by_id(lines)[1]["error"]["code"] == -32002

    lines, _ = _run([_req(1, "prompts/get", {"name": "greet", "arguments": {"name": "x"}})])
    assert _by_id(lines)[1]["error"]["code"] == -32002

    # Once initialize has completed, all four are served normally.
    lines, _ = _run([INIT_REQ, _req(2, "tools/list")])
    assert "error" not in _by_id(lines)[2]
    assert _by_id(lines)[2]["result"]["tools"]


def test_on_tool_result_rename_and_isError_visibility(tmp_path):
    """`on_tool_result` (formerly `add_result_middleware`) is the public
    registration method, and its callback runs for `isError` results too,
    not only successes."""
    script = tmp_path / "on_tool_result_server.py"
    script.write_text(
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "from mpyfastmcp import MCPServer\n"
        "server = MCPServer('on-tool-result-demo', '0.0.1')\n"
        "\n"
        "@server.tool('boom', 'always raises', params=[])\n"
        "def boom():\n"
        "    raise ValueError('kaboom')\n"
        "\n"
        "@server.on_tool_result\n"
        "def _tag(_tool_name, result):\n"
        "    result['content'].append({'type': 'text', 'text': 'tagged:%%s' %% result.get('isError', False)})\n"
        "    return result\n"
        "\n"
        "server.run()\n" % os.path.dirname(HERE)
    )
    assert not hasattr(
        __import__("mpyfastmcp", fromlist=["MCPServer"]).MCPServer,
        "add_result_middleware",
    ), "add_result_middleware must no longer exist as a public method"
    lines, _ = _run(
        [INIT_REQ, _req(2, "tools/call", {"name": "boom", "arguments": {}})],
        script=str(script),
    )
    result = _by_id(lines)[2]["result"]
    assert result["isError"] is True
    texts = [c["text"] for c in result["content"]]
    assert "tagged:True" in texts, "on_tool_result must fire on isError results too"


def test_log_prefix_derives_from_server_name():
    """`peer.log()` output is tagged with the server's own `name`, not a
    hard-coded `[mpyfastmcp]` prefix shared by every server."""
    _, stderr = _run([INIT_REQ, INITIALIZED_NOTIF, _req(2, "tools/list")])
    stderr_text = stderr.decode()
    assert "[mpyfastmcp-demo] " in stderr_text
    assert "[mpyfastmcp] " not in stderr_text
