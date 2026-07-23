# mpyfastmcp — public API (P6 freeze review)

- Date: 2026-07-23
- Anchor: claude-net-mpy P6; sits on `mpyjsonrpc` (P4) + `mpyschema` (P5)
- Status: **PRE-FREEZE fixes applied.** The opus API-design review's
  defects and the `add_result_middleware` → `on_tool_result` rename have
  all been applied. Three open decisions (§3, Q3/Q5/Q6) remain reserved
  for Andrew before the surface is stamped frozen.
- Source under review: `src/plugin-mpy/lib/mpyfastmcp/__init__.py`
  (+ `demo_server.py`, `test_conformance.py`, `test_mpyfastmcp.py`).
- Conformance: 22/22 green on `test_conformance.py` (pytest,
  the primary conformance suite), 23/23 green on `test_mpyfastmcp.py`
  (standalone CPython harness, run with system `python3`), both against
  the `picolet-runtime-linux-x64-cli` binary.

---

## 1. What this layer is

`mpyfastmcp` is a FastMCP-style MCP server for MicroPython. It composes
the two lower reusable libs — it does **not** re-implement them:

- `mpyjsonrpc.JsonRpcPeer` — async newline-delimited JSON-RPC 2.0 stdio
  transport (framing, task-per-request dispatch, single serialized
  writer, EOF→shutdown).
- `mpyschema` — explicit `Str/Num/Bool` param specs → `inputSchema` /
  prompt-`arguments` emission + argument validation/coercion.

`mpyfastmcp` registers the five standard MCP methods (`initialize`,
`tools/list`, `tools/call`, `prompts/list`, `prompts/get`) on a peer and
exposes decorator-based registration on top. It is deliberately generic:
no app tool names, prompt names, or notification method names are baked
in. claude-net specifics (e.g. `notifications/claude/channel`) belong to
P7 and ride on the generic `notify()`.

---

## 2. Public API surface

### 2.1 Construction

```python
MCPServer(name, version, instructions=None, capabilities=None,
          stdin=None, stdout=None, log_prefix=None)
```

- `name`, `version` → `serverInfo` in the `initialize` result (both
  required positional).
- `instructions` → optional `initialize.instructions` string.
- `capabilities` → dict merged **over** the layer's computed default
  (`{"tools": {}}` once ≥1 tool is registered, `{"prompts": {}}` once ≥1
  prompt); caller keys win. Use it to declare `experimental` blocks.
- `stdin`/`stdout` → forwarded to the peer (default
  `sys.stdin.buffer`/`sys.stdout.buffer`).
- `log_prefix` → the peer's stderr log-line prefix; defaults to
  `"[%s] " % name`, so two servers with different names never share an
  indistinguishable log tag.
- `server.peer` → the underlying `JsonRpcPeer`, a documented public
  attribute (used for `log()`, and the escape hatch for registering MCP
  methods this layer doesn't cover).

### 2.2 Registration decorators

```python
@server.tool(name, description, params=None)      # params: list[mpyschema.Field] | None
def handler(**validated_arguments): ...

@server.prompt(name, description, arguments=None)  # arguments: list[mpyschema.Field] | None
def handler(**validated_arguments) -> {"description": ..., "messages": [...]}: ...
```

- `params`/`arguments` are `mpyschema` specs — ordered lists of `Field`
  instances (`Str`, `Num`, `Bool`). `None`/`[]` = zero-argument.
- Handler is called `handler(**validated)`; may be sync or `async def`.
- A validated dict **omits** any optional field the client didn't send
  and that has no spec `default`, so the handler must declare Python-side
  defaults for optional params (see `echo(message, shout=0)` in the demo).
- Tool return handling: see `tool_result()` below. Handler exceptions and
  `mpyschema` validation failures both surface as `isError` results, not
  JSON-RPC errors. Unknown tool name → `isError` result.
- Prompt: an unrecognised prompt `name`, or an argument that fails
  `mpyschema.validate()`, both raise `mpyjsonrpc.InvalidParams` (`-32602`)
  — prompts have no `isError` result convention of their own.
- Both decorators return the **undecorated** function (compose with other
  decorators).

### 2.3 mpyschema spec surface consumed by the decorators

```python
Str(name, desc=None, required=False, default=None)   # "type":"string"
Num(name, desc=None, required=False, default=None)   # "type":"number"
Bool(name, desc=None, required=False, default=None)  # "type":"boolean"
```

`emit_schema` / `emit_prompt_args` / `validate` are called internally;
consumers only build the `Field` list. Coercion is lenient (numeric
strings → `Num`, `"true"/"1"/"yes"` → `Bool`) to match real MCP clients.

### 2.4 Handshake introspection

```python
@server.on_initialized                 # callback() ; sync or async ; runs once
def cb(): ...

server.get_client_capabilities()  -> dict   # {} until initialize handled
server.get_client_info()          -> dict|None  # None until initialize handled
```

`on_initialized` fires when `notifications/initialized` arrives. Read the
two getters from inside it to see what the client declared. Each
registered callback is exception-isolated: one raising is logged via
`server.peer.log()` and does not prevent the others from running, the
same guarantee `on_shutdown` (below) already gave.

### 2.5 Result post-processing hook

```python
@server.on_tool_result
def cb(tool_name, result) -> result: ...
```

Runs in registration order on **every** outgoing `tools/call` result
(success and `isError`) before it is written. Must return the result dict
(mutate-in-place-and-return is the norm). The only opinion the layer
holds on result post-processing; what to queue/append is the app's call.
Does not run for `prompts/get` or `initialize`. A callback that only
wants to act on success must check `result.get("isError")` itself and
skip when it is set — the hook fires on error results too.

### 2.6 Notifications / lifecycle

```python
await server.notify(method, params=None)   # arbitrary server→client notification
@server.on_shutdown                          # callback() on stdin EOF (delegates to peer)
def cb(): ...
await server.serve()                         # coroutine: serve until EOF
server.run()                                 # blocking: asyncio.run(serve())
```

`serve()`/`run()` mirror `mpyjsonrpc.JsonRpcPeer.serve()`/`run()` exactly:
`serve()` is the coroutine (must be awaited or driven by `asyncio.run()`
to do anything), `run()` is the blocking convenience wrapper. `server.run()`
and `server.peer.run()` therefore behave identically — both block until
stdin EOF — so a caller who reaches for the peer-familiar bare
`server.run()` (no `await`) gets the running server, not a silently
no-op coroutine.

### 2.7 Lifecycle gating

`tools/list`, `tools/call`, `prompts/list`, and `prompts/get` are gated on
the MCP handshake: a client that calls any of them before `initialize` has
been handled gets `mpyfastmcp.NotInitialized` (`-32002`, this layer's
convention for "server not initialized") instead of being served.
`initialize` itself and `notifications/initialized` are never gated.

### 2.8 Module-level helpers

```python
tool_result(data)      # dict already shaped {"content":[...]} → passthrough;
                       # str → one text block; else json.dumps → one text block
error_result(message)  # {"isError": True, "content":[{"type":"text","text": message}]}
PROTOCOL_VERSIONS      # ("2025-06-18","2025-03-26","2024-11-05"), newest first
NotInitialized         # mpyjsonrpc.RpcError subclass, code -32002
```

`tool_result`'s dict-passthrough guard requires `content` to be a **list**
so a handler's own `{"content": "...", ...}` data dict is JSON-encoded
rather than mistaken for a pre-built result.

### 2.9 Minimal end-to-end example

```python
from mpyfastmcp import MCPServer
from mpyschema import Num, Str

server = MCPServer("acme", "1.0.0", instructions="Two tools and a prompt.")

@server.tool("add", "Add two numbers.",
             params=[Num("a", required=True), Num("b", required=True)])
def add(a, b):
    return {"sum": a + b}

@server.prompt("greet", "Greeting for `name`.",
               arguments=[Str("name", desc="Who to greet", required=True)])
def greet(name):
    return {"description": "Greet %s" % name,
            "messages": [{"role": "user",
                          "content": {"type": "text", "text": "Hi %s" % name}}]}

@server.on_initialized
async def _ready():
    await server.notify("notifications/acme/ready", {"caps": server.get_client_capabilities()})

if __name__ == "__main__":
    server.run()
```

### 2.10 Conventions summary

| Situation | Outcome |
|---|---|
| tool handler returns str | one text content block |
| tool handler returns dict w/ `content` list | passthrough |
| tool handler returns anything else | `json.dumps` into one text block |
| tool arg validation fails | `isError` result |
| tool handler raises | `isError` result |
| unknown tool name | `isError` result |
| unknown prompt name | JSON-RPC `-32602` |
| prompt argument validation fails | JSON-RPC `-32602` |
| non-lifecycle method called before `initialize` | JSON-RPC `-32002` |
| unknown JSON-RPC method | JSON-RPC `-32601` (peer default) |
| unknown `initialize.protocolVersion` | newest known echoed back |

---

## 3. Open questions for Andrew

Everything the opus API-design review flagged as a defect or a
clearly-recommended rename has been fixed (§2): the `run()`/`serve()`
collision, `on_initialized` exception isolation, the `prompts/get`
argument-validation error code, the `add_result_middleware` →
`on_tool_result` rename, lifecycle gating, and `log_prefix` derivation.
Three items remain genuine open decisions, unchanged by this pass:

**Q3 — `resources/*` first-classing.** MCP has tools, prompts, **and**
resources; `mpyfastmcp` covers tools + prompts only (matching the bun
plugin, which has none). A consumer wanting resources drops to
`server.peer.register_method("resources/list", ...)` and hand-maintains
the `capabilities` dict. Decision needed: is tools+prompts the frozen
scope with `server.peer` as the documented extension path, or do
resources get a first-class stub now?

**Q5 — parity formatting vs the bun plugin.** `tool_result` emits
**compact** `json.dumps(data)`; bun's `toolResult` emits pretty-printed
`JSON.stringify(data, null, 2)`. `error_result(msg)` emits `msg` verbatim;
bun's `notConnectedError` prefixes `"Error: "`. Compact + verbatim are the
right generic defaults, but P7 will re-wrap if it wants byte-parity with
current bun output — worth an explicit "intentionally not matching bun's
formatting" decision so it isn't mistaken for a bug during P7 integration.

**Q6 — empty-sentinel convention and getter shape.**
`get_client_capabilities()` returns `{}` before `initialize`;
`get_client_info()` returns `None`. Pick one convention (both `None`, or
both empty-dict/`{}`). Separately, `get_client_*()` are snake-cased
carryovers of the SDK's `getClientCapabilities()`; idiomatic Python would
be properties, though getters are defensible since the value changes
across the lifecycle. Low priority, but decide once, since it's frozen
after this.

Two smaller, non-blocking items noted for completeness, not requiring a
decision before freeze: the split default-handling footgun (an optional
param's default lives in the spec's `default=` *or* the handler
signature — root cause is in `mpyschema`, surfaced through `@tool`), and
the `MCPServer` class name / required `version` vs the `fastmcp` package's
`FastMCP(name)` convention (a `FastMCP = MCPServer` alias + a defaulted
`version` would soften the landing, but is optional).

---

## 4. Recommendation

Core shape is sound and conformance-green (22/22 pytest, 23/23 standalone
harness). With the `run()`/`serve()` fix, the `on_tool_result` rename,
`on_initialized` isolation, the `prompts/get` `-32602` fix, and lifecycle
gating all applied, the remaining decisions are Q3 (resources scope), Q5
(parity-formatting intent), and Q6 (sentinel/getter convention) — all
non-urgent, all cheap to decide later without breaking callers who only
use the surface documented in §2. Freeze once Q3/Q5/Q6 are resolved.
