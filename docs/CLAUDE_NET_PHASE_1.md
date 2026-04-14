# claude-net - Phase 1: Project Foundation & Shared Types

**Part of:** CLAUDE_NET_PLAN.md
**Phase:** 1 of 6
**Blocks:** All other phases

## Goal

Scaffold the greenfield project: package.json, TypeScript config, linting, and all shared type definitions that the hub and plugin both depend on. After this phase, every other phase can begin work against concrete type interfaces.

## Prerequisites

- [ ] Spec file read: docs/CLAUDE_NET_SPEC.md
- [ ] Main plan reviewed: CLAUDE_NET_PLAN.md
- [ ] Bun installed on the development machine

## Files to Create

### Project Root

- `package.json` — Bun project. Dependencies: `elysia`, `@elysiajs/static`, `@modelcontextprotocol/sdk`, `ws`. Dev dependencies: `@biomejs/biome`, `@types/bun`, `typescript`. Scripts: `dev` (bun --watch src/hub/index.ts), `test` (bun test), `lint` (biome check), `fmt` (biome format --write).
- `tsconfig.json` — strict mode, target ESNext, module ESNext, moduleResolution bundler, jsx react-jsx, paths alias `@/` → `src/`.
- `biome.json` — formatter (tabs → spaces, 2-width), linter enabled, organise imports.
- `.dockerignore` — node_modules, .git, docs, tests.
- `.gitignore` — node_modules, dist, .env, *.log.

### Source Files

- `src/shared/types.ts` — All shared type definitions (see Key Requirements below)
- `src/hub/index.ts` — Minimal Elysia server that starts and listens on the configured port. Just the skeleton: import Elysia, create app, call `.listen()`. Placeholder routes can be added in later phases.
- `src/plugin/plugin.ts` — Empty placeholder file (will be implemented in Phase 3). Just a comment explaining this file is served by the hub and run on client machines.

## Key Requirements

### 1. Shared Types (`src/shared/types.ts`)

Define all types used across hub, plugin, and dashboard WebSocket frames. These must match the spec's WebSocket Protocol section exactly.

**Message type enum:**
```
MessageType = "message" | "reply"
```

**Plugin → Hub frames (discriminated union on `action`):**
- `RegisterFrame`: `{ action: "register", name: string, requestId?: string }`
- `SendFrame`: `{ action: "send", to: string, content: string, type: MessageType, reply_to?: string, requestId?: string }`
- `BroadcastFrame`: `{ action: "broadcast", content: string, requestId?: string }`
- `SendTeamFrame`: `{ action: "send_team", team: string, content: string, type: MessageType, reply_to?: string, requestId?: string }`
- `JoinTeamFrame`: `{ action: "join_team", team: string, requestId?: string }`
- `LeaveTeamFrame`: `{ action: "leave_team", team: string, requestId?: string }`
- `ListAgentsFrame`: `{ action: "list_agents", requestId?: string }`
- `ListTeamsFrame`: `{ action: "list_teams", requestId?: string }`
- Union type: `PluginFrame = RegisterFrame | SendFrame | BroadcastFrame | ...`

**Hub → Plugin frames (discriminated union on `event`):**
- `ResponseFrame`: `{ event: "response", requestId: string, ok: boolean, data?: unknown, error?: string }`
- `InboundMessageFrame`: `{ event: "message", message_id: string, from: string, to: string, type: MessageType, content: string, reply_to?: string, team?: string, timestamp: string }`
- `RegisteredFrame`: `{ event: "registered", name: string, full_name: string }`
- `ErrorFrame`: `{ event: "error", message: string }`
- Union type: `HubFrame = ResponseFrame | InboundMessageFrame | RegisteredFrame | ErrorFrame`

**Hub → Dashboard frames (discriminated union on `event`):**
- `AgentConnectedEvent`: `{ event: "agent:connected", name: string, full_name: string }`
- `AgentDisconnectedEvent`: `{ event: "agent:disconnected", name: string, full_name: string }`
- `MessageRoutedEvent`: `{ event: "message:routed", message_id: string, from: string, to: string, type: string, content: string, reply_to?: string, team?: string, timestamp: string }`
- `TeamChangedEvent`: `{ event: "team:changed", team: string, members: string[], action: "joined" | "left" | "created" | "deleted" }`
- Union type: `DashboardEvent = AgentConnectedEvent | AgentDisconnectedEvent | MessageRoutedEvent | TeamChangedEvent`

**Data model types (used in API responses and internal state):**
- `AgentInfo`: `{ name: string, fullName: string, shortName: string, host: string, status: "online" | "offline", teams: string[], connectedAt: string }`
- `TeamInfo`: `{ name: string, members: { name: string, status: "online" | "offline" }[] }`

### 2. Hub Skeleton (`src/hub/index.ts`)

Minimal working server:
- Read `CLAUDE_NET_PORT` env var (default 4815)
- Create Elysia instance
- Add a `GET /health` route returning `{ status: "ok" }`
- Call `.listen(port)`
- Log startup message to stdout

### 3. Package Configuration

The `package.json` should use `"type": "module"` and list all dependencies upfront so that later phases don't need to modify it.

Dependencies to include:
- `elysia` — hub framework
- `@elysiajs/static` — static file serving
- `@modelcontextprotocol/sdk` — MCP server for plugin
- `ws` — WebSocket client for plugin
- `@types/ws` — TypeScript types for ws

## Testing Strategy

**Tester agent responsibilities for this phase:**

- Verify all type exports compile: create a test that imports every type from `src/shared/types.ts` and asserts they exist
- Verify the hub skeleton starts: create a test that starts the Elysia server and hits `GET /health`
- Verify `bun install` succeeds with no errors
- Verify `bun run lint` passes

**Test files to create:**
- `tests/shared/types.test.ts` — import all types, verify discriminated union works (create sample frames, narrow by action/event field)
- `tests/hub/index.test.ts` — start server, fetch `/health`, verify response

## Dependencies

**External (npm):**
- elysia
- @elysiajs/static
- @modelcontextprotocol/sdk
- ws
- @types/ws (dev)
- @biomejs/biome (dev)
- typescript (dev)
- @types/bun (dev)

**Internal:**
- None (this is the foundation phase)

## Risks and Mitigations

- **Risk:** Elysia version incompatibility with Bun version
  - **Mitigation:** Pin Elysia to latest stable. Verify `bun install && bun run src/hub/index.ts` works before proceeding.
- **Risk:** Type definitions may need revision as implementation progresses
  - **Mitigation:** Types are cheap to modify. Later phases should flag type mismatches to the Orchestrator, who routes back to the Phase 1 Implementor or handles inline.

## Success Criteria

- [ ] `bun install` completes with no errors
- [ ] `bun run src/hub/index.ts` starts the server on port 4815
- [ ] `curl http://localhost:4815/health` returns `{"status":"ok"}`
- [ ] All types in `src/shared/types.ts` compile and export correctly
- [ ] `bun test` passes all Phase 1 tests
- [ ] `bun run lint` passes with no errors

## Next Steps

After completing this phase:
1. Tester runs all tests and reports results
2. Reviewer checks type definitions against spec
3. Orchestrator launches Phase 2 and Phase 3 in parallel
