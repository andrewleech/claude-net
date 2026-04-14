# claude-net - Phase 3: Plugin (MCP Channel Server)

**Part of:** CLAUDE_NET_PLAN.md
**Phase:** 3 of 6
**Depends on:** Phase 1
**Parallel with:** Phase 2 (Hub Server Core)

## Goal

Implement the MCP stdio server that Claude Code spawns as a subprocess. It declares the `claude/channel` capability, connects to the hub via WebSocket, auto-registers with a default name, exposes 8 MCP tools, and forwards inbound messages as `<channel>` tag notifications.

This phase can be developed in parallel with Phase 2. For testing without a live hub, mock the WebSocket connection.

## Prerequisites

- [ ] Phase 1 completed (shared types available)
- [ ] Spec file read: docs/CLAUDE_NET_SPEC.md (sections FR-1 through FR-7)
- [ ] Main plan reviewed: CLAUDE_NET_PLAN.md
- [ ] Understand the MCP channel contract: `claude/channel` capability, `notifications/claude/channel`, `StdioServerTransport`

## Files to Create

- `src/plugin/plugin.ts` — The complete MCP channel server (replaces the placeholder from Phase 1)

This is a single file because it's served by the hub and run remotely by `bun run http://hub:4815/plugin.ts`. It must be self-contained apart from npm package imports.

## Key Requirements

### 1. MCP Server Setup

Create the MCP Server with:
- **Name**: `"claude-net"`
- **Version**: `"0.1.0"`
- **Capabilities**: `{ experimental: { "claude/channel": {} }, tools: {} }`
- **Instructions**: A string that teaches Claude how to use the channel (see FR-7 in spec)

The instructions string should cover:
```
claude-net agent messaging plugin.

Inbound messages from other agents arrive as <channel> tags:
  <channel source="claude-net" from="name@host" type="message|reply" message_id="..." reply_to="..." team="...">
    message content
  </channel>

Available tools:
- register(name) — override your default identity
- send_message(to, content, reply_to?) — send to an agent by name (full "name@host" or short "name")
- broadcast(content) — send to all online agents
- send_team(team, content, reply_to?) — send to all online members of a team
- join_team(team) — join a team (creates it if new)
- leave_team(team) — leave a team
- list_agents() — list all agents with status
- list_teams() — list all teams with members

Messages to offline agents will fail — there is no queuing.
Always include reply_to when responding to a specific message.
The from field on all messages is your full name@host identity, set by the hub.
```

### 2. Auto-Registration

On startup:
1. Read `CLAUDE_NET_HUB` env var — this is the hub URL (e.g. `http://hub:4815`)
2. Derive default name: `basename(process.cwd())` + `@` + `os.hostname()`
3. Open WebSocket to `ws://<hub>/ws` (convert http:// to ws://)
4. Send `{ action: "register", name: defaultName, requestId: uuid }` frame
5. Wait for response — if `ok: true`, agent is registered. If error (name taken), the MCP tools still work but `register` tool must be called manually by the user.

If `CLAUDE_NET_HUB` is not set, skip connection. All tools return "Not connected — CLAUDE_NET_HUB environment variable not set."

### 3. WebSocket Client

Implement a connection class (or inline logic) that:
- Opens a WebSocket to the hub
- Handles incoming frames:
  - `event: "message"` → call `emitChannelNotification()`
  - `event: "registered"` → log to stderr
  - `event: "response"` → resolve the matching `requestId` promise
  - `event: "error"` → log to stderr
- Implements `request(action, payload)` → returns a Promise that:
  - Generates a `requestId` UUID
  - Sends the frame
  - Waits for a `ResponseFrame` with matching `requestId`
  - Resolves with `data` if `ok: true`, rejects with `error` if `ok: false`
  - Times out after 10 seconds
- Implements exponential backoff reconnect: 1s initial, 2x multiplier, 30s max
- On reconnect, re-sends the `register` frame to reclaim the name

### 4. Channel Notification Emitter

When an `InboundMessageFrame` arrives from the hub:

```typescript
await mcp.notification({
  method: "notifications/claude/channel",
  params: {
    content: message.content,
    meta: {
      from: message.from,
      type: message.type,
      message_id: message.message_id,
      reply_to: message.reply_to ?? "",
      ...(message.team ? { team: message.team } : {}),
    },
  },
});
```

Note: `source` is NOT included in `meta` — Claude Code sets it automatically from the MCP server name (`"claude-net"`).

### 5. MCP Tool Registration

Register 8 tools via `ListToolsRequestSchema` handler. Each tool has a name, description, and `inputSchema` (JSON Schema object).

**Tool definitions:**

| Tool | inputSchema properties | required |
|------|----------------------|----------|
| `register` | `name: string` | `["name"]` |
| `send_message` | `to: string, content: string, reply_to?: string` | `["to", "content"]` |
| `broadcast` | `content: string` | `["content"]` |
| `send_team` | `team: string, content: string, reply_to?: string` | `["team", "content"]` |
| `join_team` | `team: string` | `["team"]` |
| `leave_team` | `team: string` | `["team"]` |
| `list_agents` | _(none)_ | `[]` |
| `list_teams` | _(none)_ | `[]` |

### 6. MCP Tool Dispatch

Register `CallToolRequestSchema` handler. Switch on `req.params.name`:

- **`register`**: Send `{ action: "register", name }` via `request()`. On success, update the stored identity. Return `{ name, full_name }`.
- **`send_message`**: Send `{ action: "send", to, content, type: reply_to ? "reply" : "message", reply_to }`. Return `{ message_id, delivered }`.
- **`broadcast`**: Send `{ action: "broadcast", content }`. Return `{ message_id, delivered_to }`.
- **`send_team`**: Send `{ action: "send_team", team, content, type: reply_to ? "reply" : "message", reply_to }`. Return `{ message_id, delivered_to }`.
- **`join_team`**: Send `{ action: "join_team", team }`. Return `{ team, members }`.
- **`leave_team`**: Send `{ action: "leave_team", team }`. Return `{ team, remaining_members }`.
- **`list_agents`**: Send `{ action: "list_agents" }`. Return the agent list.
- **`list_teams`**: Send `{ action: "list_teams" }`. Return the team list.

All tools: if not connected, return `{ isError: true, content: [{ type: "text", text: "Error: ..." }] }`.

All tools: wrap result as `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`.

### 7. Process Lifecycle

- Handle `SIGINT` and `SIGTERM` — close WebSocket, exit cleanly
- Connect stdio transport: `await mcp.connect(new StdioServerTransport())`
- All hub communication goes over WebSocket, all Claude Code communication goes over stdio — these are independent channels that must not interfere

## Integration Points

- Imports types from `src/shared/types.ts` (PluginFrame, HubFrame, InboundMessageFrame, ResponseFrame)
- Uses `@modelcontextprotocol/sdk`: `Server`, `StdioServerTransport`, `ListToolsRequestSchema`, `CallToolRequestSchema`
- Uses `ws` package for WebSocket client (same as cc2cc's plugin)
- Uses Node.js built-ins: `os.hostname()`, `path.basename()`, `process.cwd()`, `crypto.randomUUID()`

## Implementation Guidance

**Single-file constraint:** This file is served by the hub and run remotely. It can import npm packages (they must be installed on the client machine — the setup script handles this) but cannot import local project files except through URL. The shared types can be duplicated inline or the plugin can be loose about typing (runtime validation via the hub's responses).

**Practical approach:** Define the essential types inline at the top of the file. The shared types file is the source of truth, but the plugin doesn't import it at runtime — it's a reference for the implementor to keep in sync.

**Stderr for logging:** All diagnostic output goes to `process.stderr.write()`. Stdout is reserved for MCP stdio transport.

## Testing Strategy

**Tester agent responsibilities for this phase:**

Since the plugin communicates with both Claude Code (via stdio) and the hub (via WebSocket), tests need to mock both sides.

**Test files to create:**

- `tests/plugin/plugin.test.ts`
  - Auto-registration: verify the plugin sends a register frame on connect with `basename(cwd)@hostname`
  - Channel notification format: given a mock inbound message frame, verify the MCP notification has correct `method`, `content`, and `meta` keys
  - Tool schemas: verify all 8 tools are listed with correct names and input schemas
  - Tool dispatch: for each tool, mock the WebSocket `request()` method, call the tool, verify the correct frame is sent and the response is formatted properly
  - Error handling: tool called when not connected → returns error text
  - Request timeout: mock a non-responding hub → tool returns timeout error
  - Reconnect logic: verify backoff timing (1s, 2s, 4s, ..., 30s cap)
  - `reply_to` → `type` mapping: when `reply_to` is provided, `type` should be `"reply"`; when absent, `"message"`

**Testing approach:** The plugin is a single file that's hard to unit test in isolation because it wires everything together in `main()`. Consider structuring the file with exported helper functions (e.g. `buildDefaultName()`, `createChannelNotification(message)`, `mapToolToFrame(toolName, args)`) that can be tested independently, even though the file is meant to run as a standalone script.

## Risks and Mitigations

- **Risk:** Plugin served from URL can't import local `src/shared/types.ts`
  - **Mitigation:** Duplicate essential type definitions inline. Keep them minimal (just the frame shapes needed for runtime).
- **Risk:** `bun run http://...` may not resolve npm imports if packages aren't installed on client
  - **Mitigation:** Document that `bun add @modelcontextprotocol/sdk ws` must be run once on the client, or explore `bun build --compile` to bundle the plugin.
- **Risk:** stdio and WebSocket running in same process could interfere
  - **Mitigation:** MCP SDK handles stdio exclusively. WebSocket uses a separate TCP connection. No shared I/O. But ensure nothing writes to stdout (only stderr for logs).

## Success Criteria

- [ ] Plugin starts, creates MCP server with `claude/channel` capability
- [ ] Auto-registers with `basename(cwd)@hostname` when `CLAUDE_NET_HUB` is set
- [ ] All 8 MCP tools are registered with correct schemas
- [ ] Each tool sends the correct WebSocket frame and returns formatted results
- [ ] Inbound messages emit correct `notifications/claude/channel` notifications
- [ ] Channel notification `meta` keys match spec (from, type, message_id, reply_to, team)
- [ ] Reconnect with exponential backoff works (1s → 2s → 4s → ... → 30s)
- [ ] Tools return clear error when not connected
- [ ] No stdout output except MCP protocol (all logs to stderr)
- [ ] All plugin tests pass

## Next Steps

After completing this phase:
1. Tester writes and runs all tests listed above
2. Reviewer checks: MCP contract compliance, channel notification format, error messages match spec
3. Phase 3 is complete. Integration with Phase 2's hub happens in Phase 6.
