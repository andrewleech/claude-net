# claude-net Implementation Plan

**Spec Source:** docs/CLAUDE_NET_SPEC.md
**Complexity Assessment:** Moderate
**Estimated Phases:** 7 (Phase 0 through Phase 6)
**Generated:** 2026-04-14

## Overview

Build a greenfield LAN messaging hub + MCP channel plugin that lets Claude Code agents communicate by name. The system has two deployable artifacts: a Bun + Elysia hub server (Docker) and a single TypeScript plugin file (served by the hub). No external dependencies, no persistence, no auth.

## Agent Team Structure

This plan is designed for execution by an agent team with defined roles:

### Roles

| Role | Responsibility | Implements Code? |
|------|---------------|-----------------|
| **Orchestrator** | Owns the plan, coordinates phases, routes feedback, tracks progress. Reads all phase files but never writes source code. | No |
| **Implementor** (1-3 concurrent) | Implements a phase's source code following the phase file instructions. Receives feedback from Reviewer and test results from Tester, iterates until phase passes. | Yes |
| **Tester** | Plans tests from spec requirements, writes test files, runs tests against implementor code, reports pass/fail results with specifics back to the implementor. Never fixes production code. | Tests only |
| **Reviewer** | Reviews code and architecture after each phase. Checks spec compliance, code quality, consistency across phases. Provides written feedback to implementor. Never writes production or test code. | No |

### Coordination Protocol

1. **Orchestrator** assigns a phase to an Implementor
2. **Implementor** completes the phase, signals done
3. **Tester** writes/runs tests for that phase, reports results to Implementor
4. **Implementor** fixes any failures, signals done again
5. **Tester** re-runs, confirms pass
6. **Reviewer** reviews the phase code, provides feedback to Implementor
7. **Implementor** addresses feedback
8. **Orchestrator** marks phase complete, assigns next phase

### Parallelism

After Phase 1 (foundation), Phases 2 and 3 can run in parallel with separate Implementors:
- **Implementor A**: Phase 2 (Hub Server)
- **Implementor B**: Phase 3 (Plugin)

Phases 4 and 5 depend on Phase 2 but can run in parallel with each other:
- **Implementor A** (or C): Phase 4 (REST API & Setup)
- **Implementor B** (or C): Phase 5 (Dashboard)

Phase 6 (Docker & Integration) requires all prior phases.

Phase 0 (C4 Architecture Docs) runs in parallel with Phase 1 — it documents the planned architecture using the `/c4-architecture-docs` skill before implementation begins, then is updated at the end to reflect any deviations.

```
Phase 0 (C4 Arch Docs) ──────────────────────────────────────── update ──┐
Phase 1 (Foundation)                                                     │
    ├── Phase 2 (Hub) ──────┬── Phase 4 (REST/Setup) ──┐                │
    │                       │                           ├── Phase 6 (Docker/Integration)
    └── Phase 3 (Plugin) ──┘── Phase 5 (Dashboard) ───┘
```

## Codebase Analysis

### Current State
Greenfield — `~/claude-net/` contains only `docs/CLAUDE_NET_BRAINSTORM.md` and `docs/CLAUDE_NET_SPEC.md`. No source code, no package.json, no configuration files.

### Technology Decisions
- **Runtime**: Bun
- **Hub framework**: Elysia (`.ws()` for WebSocket, chained HTTP routes, `@elysiajs/static` for file serving)
- **Plugin MCP SDK**: `@modelcontextprotocol/sdk` (Server class, StdioServerTransport, `claude/channel` capability)
- **Testing**: `bun test` (built-in, vitest-compatible API)
- **Linting/Formatting**: Biome
- **No build step**: TypeScript executed directly by Bun

### Key Elysia Patterns
- WebSocket routes: `.ws('/ws', { open, message, close })` — each handler receives a `ws` object
- Multiple WS paths: chain `.ws('/ws', {...}).ws('/ws/dashboard', {...})`
- Topic pub/sub: `ws.subscribe(topic)` / `ws.publish(topic, data)` for broadcast to groups
- HTTP + WS coexist on same Elysia instance
- Static serving: `@elysiajs/static` plugin or inline `GET /` route returning HTML

### Key MCP Plugin Patterns (from cc2cc reference)
- MCP Server constructor: `new Server({ name, version }, { capabilities: { experimental: { 'claude/channel': {} }, tools: {} }, instructions })`
- Tool registration: `mcp.setRequestHandler(ListToolsRequestSchema, ...)` and `mcp.setRequestHandler(CallToolRequestSchema, ...)`
- Channel notification: `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`
- Stdio transport: `await mcp.connect(new StdioServerTransport())`
- WebSocket client: `ws` package with EventEmitter pattern, exponential backoff reconnect
- Request/reply correlation: generate `requestId` UUID, listen for matching response frame, 10s timeout

### Project Structure

```
claude-net/
├── docs/
│   ├── architecture/            # C4 architecture docs (Phase 0)
│   │   ├── workspace.dsl        # Structurizr DSL model
│   │   ├── SAD.md               # Software Architecture Description
│   │   └── diagrams/            # Rendered C4 diagrams
│   ├── CLAUDE_NET_SPEC.md       # Specification
│   └── CLAUDE_NET_PLAN.md       # This plan
├── src/
│   ├── hub/
│   │   ├── index.ts             # Elysia server entry point
│   │   ├── registry.ts          # Agent registry (in-memory Map)
│   │   ├── teams.ts             # Team management
│   │   ├── router.ts            # Message routing logic
│   │   ├── ws-plugin.ts         # /ws WebSocket handler (plugin connections)
│   │   ├── ws-dashboard.ts      # /ws/dashboard WebSocket handler
│   │   ├── api.ts               # REST API routes
│   │   ├── setup.ts             # /setup endpoint
│   │   └── dashboard.html       # Dashboard single-page HTML
│   ├── plugin/
│   │   └── plugin.ts            # MCP channel server (served by hub, run by Bun on client)
│   └── shared/
│       └── types.ts             # Shared type definitions (message frames, etc.)
├── tests/
│   ├── hub/
│   │   ├── registry.test.ts
│   │   ├── teams.test.ts
│   │   ├── router.test.ts
│   │   └── ws-plugin.test.ts
│   ├── plugin/
│   │   └── plugin.test.ts
│   └── integration/
│       └── e2e.test.ts
├── package.json
├── tsconfig.json
├── biome.json
├── Dockerfile
└── .dockerignore
```

### Potential Challenges

1. **Plugin served as remote file**: `bun run http://hub:4815/plugin.ts` needs to resolve `@modelcontextprotocol/sdk` imports. The plugin can't have its own `node_modules` since it's a single file fetched from a URL. **Mitigation**: The plugin file must be self-contained or the MCP SDK must be installed on the client machine (documented as a prerequisite). Alternatively, the hub could serve a pre-bundled version.

2. **Elysia WS client tracking**: Elysia's `.ws()` gives you a `ws` object per handler invocation but no built-in registry. The agent registry must manually track WS references in a Map, keyed by agent name. The `close` handler must clean up.

3. **Plugin imports**: The plugin needs the `ws` package (WebSocket client) and `@modelcontextprotocol/sdk`. Since it runs on the client machine, these must either be pre-installed or bundled. **Mitigation**: The setup script could also install dependencies, or the hub serves a bundled single-file plugin.

4. **Dashboard as inline HTML**: Serving a single HTML file with embedded JS/CSS is viable for the initial version but limits complexity. Elysia can serve it as a string from a `GET /` route or use `@elysiajs/static`.

## Phase Overview

### Phase 0: C4 Architecture Documentation
**Goal:** Generate C4 model architecture documentation (System Context, Container, Component diagrams) from the spec using the `/c4-architecture-docs` skill and Structurizr DSL. Produces a living architecture document that is updated at the end of implementation.
**Details:** See CLAUDE_NET_PHASE_0.md
**Assignee:** Reviewer (or dedicated Implementor)
**Parallel with:** Phase 1
**Updated during:** Phase 6 (final reconciliation with implemented architecture)

### Phase 1: Project Foundation & Shared Types
**Goal:** Scaffold the project, configure tooling, define all shared TypeScript types used across hub and plugin.
**Details:** See CLAUDE_NET_PHASE_1.md
**Assignee:** Single Implementor
**Blocks:** All other phases

### Phase 2: Hub Server Core
**Goal:** Implement the hub's agent registry, team management, message routing, and WebSocket handler for plugin connections.
**Details:** See CLAUDE_NET_PHASE_2.md
**Assignee:** Implementor A
**Depends on:** Phase 1
**Parallel with:** Phase 3

### Phase 3: Plugin (MCP Channel Server)
**Goal:** Implement the MCP stdio server with channel capability, WebSocket client, 8 MCP tools, and channel notification emitter.
**Details:** See CLAUDE_NET_PHASE_3.md
**Assignee:** Implementor B
**Depends on:** Phase 1
**Parallel with:** Phase 2

### Phase 4: Hub REST API & Setup Endpoint
**Goal:** Add REST endpoints for dashboard data access and message sending, the setup script endpoint, and plugin.ts file serving.
**Details:** See CLAUDE_NET_PHASE_4.md
**Assignee:** Implementor A or C
**Depends on:** Phase 2

### Phase 5: Dashboard
**Goal:** Build a lightweight single-page HTML dashboard with WebSocket live updates, agent/team views, and message send capability.
**Details:** See CLAUDE_NET_PHASE_5.md
**Assignee:** Implementor B or C (use /frontend-design skill)
**Depends on:** Phase 2

### Phase 6: Docker & Integration Testing
**Goal:** Dockerfile, end-to-end integration tests with multiple agents through the hub, and final documentation.
**Details:** See CLAUDE_NET_PHASE_6.md
**Assignee:** Any Implementor
**Depends on:** All prior phases

## Testing Approach

### Unit Tests (Tester agent, per phase)
- **Phase 1**: Type exports compile correctly
- **Phase 2**: Registry operations, team lifecycle, message routing, name resolution, timeout behavior
- **Phase 3**: MCP tool schemas, channel notification format, request/reply correlation, auto-registration logic
- **Phase 4**: REST endpoint responses, setup script content, host resolution
- **Phase 5**: Dashboard renders, WebSocket event handling
- **Phase 6**: Multi-agent communication, team messaging, broadcast, disconnect/reconnect

### Integration Tests (Phase 6)
- Two plugins communicating through the hub
- Team message delivery to multiple agents
- Broadcast delivery with self-exclusion
- Agent disconnect and reconnect within 2h timeout
- Agent disconnect and timeout expiry (use mocked time)
- Dashboard WebSocket receives all event types

### Manual Testing
- `curl http://localhost:4815/setup | bash` produces valid `claude mcp add` command
- `claude --dangerously-load-development-channels server:claude-net` starts and auto-registers
- Two Claude Code sessions can exchange messages by name
- Dashboard shows live agent list and message feed

## Deployment Considerations

- Dockerfile uses `oven/bun:1` base image
- Single `EXPOSE 4815`
- Volume mount mode: `-v ./src:/app/src` for development
- Env vars: `CLAUDE_NET_HOST`, `CLAUDE_NET_PORT`

## Documentation Updates

- `README.md` — project overview, quick start, architecture diagram
- `CLAUDE.md` — development commands (make/bun scripts), testing notes, contribution guidance
- `docs/architecture/` — C4 architecture documentation (SAD/SDS with Structurizr DSL diagrams, generated via `/c4-architecture-docs` skill in Phase 0)

## Success Criteria

- [ ] Hub starts in Docker, serves dashboard at `/`, plugin at `/plugin.ts`, setup at `/setup`
- [ ] `curl /setup | bash` registers the MCP server with Claude Code
- [ ] Plugin auto-registers with `basename(cwd)@hostname` on session start
- [ ] Agents can send direct messages, broadcast, and team messages by name
- [ ] Short name addressing works; ambiguous names return an error listing full names
- [ ] Teams are created on first join, deleted when empty after last member timeout
- [ ] Team membership survives disconnect for 2 hours
- [ ] Dashboard shows live agent list, team list, message feed, and supports sending messages
- [ ] All hub and plugin unit tests pass
- [ ] Integration tests verify multi-agent communication through the hub
- [ ] `from` field is hub-stamped on all messages (agents cannot spoof identity)
- [ ] C4 architecture documentation generated and reconciled with final implementation

## Next Steps

1. Read this plan and the original spec (docs/CLAUDE_NET_SPEC.md)
2. Launch Phase 0 (C4 Arch Docs) and Phase 1 (Foundation) in parallel
3. After Phase 1, launch Phases 2 and 3 in parallel
4. After Phase 2, launch Phases 4 and 5 in parallel
5. After all phases, run Phase 6 integration testing
6. During Phase 6, update Phase 0 architecture docs to reflect final implementation
