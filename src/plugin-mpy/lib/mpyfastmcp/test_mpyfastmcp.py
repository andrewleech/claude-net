#!/usr/bin/env python3
"""CPython harness: comprehensive MCP conformance suite for mpyfastmcp (P6 test author).

This harness acts as an MCP client against the mpyfastmcp demo server
running on the picolet MicroPython binary, maintaining state across requests.

Test coverage (all MUST pass):
- Full initialize handshake with protocolVersion negotiation
- Client-capability echo via on_initialized / get_client_capabilities
- tools/list golden output with schema validation
- tools/call success case
- tools/call with invalid args -> validation error result (isError)
- Handler exception -> isError result (peer does not crash)
- prompts/list and prompts/get round-trip
- server.notify() emitted MID-request does not corrupt JSON-RPC framing
- Unknown JSON-RPC method -> -32601
- Result post-processing hook actually appends content block to tool result

Run standalone:
  python3 test_mpyfastmcp.py
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).parent.absolute()
DEMO_SERVER = HERE / "demo_server.py"
MPY_BIN = os.environ.get(
    "MPY_BIN",
    "/home/anl/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-cli",
)


class MCPStatefulClient:
    """Stateful MCP client that accumulates requests and replays session."""

    def __init__(self, script: Path, binary: str):
        self.script = script
        self.binary = binary
        self.id_counter = 0
        self.notifications: List[Dict[str, Any]] = []
        self._input_lines: List[str] = []  # Store as strings for easier debugging
        self._cached_responses: Dict[int, Dict[str, Any]] = {}

    def _next_id(self) -> int:
        self.id_counter += 1
        return self.id_counter

    def request(
        self, method: str, params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Send a JSON-RPC request and return the matching response.

        This works by re-running the entire session (all accumulated input)
        and parsing all output to find the response to this request.
        """
        req_id = self._next_id()
        obj = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            obj["params"] = params
        line = json.dumps(obj)
        self._input_lines.append(line)

        # Re-run the server with all accumulated input
        input_data = "\n".join(self._input_lines) + "\n"
        proc = subprocess.Popen(
            [str(self.binary), str(self.script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, stderr = proc.communicate(input=input_data, timeout=10)

        # Parse all output lines
        lines = [
            json.loads(line)
            for line in stdout.strip().split("\n")
            if line.strip()
        ]

        # Find our response and collect all notifications
        response = None
        for line in lines:
            if isinstance(line, dict):
                if "id" in line:
                    if line.get("id") == req_id:
                        response = line
                else:
                    # It's a notification (no id)
                    if line not in self.notifications:
                        self.notifications.append(line)

        if response is None:
            raise RuntimeError(f"No response to request {req_id} found in output")

        if "error" in response:
            raise RuntimeError(
                f"RPC error {response['error']['code']}: {response['error']['message']}"
            )

        return response.get("result", {})

    async def request_async(
        self, method: str, params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Async wrapper for request()."""
        return self.request(method, params)

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        """Queue a JSON-RPC notification."""
        obj = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            obj["params"] = params
        line = json.dumps(obj)
        self._input_lines.append(line)

    def drain_notifications(self) -> List[Dict[str, Any]]:
        """Return and clear accumulated notifications."""
        result = self.notifications[:]
        self.notifications.clear()
        return result


def _spawn_client(script: Path, binary: str) -> MCPStatefulClient:
    """Create an MCP client for testing."""
    return MCPStatefulClient(script, binary)


def _run_script(
    script: Path, input_lines: List[str], timeout: float = 10
) -> Tuple[List[Dict[str, Any]], str]:
    """Run `script` against a fixed, one-shot list of raw JSON-RPC lines.

    Unlike `MCPStatefulClient` (which replays the whole session on every
    call), this is a single subprocess invocation -- used for the
    run()/serve() and log_prefix tests below, where what matters is
    whether/how the process starts up at all, not multi-request state.
    """
    input_data = ("\n".join(input_lines) + "\n") if input_lines else ""
    proc = subprocess.run(
        [str(MPY_BIN), str(script)],
        input=input_data,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    lines = [json.loads(l) for l in proc.stdout.strip().split("\n") if l.strip()]
    return lines, proc.stderr


def _by_id(lines: List[Dict[str, Any]], req_id: int) -> Optional[Dict[str, Any]]:
    for line in lines:
        if line.get("id") == req_id:
            return line
    return None


def _write_script(tmp_dir: Path, name: str, body: str) -> Path:
    path = tmp_dir / name
    path.write_text(body)
    return path


# ─────────────────────────────────────────────────────────────────────────────
# Test suite
# ─────────────────────────────────────────────────────────────────────────────


def test_initialize_echoes_known_protocol_version():
    """Test: initialize handshake with known protocol version."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    result = client.request(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {"experimental": {"probe": True}},
            "clientInfo": {"name": "conformance-client", "version": "0.0.1"},
        },
    )
    assert result["protocolVersion"] == "2025-06-18", f"Got {result['protocolVersion']}"
    assert "serverInfo" in result
    assert result["serverInfo"]["name"] == "mpyfastmcp-demo"


def test_initialize_falls_back_to_latest_for_unknown_version():
    """Test: unknown protocol version falls back to latest."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    result = client.request(
        "initialize",
        {
            "protocolVersion": "1999-01-01",
            "capabilities": {},
            "clientInfo": {"name": "client", "version": "0.0.1"},
        },
    )
    assert result["protocolVersion"] == "2025-06-18", f"Got {result['protocolVersion']}"


def test_initialize_result_shape():
    """Test: initialize result includes serverInfo, capabilities, instructions."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    result = client.request("initialize", {"protocolVersion": "2025-06-18"})
    assert result["serverInfo"]["name"] == "mpyfastmcp-demo"
    assert result["serverInfo"]["version"] == "0.1.0"
    assert "capabilities" in result
    assert "tools" in result["capabilities"]
    assert "prompts" in result["capabilities"]
    assert "resources" in result["capabilities"]
    assert "instructions" in result


def test_on_initialized_fires_and_client_capabilities_available():
    """Test: on_initialized hook fires, client capabilities are captured."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {"experimental": {"probe": True}},
        },
    )
    client.notify("notifications/initialized")
    # Make a follow-up request to allow the notification to be processed
    client.request("tools/list")

    # The demo_server's on_initialized emits a custom notification
    notifications = client.drain_notifications()
    assert any(
        n.get("method") == "notifications/demo/ready" for n in notifications
    ), f"Expected notifications/demo/ready in {notifications}"


def test_tools_list_golden_schema():
    """Test: tools/list returns golden schema for echo and add tools."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request("tools/list")

    tools = result["tools"]
    assert len(tools) == 2, f"Expected 2 tools, got {len(tools)}: {[t['name'] for t in tools]}"
    by_name = {t["name"]: t for t in tools}

    # Check echo tool
    assert "echo" in by_name, f"echo tool not found in {by_name.keys()}"
    echo_schema = by_name["echo"]["inputSchema"]
    assert echo_schema["type"] == "object"
    assert "message" in echo_schema["properties"]
    assert echo_schema["properties"]["message"]["type"] == "string"
    assert (
        echo_schema["properties"]["message"]["description"] == "Text to echo back"
    )
    assert "shout" in echo_schema["properties"]
    assert echo_schema["properties"]["shout"]["type"] == "number"
    assert echo_schema["required"] == ["message"], f"Got required={echo_schema['required']}"

    # Check add tool
    assert "add" in by_name, f"add tool not found"
    add_schema = by_name["add"]["inputSchema"]
    assert set(add_schema["properties"].keys()) == {"a", "b"}
    assert add_schema["required"] == ["a", "b"]

    # Verify registration order is preserved
    assert [t["name"] for t in tools] == ["echo", "add"]


def test_tools_call_success_returns_content_shape():
    """Test: successful tool call returns content array with text block."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request(
        "tools/call", {"name": "add", "arguments": {"a": 2, "b": 3}}
    )

    assert "isError" not in result or result.get("isError") is False
    assert "content" in result
    assert isinstance(result["content"], list)
    assert len(result["content"]) >= 1
    assert result["content"][0]["type"] == "text"
    text_content = result["content"][0]["text"]
    parsed = json.loads(text_content)
    assert parsed == {"sum": 5}, f"Expected {{'sum': 5}}, got {parsed}"


def test_tools_call_tolerates_meta_param():
    """Regression: MCP clients (e.g. Claude Code) attach a reserved `_meta`
    field to request params. Since handlers are dispatched via
    `handler(**params)`, a `_meta` sibling of `arguments` must not raise
    "unexpected keyword argument" (-32602). Also covers prompts/get."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})

    result = client.request(
        "tools/call",
        {"name": "add", "arguments": {"a": 2, "b": 3}, "_meta": {"progressToken": "t"}},
    )
    assert "content" in result and not result.get("isError"), result
    assert json.loads(result["content"][0]["text"]) == {"sum": 5}

    # prompts/get carries _meta too.
    got = client.request(
        "prompts/get",
        {"name": "greet", "arguments": {"name": "x"}, "_meta": {"progressToken": "t"}},
    )
    assert "messages" in got, got


def test_tools_call_validation_error_is_isError_not_rpc_error():
    """Test: validation error returns isError result, not JSON-RPC error."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request(
        "tools/call", {"name": "add", "arguments": {"a": "not_a_number"}}
    )

    # Should be a successful JSON-RPC response with isError=True
    assert "isError" in result
    assert result["isError"] is True
    assert "content" in result
    assert result["content"][0]["type"] == "text"
    error_text = result["content"][0]["text"].lower()
    # Error message should mention validation or type
    assert (
        "parameter" in error_text or "expected" in error_text
    ), f"Got error: {error_text}"


def test_tools_call_unknown_tool_is_isError():
    """Test: unknown tool name returns isError result."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request(
        "tools/call", {"name": "does_not_exist", "arguments": {}}
    )

    assert result["isError"] is True
    assert "does_not_exist" in result["content"][0]["text"]


def test_tools_call_handler_exception_is_isError():
    """Test: handler exception returns isError result, not crashed peer."""
    # Create a temporary server with a tool that raises
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(
            """
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
import asyncio
from mpyfastmcp import MCPServer

server = MCPServer('boom-demo', '0.0.1')

@server.tool('boom', 'always raises', params=[])
def boom():
    raise ValueError('kaboom')

server.run()
"""
        )
        script_path = f.name

    try:
        client = _spawn_client(Path(script_path), MPY_BIN)
        client.request("initialize", {"protocolVersion": "2025-06-18"})
        result = client.request("tools/call", {"name": "boom", "arguments": {}})

        # Should still get a valid response, not a crashed peer
        assert result["isError"] is True
        assert "kaboom" in result["content"][0]["text"]
    finally:
        os.unlink(script_path)


def test_prompts_list_golden_schema():
    """Test: prompts/list returns greet prompt with correct arguments."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request("prompts/list")

    prompts = result["prompts"]
    assert len(prompts) == 1, f"Expected 1 prompt, got {len(prompts)}"
    assert prompts[0]["name"] == "greet"
    assert prompts[0]["description"] == "Produce a greeting message for `name`."
    assert len(prompts[0]["arguments"]) == 1
    assert prompts[0]["arguments"][0]["name"] == "name"
    assert prompts[0]["arguments"][0]["description"] == "Who to greet"
    assert prompts[0]["arguments"][0]["required"] is True


def test_prompts_get_success_returns_messages_shape():
    """Test: prompts/get returns description and messages array."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request(
        "prompts/get", {"name": "greet", "arguments": {"name": "Andrew"}}
    )

    assert "description" in result
    assert "Andrew" in result["description"]
    assert "messages" in result
    assert isinstance(result["messages"], list)
    assert len(result["messages"]) >= 1
    assert result["messages"][0]["role"] == "user"
    assert "Andrew" in result["messages"][0]["content"]["text"]


def test_prompts_get_unknown_prompt_is_rpc_error():
    """Test: unknown prompt name returns JSON-RPC error (-32602)."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    try:
        client.request("prompts/get", {"name": "does_not_exist"})
        assert False, "Should have raised RPC error"
    except RuntimeError as e:
        # InvalidParams is -32602
        assert "-32602" in str(e), f"Expected InvalidParams error, got {e}"


def test_resources_list_golden_schema():
    """Test: resources/list returns golden schema for the notes resource."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request("resources/list")

    resources = result["resources"]
    assert len(resources) == 1, f"Expected 1 resource, got {len(resources)}"
    assert resources[0]["uri"] == "resource://demo/notes"
    assert resources[0]["name"] == "Demo Notes"
    assert resources[0]["description"] == "A short, static, read-only note resource."
    assert resources[0]["mimeType"] == "text/plain"


def test_resources_read_success_returns_contents_shape():
    """Test: resources/read returns a contents array with a text block."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request("resources/read", {"uri": "resource://demo/notes"})

    assert "contents" in result
    assert isinstance(result["contents"], list)
    assert len(result["contents"]) == 1
    content = result["contents"][0]
    assert content["uri"] == "resource://demo/notes"
    assert content["mimeType"] == "text/plain"
    assert content["text"] == "This is a static demo resource exposed by mpyfastmcp."


def test_resources_read_unknown_uri_is_rpc_error():
    """Test: unknown resource uri returns JSON-RPC error (-32602)."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    try:
        client.request("resources/read", {"uri": "resource://demo/nope"})
        assert False, "Should have raised RPC error"
    except RuntimeError as e:
        assert "-32602" in str(e), f"Expected InvalidParams error, got {e}"


def test_resources_list_before_initialize_is_rejected():
    """`resources/list` before `initialize` completes must be rejected;
    after `initialize`, it must work."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    try:
        client.request("resources/list")
        assert False, "Should have raised RPC error"
    except RuntimeError as e:
        assert "-32002" in str(e), f"Expected -32002 (not initialized), got {e}"

    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request("resources/list")
    assert result["resources"]


def test_resources_capability_only_advertised_when_a_resource_exists():
    """`{"resources": {}}` must appear in `initialize`'s `capabilities` only
    once at least one `@server.resource` is registered, matching how
    `tools`/`prompts` are only advertised once at least one is
    registered."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        script = _write_script(
            tmp_dir,
            "no_resources_server.py",
            "import sys\n"
            "sys.path.insert(0, %r)\n"
            "from mpyfastmcp import MCPServer\n"
            "server = MCPServer('no-resources-demo', '0.0.1')\n"
            "\n"
            "@server.tool('noop', 'does nothing', params=[])\n"
            "def noop():\n"
            "    return 'ok'\n"
            "\n"
            "server.run()\n" % os.path.dirname(HERE),
        )
        init_req = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"},
            }
        )
        lines, _ = _run_script(script, [init_req])
        result = _by_id(lines, 1)["result"]
        assert result["capabilities"] == {"tools": {}}
        assert "resources" not in result["capabilities"]


def test_client_capabilities_and_info_are_none_before_initialize():
    """Q6 sentinel: `get_client_capabilities()` and `get_client_info()` must
    both return `None` before `initialize` has been handled."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        script = _write_script(
            tmp_dir,
            "q6_sentinel_server.py",
            "import sys\n"
            "sys.path.insert(0, %r)\n"
            "from mpyfastmcp import MCPServer\n"
            "server = MCPServer('q6-demo', '0.0.1')\n"
            "server.peer.log('pre-init caps=%%r info=%%r' %% "
            "(server.get_client_capabilities(), server.get_client_info()))\n"
            "\n"
            "@server.on_initialized\n"
            "def _check():\n"
            "    server.peer.log('post-init caps=%%r info=%%r' %% "
            "(server.get_client_capabilities(), server.get_client_info()))\n"
            "\n"
            "server.run()\n" % os.path.dirname(HERE),
        )
        init_req = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"experimental": {"probe": True}},
                    "clientInfo": {"name": "conformance-client", "version": "0.0.1"},
                },
            }
        )
        initialized_notif = json.dumps(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}
        )
        tools_list_req = json.dumps(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
        )
        _, stderr = _run_script(
            script, [init_req, initialized_notif, tools_list_req]
        )
        assert "pre-init caps=None info=None" in stderr
        post_init_line = next(
            line for line in stderr.splitlines() if "post-init" in line
        )
        assert "caps={'experimental': {'probe': True}}" in post_init_line
        assert "info=None" not in post_init_line, post_init_line
        assert "conformance-client" in post_init_line


def test_unknown_method_is_method_not_found():
    """Test: unknown JSON-RPC method returns -32601."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    try:
        client.request("totally/unknown/method")
        assert False, "Should have raised RPC error"
    except RuntimeError as e:
        # MethodNotFound is -32601
        assert "-32601" in str(e), f"Expected MethodNotFound error, got {e}"


def test_notify_mid_session_does_not_corrupt_framing():
    """Test: notifications emitted mid-request don't corrupt JSON-RPC framing.

    The demo_server's on_initialized hook emits a custom notification as soon
    as notifications/initialized is received. Multiple tool/call requests
    after that should all parse correctly.
    """
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    client.notify("notifications/initialized")

    # Multiple back-to-back tool calls while the notification is firing
    result1 = client.request(
        "tools/call", {"name": "add", "arguments": {"a": 1, "b": 1}}
    )
    result2 = client.request(
        "tools/call", {"name": "add", "arguments": {"a": 2, "b": 2}}
    )
    result3 = client.request(
        "tools/call", {"name": "add", "arguments": {"a": 3, "b": 3}}
    )

    # Verify each request got the correct result
    assert json.loads(result1["content"][0]["text"]) == {"sum": 2}
    assert json.loads(result2["content"][0]["text"]) == {"sum": 4}
    assert json.loads(result3["content"][0]["text"]) == {"sum": 6}

    # Verify notifications still landed
    notifications = client.drain_notifications()
    assert any(
        n.get("method") == "notifications/demo/ready" for n in notifications
    ), f"Expected notifications/demo/ready in {notifications}"


def test_result_middleware_appends_content_block():
    """Test: result middleware appends pending notices to tool results."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    client.notify("notifications/initialized")

    # Now call a tool; the middleware should append the pending notice
    result = client.request(
        "tools/call", {"name": "echo", "arguments": {"message": "hi"}}
    )

    assert "content" in result
    content_texts = [c["text"] for c in result["content"]]
    assert any("hi" in text for text in content_texts), f"Expected 'hi' in {content_texts}"
    assert any(
        "demo server says hello" in text for text in content_texts
    ), f"Expected 'demo server says hello' in {content_texts}"


def test_parity_initialize_result_shape():
    """Parity check: compare initialize result structural shape."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    result = client.request(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "1.0.0"},
        },
    )

    # Top-level keys should match MCP spec
    expected_keys = {"protocolVersion", "serverInfo", "capabilities"}
    assert set(result.keys()).issuperset(
        expected_keys
    ), f"Missing keys: {expected_keys - set(result.keys())}"

    # serverInfo must have name and version
    assert "name" in result["serverInfo"]
    assert "version" in result["serverInfo"]

    # capabilities must have tools and prompts
    assert "tools" in result["capabilities"]
    assert "prompts" in result["capabilities"]


def test_parity_with_bun_plugin_hubless():
    """Parity check: compare initialize response with bun plugin running hubless.

    This test runs the bun plugin in hubless mode and compares the structural
    shape of the initialize response with mpyfastmcp's response.
    """
    # Check if bun is available
    try:
        subprocess.run(["bun", "--version"], capture_output=True, timeout=2, check=True)
        bun_available = True
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        bun_available = False

    if not bun_available:
        return  # Skip if bun not available

    # Test with mpyfastmcp
    mpy_client = _spawn_client(DEMO_SERVER, MPY_BIN)
    mpy_result = mpy_client.request(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "1.0.0"},
        },
    )

    # Test with bun plugin
    init_params = {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "test-client", "version": "1.0.0"},
    }
    input_data = (
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": init_params,
            }
        )
        + "\n"
    )
    proc = subprocess.Popen(
        ["bun", "run", "/home/anl/claude-net/src/plugin/plugin.ts"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "CLAUDE_NET_HUB": ""},
    )
    stdout, _ = proc.communicate(input=input_data, timeout=10)

    bun_lines = [
        json.loads(line)
        for line in stdout.strip().split("\n")
        if line.strip()
    ]
    bun_result = None
    for line in bun_lines:
        if isinstance(line, dict) and line.get("id") == 1:
            bun_result = line.get("result", {})
            break

    assert bun_result is not None, f"No initialize response from bun plugin"

    # Compare structural shapes
    mpy_keys = set(mpy_result.keys())
    bun_keys = set(bun_result.keys())

    # Both must have protocolVersion, serverInfo, capabilities
    required_keys = {"protocolVersion", "serverInfo", "capabilities"}
    assert mpy_keys.issuperset(
        required_keys
    ), f"mpyfastmcp missing keys: {required_keys - mpy_keys}"
    assert bun_keys.issuperset(
        required_keys
    ), f"bun plugin missing keys: {required_keys - bun_keys}"

    # protocolVersion must match
    assert (
        mpy_result["protocolVersion"] == bun_result["protocolVersion"]
    ), f"protocolVersion mismatch: mpy={mpy_result['protocolVersion']} vs bun={bun_result['protocolVersion']}"

    # serverInfo must have name and version in both
    assert "name" in mpy_result["serverInfo"]
    assert "version" in mpy_result["serverInfo"]
    assert "name" in bun_result["serverInfo"]
    assert "version" in bun_result["serverInfo"]

    # capabilities structure must be compatible
    assert isinstance(mpy_result["capabilities"], dict)
    assert isinstance(bun_result["capabilities"], dict)


# ─────────────────────────────────────────────────────────────────────────────
# PRE-FREEZE fixes: run()/serve(), on_initialized isolation, prompts/get
# error code, lifecycle gating, on_tool_result rename, log_prefix
# ─────────────────────────────────────────────────────────────────────────────


def test_serve_is_awaitable_and_run_drives_it():
    """`serve()` is the coroutine form; `run()` is the blocking wrapper.
    A bare, un-awaited `server.serve()` must be a silent no-op (no
    `asyncio.run()`, no `await`); wrapping it in `asyncio.run()`, or
    calling the blocking `server.run()` directly, must both serve
    requests."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        init_req = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
        )

        unawaited = _write_script(
            tmp_dir,
            "unawaited_serve_server.py",
            "import sys\n"
            "sys.path.insert(0, %r)\n"
            "from mpyfastmcp import MCPServer\n"
            "server = MCPServer('unawaited-demo', '0.0.1')\n"
            "server.serve()\n" % os.path.dirname(HERE),
        )
        lines, _ = _run_script(unawaited, [init_req])
        assert lines == [], "bare server.serve() (unawaited) must not serve requests"

        awaited = _write_script(
            tmp_dir,
            "awaited_serve_server.py",
            "import sys\n"
            "sys.path.insert(0, %r)\n"
            "import asyncio\n"
            "from mpyfastmcp import MCPServer\n"
            "server = MCPServer('awaited-demo', '0.0.1')\n"
            "asyncio.run(server.serve())\n" % os.path.dirname(HERE),
        )
        lines, _ = _run_script(awaited, [init_req])
        result = _by_id(lines, 1)["result"]
        assert result["serverInfo"]["name"] == "awaited-demo"

        run_script = _write_script(
            tmp_dir,
            "run_server.py",
            "import sys\n"
            "sys.path.insert(0, %r)\n"
            "from mpyfastmcp import MCPServer\n"
            "server = MCPServer('run-demo', '0.0.1')\n"
            "server.run()\n" % os.path.dirname(HERE),
        )
        lines, _ = _run_script(run_script, [init_req])
        result = _by_id(lines, 1)["result"]
        assert result["serverInfo"]["name"] == "run-demo"


def test_on_initialized_callbacks_are_exception_isolated():
    """A raising `on_initialized` callback must not stop later callbacks
    from running."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        script = _write_script(
            tmp_dir,
            "oninit_isolation_server.py",
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
            "server.run()\n" % os.path.dirname(HERE),
        )
        init_req = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"},
            }
        )
        initialized_notif = json.dumps(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}
        )
        tools_list_req = json.dumps(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
        )
        lines, _ = _run_script(
            script, [init_req, initialized_notif, tools_list_req]
        )
        notifications = [l for l in lines if "id" not in l]
        assert any(
            n.get("method") == "notifications/second/ran" for n in notifications
        ), f"second on_initialized callback must still run after the first raises, got {notifications}"


def test_prompts_get_bad_argument_is_invalid_params():
    """`prompts/get` with a bad argument (missing required `name`) must
    surface as JSON-RPC `-32602` (`InvalidParams`), not `-32603`."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    client.request("initialize", {"protocolVersion": "2025-06-18"})
    try:
        client.request("prompts/get", {"name": "greet", "arguments": {}})
        assert False, "Should have raised RPC error"
    except RuntimeError as e:
        assert "-32602" in str(e), f"Expected InvalidParams (-32602), got {e}"


def test_tools_list_before_initialize_is_rejected():
    """`tools/list` before `initialize` completes must be rejected; after
    `initialize`, it must work."""
    client = _spawn_client(DEMO_SERVER, MPY_BIN)
    try:
        client.request("tools/list")
        assert False, "Should have raised RPC error"
    except RuntimeError as e:
        assert "-32002" in str(e), f"Expected -32002 (not initialized), got {e}"

    client.request("initialize", {"protocolVersion": "2025-06-18"})
    result = client.request("tools/list")
    assert result["tools"]


def test_on_tool_result_rename_and_isError_visibility():
    """`on_tool_result` (formerly `add_result_middleware`) is the public
    registration method, and its callback runs for `isError` results too."""
    lib_dir = os.path.dirname(HERE)
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    from mpyfastmcp import MCPServer

    assert not hasattr(
        MCPServer, "add_result_middleware"
    ), "add_result_middleware must no longer exist as a public method"
    assert hasattr(MCPServer, "on_tool_result")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        script = _write_script(
            tmp_dir,
            "on_tool_result_server.py",
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
            "server.run()\n" % os.path.dirname(HERE),
        )
        init_req = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"},
            }
        )
        boom_req = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "boom", "arguments": {}},
            }
        )
        lines, _ = _run_script(script, [init_req, boom_req])
        result = _by_id(lines, 2)["result"]
        assert result["isError"] is True
        texts = [c["text"] for c in result["content"]]
        assert (
            "tagged:True" in texts
        ), f"on_tool_result must fire on isError results too, got {texts}"


def test_log_prefix_derives_from_server_name():
    """`peer.log()` output is tagged with the server's own `name`, not a
    hard-coded `[mpyfastmcp]` prefix shared by every server."""
    init_req = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        }
    )
    initialized_notif = json.dumps(
        {"jsonrpc": "2.0", "method": "notifications/initialized"}
    )
    tools_list_req = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    _, stderr = _run_script(
        DEMO_SERVER, [init_req, initialized_notif, tools_list_req]
    )
    assert "[mpyfastmcp-demo] " in stderr
    assert "[mpyfastmcp] " not in stderr


# ─────────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────────


def run_all_tests() -> Tuple[bool, List[Tuple[str, bool, str]]]:
    """Run all tests and return (all_passed, results)."""
    tests = [
        test_initialize_echoes_known_protocol_version,
        test_initialize_falls_back_to_latest_for_unknown_version,
        test_initialize_result_shape,
        test_on_initialized_fires_and_client_capabilities_available,
        test_tools_list_golden_schema,
        test_tools_call_success_returns_content_shape,
        test_tools_call_tolerates_meta_param,
        test_tools_call_validation_error_is_isError_not_rpc_error,
        test_tools_call_unknown_tool_is_isError,
        test_tools_call_handler_exception_is_isError,
        test_prompts_list_golden_schema,
        test_prompts_get_success_returns_messages_shape,
        test_prompts_get_unknown_prompt_is_rpc_error,
        test_resources_list_golden_schema,
        test_resources_read_success_returns_contents_shape,
        test_resources_read_unknown_uri_is_rpc_error,
        test_resources_list_before_initialize_is_rejected,
        test_resources_capability_only_advertised_when_a_resource_exists,
        test_client_capabilities_and_info_are_none_before_initialize,
        test_unknown_method_is_method_not_found,
        test_notify_mid_session_does_not_corrupt_framing,
        test_result_middleware_appends_content_block,
        test_parity_initialize_result_shape,
        test_parity_with_bun_plugin_hubless,
        test_serve_is_awaitable_and_run_drives_it,
        test_on_initialized_callbacks_are_exception_isolated,
        test_prompts_get_bad_argument_is_invalid_params,
        test_tools_list_before_initialize_is_rejected,
        test_on_tool_result_rename_and_isError_visibility,
        test_log_prefix_derives_from_server_name,
    ]

    results: List[Tuple[str, bool, str]] = []
    for test_func in tests:
        test_name = test_func.__name__
        try:
            test_func()
            results.append((test_name, True, "PASS"))
            print(f"✓ {test_name}")
        except Exception as e:
            results.append((test_name, False, str(e)))
            print(f"✗ {test_name}")

    all_passed = all(r[1] for r in results)
    return all_passed, results


def main():
    """Main entry point."""
    print("=" * 70)
    print("MCP Conformance Suite for mpyfastmcp (P6 test author/runner)")
    print("=" * 70)
    print()

    # Check prerequisites
    if not Path(MPY_BIN).exists():
        print(f"ERROR: MPY_BIN not found at {MPY_BIN}")
        print(f"Set MPY_BIN env var to the picolet-runtime binary path")
        sys.exit(1)

    if not DEMO_SERVER.exists():
        print(f"ERROR: demo_server.py not found at {DEMO_SERVER}")
        sys.exit(1)

    print(f"Using MPY_BIN: {MPY_BIN}")
    print(f"Using DEMO_SERVER: {DEMO_SERVER}")
    print()

    all_passed, results = run_all_tests()

    print()
    print("=" * 70)
    print("Summary")
    print("=" * 70)
    passed_count = sum(1 for _, passed, _ in results if passed)
    total_count = len(results)
    print(f"Passed: {passed_count}/{total_count}")

    if not all_passed:
        print("\nFailed tests:")
        for name, passed, detail in results:
            if not passed:
                print(f"  - {name}")
                if detail:
                    print(f"    {detail}")

    return all_passed


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
