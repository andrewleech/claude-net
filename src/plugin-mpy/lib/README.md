# lib/

Reusable MicroPython libraries underneath the claude-net plugin, shipped via
the app romfs per Q4.

| Library | Purpose | Owning phase |
|---------|---------|--------------|
| `mpyws` | Async RFC6455 WebSocket client (plain TCP or TLS). | P3 |
| `mpyjsonrpc` | Async newline-delimited JSON-RPC 2.0 peer over stdio. | P4 |
| `mpyschema` | Explicit param specs → MCP `inputSchema` JSON-Schema + argument validation. | P5 |
| `mpyfastmcp` | FastMCP-style `@tool`/`@prompt` decorator layer composing the above. See [`mpyfastmcp/README.md`](mpyfastmcp/README.md). | P6 |
