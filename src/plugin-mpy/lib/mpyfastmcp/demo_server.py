"""Minimal example `mpyfastmcp` server: two tools and a prompt.

Runnable directly on the picolet MicroPython binary:

    picolet-runtime-linux-x64-cli demo_server.py

Speaks MCP over stdio (real `sys.stdin`/`sys.stdout`) — feed it JSON-RPC
lines (`initialize`, `notifications/initialized`, `tools/list`,
`tools/call`, `prompts/list`, `prompts/get`) and read the responses back.
See `test_conformance.py` in this directory for a scripted client driving
this exact server.

Demonstrates: two tools (`echo`, `add`) exercising `mpyschema.Str`/`Num`
params and validation-error/handler-exception paths; one prompt (`greet`);
`on_initialized` reading the client's declared capabilities; an
`on_tool_result` hook that appends a one-shot notice to the next tool
result; and a `notify()` custom notification fired once initialization
completes.
"""

import os
import sys

_LIB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _LIB_DIR not in sys.path:
    sys.path.insert(0, _LIB_DIR)

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


# One-shot "pending notice" queue, drained into the next tool result by the
# on_tool_result hook below -- the generic hook the P7 app's nudge-drain
# behaviour is built on.
_pending_notices = []


@server.on_tool_result
def _drain_pending_notices(_tool_name, result):
    for text in _pending_notices:
        result["content"].append({"type": "text", "text": text})
    _pending_notices.clear()
    return result


@server.on_initialized
async def _on_initialized():
    server.peer.log("client capabilities: %r" % (server.get_client_capabilities(),))
    _pending_notices.append("demo server says hello")
    await server.notify("notifications/demo/ready", {"ok": True})


if __name__ == "__main__":
    server.run()
