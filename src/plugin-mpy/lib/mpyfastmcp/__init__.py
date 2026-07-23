"""mpyfastmcp: a FastMCP-style decorator layer over mpyjsonrpc and mpyschema.

Provides an `MCPServer` object with `@server.tool(...)` / `@server.prompt(...)`
decorators, an initialize/oninitialized handshake exposing client
capabilities, tools/list, tools/call (with argument validation and an
isError result convention), prompts/list, prompts/get, and a
`server.notify(method, params)` API for custom notifications.

# Phase P6 — not yet implemented
"""
