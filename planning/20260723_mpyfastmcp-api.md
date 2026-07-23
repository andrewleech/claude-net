# mpyfastmcp — public API (P6 freeze review)

- Date: 2026-07-23
- Anchor: claude-net-mpy P6; sits on `mpyjsonrpc` (P4) + `mpyschema` (P5)
- Status: **FROZEN.** All three open decisions (§3, Q3/Q5/Q6) are
  resolved: resources are first-class (Q3), `tool_result`/`error_result`
  formatting stays compact/verbatim (Q5), and both client-info getters
  share a `None` "not yet known" sentinel pre-`initialize` (Q6).
- Source under review: `src/plugin-mpy/lib/mpyfastmcp/__init__.py`
  (+ `demo_server.py`, `test_conformance.py`, `test_mpyfastmcp.py`).
- Conformance: 28/28 green on `test_conformance.py` (pytest,
  the primary conformance suite), 29/29 green on `test_mpyfastmcp.py`
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

`mpyfastmcp` registers the seven standard MCP methods (`initialize`,
`tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`,
`resources/read`) on a peer and exposes decorator-based registration on
top. It is deliberately generic: no app tool names, prompt names,
resource URIs, or notification method names are baked in. claude-net
specifics (e.g. `notifications/claude/channel`) belong to P7 and ride on
the generic `notify()`.

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
  prompt, `{"resources": {}}` once ≥1 resource); caller keys win. Use it
  to declare `experimental` blocks.
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

@server.resource(uri, name, description=None, mime_type=None)
def handler() -> str | {"contents": [...]} | list: ...
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
- Resource: `uri` is the stable identifier and registry key; `name` is
  the human-readable label; `description`/`mime_type` are optional and,
  when given, surface as `description`/`mimeType` in `resources/list`
  (omitted, not `null`, when absent). The handler takes no arguments and
  is called on `resources/read` for its `uri`. Return handling: see
  `resource_result()` below. An unrecognised `uri` raises
  `mpyjsonrpc.InvalidParams` (`-32602`), matching `prompts/get` — like
  prompts, resources have no `isError` result convention of their own.
- All three decorators return the **undecorated** function (compose with
  other decorators).

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

server.get_client_capabilities()  -> dict|None  # None until initialize handled
server.get_client_info()          -> dict|None  # None until initialize handled
```

Both getters share `None` as the "not yet known" sentinel before
`initialize` (Q6, decided): the client having sent an empty
`capabilities: {}` is distinguishable from `initialize` not having
happened yet.

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

`tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`,
and `resources/read` are gated on the MCP handshake: a client that calls
any of them before `initialize` has been handled gets
`mpyfastmcp.NotInitialized` (`-32002`, this layer's convention for "server
not initialized") instead of being served. `initialize` itself and
`notifications/initialized` are never gated.

### 2.8 Module-level helpers

```python
tool_result(data)      # dict already shaped {"content":[...]} → passthrough;
                       # str → one text block; else json.dumps → one text block
error_result(message)  # {"isError": True, "content":[{"type":"text","text": message}]}
resource_result(uri, data, mime_type=None)
                       # dict already shaped {"contents":[...]} → passthrough;
                       # list → used directly as the contents array;
                       # str → one text block for uri; else json.dumps → one text block
PROTOCOL_VERSIONS      # ("2025-06-18","2025-03-26","2024-11-05"), newest first
NotInitialized         # mpyjsonrpc.RpcError subclass, code -32002
```

`tool_result`'s dict-passthrough guard requires `content` to be a **list**
so a handler's own `{"content": "...", ...}` data dict is JSON-encoded
rather than mistaken for a pre-built result. `resource_result` applies the
same guard to `contents`.

Formatting decision (Q5, decided): both `tool_result` and `resource_result`
emit compact `json.dumps` (not pretty-printed), and `error_result` emits
its message verbatim (no `"Error: "` prefix) — intentionally not matching
the bun plugin's `JSON.stringify(data, null, 2)` / prefixed error text. A
consumer wanting byte-parity with bun's current output re-wraps at the P7
integration layer.

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

@server.resource("resource://acme/readme", "README", mime_type="text/plain")
def readme():
    return "acme server: two tools, a prompt, and this resource."

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
| resource handler returns str | one text content block for its `uri` |
| resource handler returns dict w/ `contents` list | passthrough |
| resource handler returns list | used directly as the `contents` array |
| resource handler returns anything else | `json.dumps` into one text block |
| unknown resource `uri` | JSON-RPC `-32602` |
| non-lifecycle method called before `initialize` | JSON-RPC `-32002` |
| unknown JSON-RPC method | JSON-RPC `-32601` (peer default) |
| unknown `initialize.protocolVersion` | newest known echoed back |

---

## 3. Decisions (all closed)

Everything the opus API-design review flagged as a defect or a
clearly-recommended rename was fixed in the pre-freeze pass (§2): the
`run()`/`serve()` collision, `on_initialized` exception isolation, the
`prompts/get` argument-validation error code, the `add_result_middleware`
→ `on_tool_result` rename, lifecycle gating, and `log_prefix` derivation.
The three remaining open decisions are now resolved:

**Q3 — `resources/*` first-classing. DECIDED: first-class (Andrew).**
`mpyfastmcp` now covers tools + prompts + resources: `@server.resource`,
`resources/list`, `resources/read`, `resource_result()`, and the
`{"resources": {}}` capability (advertised once ≥1 resource is
registered) round out the surface. `server.peer` remains the documented
escape hatch for any MCP method this layer still doesn't cover.

**Q5 — parity formatting vs the bun plugin. DECIDED: keep compact/verbatim
(Andrew).** `tool_result`/`resource_result` keep emitting **compact**
`json.dumps(data)` (not bun's pretty-printed
`JSON.stringify(data, null, 2)`); `error_result(msg)` keeps emitting `msg`
verbatim (not bun's `"Error: "`-prefixed form). This is an intentional
divergence from the bun plugin's current formatting, not a bug — P7
re-wraps at the integration layer if byte-parity with bun's output is
ever needed.

**Q6 — empty-sentinel convention and getter shape. DECIDED: both `None`
pre-`initialize` (Andrew's default).** `get_client_capabilities()` and
`get_client_info()` both return `None` until `initialize` has been
handled, and both return the captured value (the `capabilities` dict, the
`clientInfo` object) afterward — a single shared "not yet known" sentinel
that can't be confused with a client-sent empty `capabilities: {}`. The
getter-vs-property shape is left as-is (getters), since the value
genuinely changes across the lifecycle.

Two smaller, non-blocking items noted for completeness, not requiring a
decision before freeze: the split default-handling footgun (an optional
param's default lives in the spec's `default=` *or* the handler
signature — root cause is in `mpyschema`, surfaced through `@tool`), and
the `MCPServer` class name / required `version` vs the `fastmcp` package's
`FastMCP(name)` convention (a `FastMCP = MCPServer` alias + a defaulted
`version` would soften the landing, but is optional).

---

## 4. Recommendation

Core shape is sound and conformance-green (28/28 pytest, 29/29 standalone
harness, both suites extended to cover resources). With the
`run()`/`serve()` fix, the `on_tool_result` rename, `on_initialized`
isolation, the `prompts/get` `-32602` fix, lifecycle gating, and the Q3/
Q5/Q6 decisions all applied, the public surface documented in §2 is
frozen.
