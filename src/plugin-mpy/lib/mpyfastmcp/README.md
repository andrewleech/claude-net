# mpyfastmcp

FastMCP-style MCP-server layer for MicroPython, composing `mpyjsonrpc`
(transport) and `mpyschema` (param specs / schema emission / validation)
into an `MCPServer` object with `@tool` / `@prompt` / `@resource`
decorators.

Generic by design: this layer has no knowledge of any specific app's tools,
prompts, or notification method names. See `demo_server.py` for a worked
example and `test_conformance.py` for a scripted MCP client driving it.

## Minimal example

```python
from mpyfastmcp import MCPServer
from mpyschema import Num, Str

server = MCPServer(
    name="mpyfastmcp-demo",
    version="0.1.0",
    instructions="A minimal demo server: `echo` and `add` tools, a `greet` prompt.",
)


@server.tool(
    "echo",
    "Echo `message` back, optionally uppercased.",
    params=[
        Str("message", desc="Text to echo back", required=True),
        Num("shout", desc="Non-zero to uppercase the echoed text"),
    ],
)
def echo(message, shout=0):
    return message.upper() if shout else message


@server.tool(
    "add",
    "Add two numbers.",
    params=[
        Num("a", desc="First addend", required=True),
        Num("b", desc="Second addend", required=True),
    ],
)
def add(a, b):
    return {"sum": a + b}


@server.prompt(
    "greet",
    "Produce a greeting message for `name`.",
    arguments=[Str("name", desc="Who to greet", required=True)],
)
def greet(name):
    return {
        "description": "Greet %s" % name,
        "messages": [
            {
                "role": "user",
                "content": {"type": "text", "text": "Say hello to %s." % name},
            }
        ],
    }


@server.resource(
    "resource://demo/notes",
    "Demo Notes",
    description="A short, static, read-only note resource.",
    mime_type="text/plain",
)
def notes():
    return "This is a static demo resource exposed by mpyfastmcp."


# on_tool_result: appends content blocks to an outgoing tools/call result
# before it is written to stdout, in registration order. This is the generic
# hook an app uses to drain its own queue of pending out-of-band notices into
# the next tool result.
_pending_notices = []


@server.on_tool_result
def _drain_pending_notices(_tool_name, result):
    for text in _pending_notices:
        result["content"].append({"type": "text", "text": text})
    _pending_notices.clear()
    return result


# Fires once, when the client's `notifications/initialized` arrives. Reads
# what the client declared in its `initialize` request, and can send
# server -> client notifications under any method name the app chooses --
# this layer does not hard-code one.
@server.on_initialized
async def _on_initialized():
    server.peer.log("client capabilities: %r" % (server.get_client_capabilities(),))
    _pending_notices.append("demo server says hello")
    await server.notify("notifications/demo/ready", {"ok": True})


if __name__ == "__main__":
    server.run()
```

The full runnable version of this example is `demo_server.py` in this
directory. Run it directly on a picolet MicroPython binary that includes
`json`/`asyncio` (the `mcp` variant, or the `cli` variant used for dev
iteration):

```
picolet-runtime-linux-x64-mcp demo_server.py
```

It speaks MCP over stdio: feed it JSON-RPC lines (`initialize`,
`notifications/initialized`, `tools/list`, `tools/call`, `prompts/list`,
`prompts/get`, `resources/list`, `resources/read`) on stdin and read the
responses back from stdout. `test_conformance.py` in this directory is a
scripted client that drives this exact server through the full handshake
plus every method above; run it with:

```
MPY_BIN=/path/to/picolet-runtime-linux-x64-mcp python3 -m pytest test_conformance.py
```

## Public API

See the `mpyfastmcp/__init__.py` module docstring for the full reference:
`MCPServer` construction, `@server.tool`/`@server.prompt`/`@server.resource`,
`on_initialized`/`get_client_capabilities`/`get_client_info`,
`on_tool_result`, `notify`, `on_shutdown`, `serve`/`run`, and the
`tool_result`/`error_result`/`resource_result` helpers. This is the
project's designated reuse surface for P7 (the claude-net plugin) and is
frozen after API review.
