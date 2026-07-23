"""mpyfastmcp: a FastMCP-style MCP server layer over mpyjsonrpc + mpyschema.

Composes `mpyjsonrpc.JsonRpcPeer` (transport: framing, dispatch, the single
serialized stdout writer) with `mpyschema` (explicit param specs ->
`inputSchema` / prompt `arguments`, plus argument validation) into an
`MCPServer` object that speaks the Model Context Protocol's `initialize`,
`tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`,
and `resources/read` methods.

This module is deliberately generic: it has no knowledge of any specific
app's tools, prompts, or notification method names. An app built on top of
it (see `demo_server.py` for a worked example) supplies its own tool/prompt
handlers and its own notification method names via `server.notify(...)`.

Public API
----------

``MCPServer(name, version, instructions=None, capabilities=None, stdin=None, stdout=None, log_prefix=None)``
    Constructs the server. `name`/`version` populate the `serverInfo` object
    of the `initialize` result; `instructions` (if given) becomes the
    result's `instructions` string. `capabilities` is merged over the
    layer's own default (`{"tools": {}}` once at least one tool is
    registered, `{"prompts": {}}` once at least one prompt is registered,
    `{"resources": {}}` once at least one resource is registered) — pass
    e.g. `capabilities={"experimental": {"foo": {}}}` to declare additional
    capability blocks; keys here always win over the computed default.
    `stdin`/`stdout` are forwarded to the underlying
    `mpyjsonrpc.JsonRpcPeer` (default `sys.stdin.buffer` / `sys.stdout.buffer`).
    `log_prefix` sets the peer's stderr log prefix; defaults to `"[%s] " %
    name`, so two servers with different names never share an indistinguishable
    log tag. The peer instance is available as `server.peer` for direct
    access to `log()` or other transport-level primitives.

``@server.tool(name, description, params=None)``
    Registers a tool. `params` is an `mpyschema` spec (a list of `Field`
    instances, or `None`/`[]` for a zero-argument tool); it drives both the
    `inputSchema` emitted from `tools/list` and the argument validation run
    before the decorated handler is called on `tools/call`. The handler is
    called as `handler(**validated_arguments)` — a plain function or an
    `async def`; declare defaults for any optional (non-required,
    default-less) parameters the handler wants to accept, since a validated
    dict omits a key entirely when the client didn't send it and the field
    has no `default`. The handler's return value becomes the tool result
    via `tool_result()` (see below) unless it already returns a
    `{"content": [...]}`-shaped dict, which is passed through unchanged. A
    `ValueError`/`TypeError` raised by `mpyschema.validate()` (bad
    arguments) or any exception raised by the handler itself both surface
    as an `isError` result (via `error_result()`), never as a JSON-RPC
    protocol error — matching the MCP convention that a tool call reaching
    its handler is a "successful" JSON-RPC exchange even when the tool
    itself failed. An unrecognised `name` at `tools/call` time likewise
    produces an `isError` result rather than `-32601`, since the `name` is
    a `tools/call` argument, not the JSON-RPC method. Returns the
    undecorated handler, so `@server.tool(...)` composes with other
    decorators.

``@server.prompt(name, description, arguments=None)``
    Registers a prompt. `arguments` is an `mpyschema` spec (only `desc`/
    `required` are used — prompt arguments carry no JSON type). The
    decorated handler is called as `handler(**validated_arguments)` on
    `prompts/get` and must return `{"description": ..., "messages": [...]}`
    (the shape `prompts/get` sends back verbatim). An unrecognised prompt
    `name`, or an argument that fails `mpyschema.validate()` (missing
    required argument, wrong type), both raise `mpyjsonrpc.InvalidParams`,
    a real JSON-RPC error (`-32602`) — unlike `tools/call`, MCP's
    `prompts/get` has no `isError` result convention of its own. Returns
    the undecorated handler.

``@server.resource(uri, name, description=None, mime_type=None)``
    Registers a resource. `uri` is the resource's stable identifier and
    registry key; `name` is the human-readable label. `description` and
    `mime_type` are optional and, when given, surface as `description` /
    `mimeType` in `resources/list` (omitted entirely when absent, rather
    than emitted as `null`). The decorated handler takes no arguments and
    is called on `resources/read` for its `uri`; it may be a plain function
    or an `async def`. Its return value becomes the `resources/read`
    result via `resource_result()` (see below) unless it already returns a
    `{"contents": [...]}`-shaped dict, which is passed through unchanged.
    An unrecognised `uri` at `resources/read` time raises
    `mpyjsonrpc.InvalidParams` (`-32602`), matching `prompts/get`'s
    unknown-name handling -- resources have no `tools/call`-style `isError`
    result convention. Returns the undecorated handler, so
    `@server.resource(...)` composes with other decorators.

``server.on_initialized(callback)``
    Registers `callback()` to run once, when the client's
    `notifications/initialized` notification arrives (i.e. once the MCP
    handshake has completed). `callback` may be a plain function or an
    `async def`. Call `server.get_client_capabilities()` /
    `server.get_client_info()` from inside `callback` to read what the
    client declared in its `initialize` request. Each registered callback
    is isolated: one raising does not prevent the others from running (the
    exception is logged via `server.peer.log()` and swallowed), matching
    `on_shutdown`'s isolation below. Returns `callback`.

``server.get_client_capabilities()`` / ``server.get_client_info()``
    Return the `capabilities` / `clientInfo` objects the client sent with
    `initialize`. Both return `None` until `initialize` has been handled --
    a shared sentinel for "not yet known", distinct from the client having
    sent an empty `capabilities: {}`.

``server.on_tool_result(callback)``
    Registers `callback(tool_name, result)` to run, in registration order,
    on every outgoing `tools/call` result (`result` is the
    `{"content": [...], "isError": ...}` dict about to be sent back) before
    it is written to stdout. **Fires on both success and `isError` results**
    — a callback that only cares about successful calls must check
    `result.get("isError")` itself and skip when it is set. Each callback
    must return the (possibly mutated in place, possibly replaced) result
    dict; the most common shape appends one or more content blocks to
    `result["content"]`, e.g. how an app might drain a queue of pending
    out-of-band notices into the next tool result rather than losing them.
    This is the layer's only opinion on result post-processing — what gets
    queued and when is entirely up to the app. Does not run for
    `prompts/get` or `initialize`. Returns `callback`.

``await server.notify(method, params=None)``
    Sends an arbitrary server-to-client notification (no `id`, so the
    client never replies) via the underlying peer. `method` is entirely
    caller-supplied — this layer does not hard-code any notification
    method name.

``server.on_shutdown(callback)``
    Delegates to `mpyjsonrpc.JsonRpcPeer.on_shutdown` — registers
    `callback` (plain function or `async def`) to run once, on stdin EOF.
    Returns `callback`.

``await server.serve()``
    The coroutine form: serves requests until stdin EOF, a thin wrapper
    over `JsonRpcPeer.serve()`. Use this when the caller already has its
    own event loop running (composing this server with other `asyncio`
    tasks). See `mpyjsonrpc` for the framing, dispatch, and concurrency
    contracts this relies on (task-per-request dispatch, a single
    serialized stdout writer so a `notify()` fired mid-request can never
    corrupt another response's framing, EOF -> shutdown-callback
    behaviour).

``server.run()``
    The blocking convenience entry point: `asyncio.run(self.serve())`.
    Mirrors `JsonRpcPeer.run()`/`JsonRpcPeer.serve()` exactly, so
    `server.run()` and `server.peer.run()` (both blocking) behave the same
    way — a caller who reaches for the peer-familiar bare `server.run()`
    (no `await`) gets the running server, not a silently-discarded
    coroutine.

``tool_result(data)``
    Module-level helper: wraps arbitrary tool-handler return data as an MCP
    `tools/call` result. A dict already shaped like `{"content": [...]}` is
    returned unchanged (a handler that wants full control — multiple
    content blocks, a non-text content type, an explicit `isError` — can
    just build the result itself and return it). A `str` becomes a single
    text content block verbatim. Anything else is JSON-encoded into a
    single text content block.

``error_result(message)``
    Module-level helper: builds `{"isError": True, "content":
    [{"type": "text", "text": message}]}` — the generic form of "this tool
    call did not succeed", used automatically for validation failures,
    handler exceptions, and unknown tool names, and available for a
    handler to return directly for its own domain-specific failures.

``resource_result(uri, data, mime_type=None)``
    Module-level helper: wraps arbitrary resource-handler return data as an
    MCP `resources/read` result. A dict already shaped like `{"contents":
    [...]}` is returned unchanged. A `list` is used directly as the
    `contents` array (each item already a content block the handler built
    itself). A `str` becomes a single text content block for `uri` (tagged
    with `mime_type` when given). Anything else is JSON-encoded into a
    single text content block for `uri`.

Standard MCP method coverage
-----------------------------

`initialize`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`,
`resources/list`, and `resources/read` are registered as `mpyjsonrpc`
method handlers at construction time. Any other inbound method falls
through to `mpyjsonrpc`'s own "no handler registered" path and is reported
as JSON-RPC `-32601` (`MethodNotFound`), exactly as for any unregistered
method on a bare `JsonRpcPeer`.

`tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`,
and `resources/read` are gated on the MCP lifecycle: a client that calls
any of them before `initialize` has been handled gets `NotInitialized`
(`-32002`, this layer's convention for "server not initialized") instead
of being served. `initialize` itself and `notifications/initialized` are
never gated.

`initialize` handshake / protocol version negotiation
-------------------------------------------------------

`initialize`'s `protocolVersion` is negotiated the way the MCP spec (and
the observed behaviour of at least one popular SDK) does it: if the
client's requested version is one this layer knows about
(`PROTOCOL_VERSIONS`, newest first), it is echoed back verbatim; otherwise
the newest known version is returned instead of failing the handshake.
Capabilities and `clientInfo` from the request are captured for
`get_client_capabilities()`/`get_client_info()`, and `serverInfo` /
`capabilities` (and `instructions`, if given) are returned per the spec's
`initialize` result shape. `notifications/initialized` (the client's
handshake-complete notification) fires the `on_initialized()` callbacks.
"""

import asyncio
import json

from mpyjsonrpc import InvalidParams, JsonRpcPeer, RpcError
from mpyschema import emit_prompt_args, emit_schema, validate


# Newest first. A client's requested `protocolVersion` is echoed back
# verbatim when it appears here; otherwise the handshake falls back to the
# newest version this layer knows, rather than failing outright — the
# behaviour observed from popular MCP client/server SDKs when negotiating
# with an unfamiliar version.
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")


class NotInitialized(RpcError):
    """A lifecycle-gated method (`tools/list`, `tools/call`, `prompts/list`,
    `prompts/get`, `resources/list`, `resources/read`) was called before
    `initialize` completed (-32002, this layer's convention for the MCP
    "server not initialized" condition)."""

    code = -32002


def tool_result(data):
    """Wrap arbitrary tool-handler return data as an MCP `tools/call` result.

    A dict is passed through unchanged only when it is already shaped like
    a result -- `content` present as a *list* (the content-block array) --
    so a handler's own data dict that merely happens to have a `content`
    key (e.g. `{"content": "file text", "path": "/x"}`) is not mistaken for
    a pre-built result. A `str` becomes a single text content block
    verbatim. Anything else, including such a dict, is JSON-encoded into a
    single text content block.
    """
    if isinstance(data, dict) and isinstance(data.get("content"), list):
        return data
    text = data if isinstance(data, str) else json.dumps(data)
    return {"content": [{"type": "text", "text": text}]}


def error_result(message):
    """Build an `isError` MCP `tools/call` result carrying `message` as text."""
    return {"isError": True, "content": [{"type": "text", "text": message}]}


def resource_result(uri, data, mime_type=None):
    """Wrap arbitrary resource-handler return data as an MCP
    `resources/read` result.

    A dict is passed through unchanged only when it is already shaped like
    a result -- `contents` present as a *list* (the content-block array).
    A bare `list` is used directly as that `contents` array (each item
    already a content block the handler built itself). A `str` becomes a
    single text content block for `uri`, tagged with `mime_type` when
    given. Anything else is JSON-encoded into a single text content block
    for `uri`.
    """
    if isinstance(data, dict) and isinstance(data.get("contents"), list):
        return data
    if isinstance(data, list):
        return {"contents": data}
    block = {"uri": uri}
    if mime_type:
        block["mimeType"] = mime_type
    block["text"] = data if isinstance(data, str) else json.dumps(data)
    return {"contents": [block]}


class _Tool:
    __slots__ = ("name", "description", "params", "handler", "input_schema")

    def __init__(self, name, description, params, handler):
        self.name = name
        self.description = description
        self.params = params or []
        self.handler = handler
        self.input_schema = emit_schema(self.params)

    def definition(self):
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


class _Prompt:
    __slots__ = ("name", "description", "arguments", "handler")

    def __init__(self, name, description, arguments, handler):
        self.name = name
        self.description = description
        self.arguments = arguments or []
        self.handler = handler

    def definition(self):
        return {
            "name": self.name,
            "description": self.description,
            "arguments": emit_prompt_args(self.arguments),
        }


class _Resource:
    __slots__ = ("uri", "name", "description", "mime_type", "handler")

    def __init__(self, uri, name, description, mime_type, handler):
        self.uri = uri
        self.name = name
        self.description = description
        self.mime_type = mime_type
        self.handler = handler

    def definition(self):
        d = {"uri": self.uri, "name": self.name}
        if self.description:
            d["description"] = self.description
        if self.mime_type:
            d["mimeType"] = self.mime_type
        return d


class MCPServer:
    """A FastMCP-style MCP server: `@tool`/`@prompt`/`@resource` decorators
    over `mpyjsonrpc.JsonRpcPeer`. See the module docstring for the full public
    API.
    """

    def __init__(
        self,
        name,
        version,
        instructions=None,
        capabilities=None,
        stdin=None,
        stdout=None,
        log_prefix=None,
    ):
        self._name = name
        self._version = version
        self._instructions = instructions
        self._capabilities = capabilities or {}

        # Plain dicts on MicroPython don't preserve insertion order (see
        # mpyschema's docstring) -- registration order for `tools/list` /
        # `prompts/list` / `resources/list` is tracked separately via the
        # `_order` lists rather than relying on dict iteration order.
        self._tools = {}
        self._tool_order = []
        self._prompts = {}
        self._prompt_order = []
        self._resources = {}
        self._resource_order = []

        self._tool_result_cbs = []
        self._oninitialized_cbs = []
        # `None` is the shared "not yet known" sentinel for both, distinct
        # from the client having sent an empty `capabilities: {}` -- see
        # `get_client_capabilities()`/`get_client_info()`.
        self._client_capabilities = None
        self._client_info = None
        self._initialized = False

        if log_prefix is None:
            log_prefix = "[%s] " % name
        self.peer = JsonRpcPeer(stdin=stdin, stdout=stdout, log_prefix=log_prefix)
        self.peer.register_method("initialize", self._handle_initialize)
        self.peer.register_method(
            "notifications/initialized", self._handle_initialized
        )
        self.peer.register_method("tools/list", self._handle_tools_list)
        self.peer.register_method("tools/call", self._handle_tools_call)
        self.peer.register_method("prompts/list", self._handle_prompts_list)
        self.peer.register_method("prompts/get", self._handle_prompts_get)
        self.peer.register_method("resources/list", self._handle_resources_list)
        self.peer.register_method("resources/read", self._handle_resources_read)

    # ── Registration decorators ─────────────────────────────────────────

    def tool(self, name, description, params=None):
        """Decorator: `@server.tool("name", "description", params=[...])`."""

        def decorator(fn):
            t = _Tool(name, description, params, fn)
            self._tools[name] = t
            if name not in self._tool_order:
                self._tool_order.append(name)
            return fn

        return decorator

    def resource(self, uri, name, description=None, mime_type=None):
        """Decorator: `@server.resource("uri", "name", description=None,
        mime_type=None)`."""

        def decorator(fn):
            r = _Resource(uri, name, description, mime_type, fn)
            self._resources[uri] = r
            if uri not in self._resource_order:
                self._resource_order.append(uri)
            return fn

        return decorator

    def prompt(self, name, description, arguments=None):
        """Decorator: `@server.prompt("name", "description", arguments=[...])`."""

        def decorator(fn):
            p = _Prompt(name, description, arguments, fn)
            self._prompts[name] = p
            if name not in self._prompt_order:
                self._prompt_order.append(name)
            return fn

        return decorator

    # ── Handshake ────────────────────────────────────────────────────────

    def on_initialized(self, callback):
        """Register `callback()` to run once `notifications/initialized`
        arrives. Returns `callback`."""
        self._oninitialized_cbs.append(callback)
        return callback

    def get_client_capabilities(self):
        """Return the `capabilities` object from the client's `initialize`
        request, or `None` if `initialize` hasn't been handled yet -- the
        same "not yet known" sentinel `get_client_info()` uses, distinct
        from the client having sent an empty `capabilities: {}`."""
        return self._client_capabilities

    def get_client_info(self):
        """Return the `clientInfo` object from the client's `initialize`
        request, or `None` if `initialize` hasn't been handled yet."""
        return self._client_info

    def _effective_capabilities(self):
        caps = {}
        if self._tool_order:
            caps["tools"] = {}
        if self._prompt_order:
            caps["prompts"] = {}
        if self._resource_order:
            caps["resources"] = {}
        caps.update(self._capabilities)
        return caps

    async def _handle_initialize(self, **params):
        # `**params` (rather than a fixed `protocolVersion`/`capabilities`/
        # `clientInfo` signature) tolerates a client that sends additional
        # `initialize` properties the spec allows but this layer doesn't
        # otherwise use -- a fixed signature would reject those as an
        # mpyjsonrpc `InvalidParams` binding failure.
        requested = params.get("protocolVersion")
        self._client_capabilities = params.get("capabilities") or {}
        self._client_info = params.get("clientInfo")
        negotiated = (
            requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        )
        result = {
            "protocolVersion": negotiated,
            "capabilities": self._effective_capabilities(),
            "serverInfo": {"name": self._name, "version": self._version},
        }
        if self._instructions:
            result["instructions"] = self._instructions
        self._initialized = True
        return result

    def _require_initialized(self):
        """Raise `NotInitialized` unless `initialize` has already been
        handled. Called by every lifecycle-gated method (`tools/list`,
        `tools/call`, `prompts/list`, `prompts/get`) -- never by
        `initialize` itself or by the `notifications/initialized` handler."""
        if not self._initialized:
            raise NotInitialized(
                "server not initialized: call initialize first"
            )

    async def _handle_initialized(self, **_params):
        for cb in self._oninitialized_cbs:
            try:
                result = cb()
                if type(result).__name__ == "generator":
                    await result
            except Exception as exc:
                self.peer.log("on_initialized callback failed: %s" % exc)

    # ── Tools ────────────────────────────────────────────────────────────

    async def _handle_tools_list(self, **_params):
        self._require_initialized()
        return {"tools": [self._tools[n].definition() for n in self._tool_order]}

    async def _handle_tools_call(self, name, arguments=None):
        self._require_initialized()
        tool = self._tools.get(name)
        if tool is None:
            return self._finalize_result(
                name, error_result("Unknown tool: %s" % name)
            )

        try:
            validated = validate(tool.params, arguments)
        except (ValueError, TypeError) as exc:
            return self._finalize_result(name, error_result(str(exc)))

        try:
            raw = tool.handler(**validated)
            if type(raw).__name__ == "generator":
                raw = await raw
        except Exception as exc:
            return self._finalize_result(name, error_result(str(exc)))

        return self._finalize_result(name, tool_result(raw))

    def on_tool_result(self, callback):
        """Register `callback(tool_name, result)` to run, in registration
        order, on every outgoing `tools/call` result before it is sent --
        for both success and `isError` results; a callback that only wants
        to act on success should check `result.get("isError")` itself and
        skip when it is set. `callback` must return the (possibly mutated)
        result dict. Returns `callback`."""
        self._tool_result_cbs.append(callback)
        return callback

    def _finalize_result(self, tool_name, result):
        for cb in self._tool_result_cbs:
            result = cb(tool_name, result)
        return result

    # ── Prompts ──────────────────────────────────────────────────────────

    async def _handle_prompts_list(self, **_params):
        self._require_initialized()
        return {
            "prompts": [self._prompts[n].definition() for n in self._prompt_order]
        }

    async def _handle_prompts_get(self, name, arguments=None):
        self._require_initialized()
        prompt = self._prompts.get(name)
        if prompt is None:
            raise InvalidParams("unknown prompt: %s" % name)
        try:
            validated = validate(prompt.arguments, arguments)
        except (ValueError, TypeError) as exc:
            raise InvalidParams(str(exc))
        result = prompt.handler(**validated)
        if type(result).__name__ == "generator":
            result = await result
        return result

    # ── Resources ────────────────────────────────────────────────────────

    async def _handle_resources_list(self, **_params):
        self._require_initialized()
        return {
            "resources": [
                self._resources[u].definition() for u in self._resource_order
            ]
        }

    async def _handle_resources_read(self, uri):
        self._require_initialized()
        resource = self._resources.get(uri)
        if resource is None:
            raise InvalidParams("unknown resource: %s" % uri)
        raw = resource.handler()
        if type(raw).__name__ == "generator":
            raw = await raw
        return resource_result(uri, raw, resource.mime_type)

    # ── Notifications / lifecycle ───────────────────────────────────────

    async def notify(self, method, params=None):
        """Send an arbitrary server->client notification. `method` is
        entirely caller-supplied."""
        await self.peer.notify(method, params)

    def on_shutdown(self, callback):
        """Delegates to `JsonRpcPeer.on_shutdown`. Returns `callback`."""
        return self.peer.on_shutdown(callback)

    async def serve(self):
        """Serve MCP requests until stdin EOF. The coroutine form; thin
        wrapper over `JsonRpcPeer.serve()`. Use this directly if the
        caller already has its own event loop running (e.g. is composing
        this server with other `asyncio` tasks); otherwise use the
        blocking `run()`."""
        await self.peer.serve()

    def run(self):
        """Blocking convenience entry point: `asyncio.run(self.serve())`.
        Mirrors `JsonRpcPeer.run()`/`JsonRpcPeer.serve()` exactly, so
        `server.run()` and `server.peer.run()` behave the same way (both
        block until stdin EOF) rather than one being a bare coroutine that
        silently does nothing if called without `await`."""
        asyncio.run(self.serve())
