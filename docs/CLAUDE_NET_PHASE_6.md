# claude-net - Phase 6: Docker & Integration Testing

**Part of:** CLAUDE_NET_PLAN.md
**Phase:** 6 of 6
**Depends on:** All prior phases (0-5)

## Goal

Create the Dockerfile for production deployment, write end-to-end integration tests that verify multi-agent communication through the hub, create the project README, produce a CLAUDE.md with development instructions, and reconcile the Phase 0 C4 architecture documentation against the final implementation.

## Prerequisites

- [ ] All prior phases completed and passing tests
- [ ] Spec file read: docs/CLAUDE_NET_SPEC.md (Deployment section)
- [ ] Main plan reviewed: CLAUDE_NET_PLAN.md

## Files to Create

- `Dockerfile` — Production Docker image
- `tests/integration/e2e.test.ts` — End-to-end integration tests
- `README.md` — Project overview and quick start
- `CLAUDE.md` — Development instructions for Claude Code sessions working on this project

## Files to Modify

- `package.json` — Add `docker:build` and `docker:run` scripts

## Key Requirements

### 1. Dockerfile

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/
ENV CLAUDE_NET_PORT=4815
EXPOSE 4815
CMD ["bun", "run", "src/hub/index.ts"]
```

Key points:
- Use `oven/bun:1` (latest Bun 1.x)
- Two-stage copy: dependencies first (cache layer), then source
- `--production` flag skips dev dependencies (biome, typescript types)
- Expose port 4815
- No HEALTHCHECK directive needed (simple LAN service)

### 2. .dockerignore

Ensure these are excluded:
```
node_modules
.git
docs
tests
*.md
biome.json
tsconfig.json
```

### 3. Integration Tests (`tests/integration/e2e.test.ts`)

These tests start the actual hub server and connect multiple WebSocket clients to simulate real agent interactions. They verify the full message flow end-to-end.

**Test setup:**
- Start the hub on a random available port (use port 0 or a high random port)
- Create WebSocket client helper functions that connect to `/ws` and `/ws/dashboard`
- Each test registers agents, performs operations, and asserts results
- Teardown: close all WebSocket connections, stop the hub

**Test cases:**

**Agent registration:**
- Connect two clients, register as `alice@test` and `bob@test`
- Verify both receive `registered` events
- Verify `list_agents` returns both agents
- Try registering a third client as `alice@test` → error

**Direct messaging:**
- Register `alice` and `bob`
- Alice sends message to `bob`
- Verify Bob receives `InboundMessageFrame` with correct fields
- Verify `from` is `alice@test` (hub-stamped)
- Verify `message_id` is present
- Verify `timestamp` is present
- Alice sends to offline agent `charlie` → error response

**Short name addressing:**
- Register `myproject@laptop` and `other@desktop`
- Send to `myproject` (short name) → resolves to `myproject@laptop`
- Register `myproject@desktop` (same short name, different host)
- Send to `myproject` → ambiguous error listing both full names

**Broadcast:**
- Register `alice`, `bob`, `charlie`
- Alice broadcasts
- Bob and Charlie receive the message
- Alice does NOT receive her own broadcast
- Verify `delivered_to: 2` in response

**Team operations:**
- Alice joins team `backend` → team created (verify response includes members)
- Bob joins team `backend`
- Alice sends to team `backend`
- Bob receives the message with `team: "backend"` field
- Alice does NOT receive her own team message
- Bob leaves team `backend`
- Alice leaves team `backend` → team deleted
- Verify `list_teams` returns empty

**Team messaging edge cases:**
- Send to nonexistent team → error
- Send to team where only sender is a member → error (no online members excluding sender)

**Disconnect and reconnect:**
- Register `alice`, join team `backend`
- Close Alice's WebSocket
- Verify `list_agents` shows Alice as offline
- Verify team `backend` still exists with Alice as offline member
- Reconnect and re-register as `alice@test` within timeout
- Verify team membership is restored
- Verify `list_agents` shows Alice as online again

**Disconnect timeout:**
- Register `alice`, join team `backend`
- Close Alice's WebSocket
- Use a short timeout (configured in test setup, e.g. 200ms)
- Wait for timeout to expire
- Verify Alice is fully removed
- Verify team `backend` is deleted (was the only member)

**Dashboard events:**
- Connect a dashboard WebSocket to `/ws/dashboard`
- Register an agent → verify dashboard receives `agent:connected`
- Send a message → verify dashboard receives `message:routed`
- Join a team → verify dashboard receives `team:changed` with action `"created"` and `"joined"`
- Disconnect agent → verify dashboard receives `agent:disconnected`

**REST API integration:**
- Register `alice` via WebSocket
- `POST /api/send` with `{ to: "alice", content: "hello from dashboard" }`
- Verify Alice receives message with `from: "dashboard@hub"`
- `POST /api/broadcast` → all agents receive
- `GET /api/agents` → returns correct list
- `GET /api/teams` → returns correct list
- `GET /api/status` → returns uptime and counts

**Setup endpoint:**
- `GET /setup` → returns valid bash script
- Script contains `claude mcp add` with correct hub address
- Script contains the plugin.ts URL

**Plugin serving:**
- `GET /plugin.ts` → returns TypeScript source
- Source contains `@modelcontextprotocol/sdk` import

### 4. README.md

Structure:
```markdown
# claude-net

Agent-to-agent messaging for Claude Code sessions on a LAN.

## Quick Start

### 1. Start the hub
docker run -d -p 4815:4815 claude-net

### 2. Register Claude Code
curl http://<hub-address>:4815/setup | bash

### 3. Start Claude Code
claude --dangerously-load-development-channels server:claude-net

### 4. Register your agent
In the Claude Code session, say:
"register with claude-net as my-name"

## How It Works
[Brief architecture description — hub routes messages, plugin bridges to Claude Code via MCP channel]

## Configuration
[Environment variables table]

## Development
[How to run locally, run tests]
```

### 5. Reconcile C4 Architecture Documentation

Review and update the Phase 0 architecture documentation against the final implementation:

1. **Read the current `docs/architecture/workspace.dsl`** and compare against actual source files
2. **Verify all components exist** — check that every component in the C4 model maps to a real source file
3. **Verify all relationships** — check that communication paths match (WebSocket, REST, stdio)
4. **Check for missing components** — if any new modules were added during implementation that aren't in the model, add them
5. **Update the SAD** — ensure `docs/architecture/SAD.md` reflects any architectural decisions that changed during implementation
6. **Re-render diagrams** — if the Structurizr DSL changed, regenerate diagrams using `/c4-architecture-docs`
7. **Add deployment view** — if not already present, add a C4 deployment diagram showing the Docker container, port 4815, and client-side plugin runtime

Use `/c4-architecture-docs` skill for any updates to the Structurizr DSL or diagram regeneration.

### 6. CLAUDE.md

Development instructions for future Claude Code sessions working on this codebase:

```markdown
# CLAUDE.md

## Commands
bun install          # install dependencies
bun run dev          # start hub with --watch
bun test             # run all tests
bun run lint         # biome check
bun run fmt          # biome format

## Architecture
[Brief project structure description]

## Testing
bun test                                    # all tests
bun test tests/hub/registry.test.ts         # single file
bun test tests/integration/e2e.test.ts      # integration tests

## Docker
docker build -t claude-net .
docker run -p 4815:4815 claude-net
```

## Testing Strategy

**Tester agent responsibilities for this phase:**

The integration tests ARE the primary deliverable of this phase. The tester should:
1. Write all integration tests listed above
2. Run them against the full hub
3. Verify every test passes
4. Report any failures with full error output to the Implementor

**Additional manual verification:**
- Build Docker image: `docker build -t claude-net .`
- Run container: `docker run -p 4815:4815 claude-net`
- Verify `curl http://localhost:4815/health` works
- Verify `curl http://localhost:4815/setup` returns valid script
- Verify `curl http://localhost:4815/plugin.ts` returns TypeScript
- Verify dashboard loads at `http://localhost:4815/`

## Risks and Mitigations

- **Risk:** Integration tests are flaky due to WebSocket timing
  - **Mitigation:** Use proper async/await with message receipt promises. Add reasonable timeouts (5s per operation). Use `waitForMessage()` helper that resolves when a matching frame arrives.
- **Risk:** Docker build fails due to native dependencies
  - **Mitigation:** All dependencies (elysia, ws, mcp-sdk) are pure JS/TS. No native compilation needed. `oven/bun:1` image includes everything.
- **Risk:** Port conflicts in tests
  - **Mitigation:** Use port 0 (OS assigns random available port) or a high random port for each test run. Read the actual port from the server after startup.

## Success Criteria

- [ ] `docker build -t claude-net .` succeeds
- [ ] `docker run -p 4815:4815 claude-net` starts and serves all endpoints
- [ ] All integration tests pass (agent registration, messaging, teams, broadcast, disconnect/reconnect, dashboard events, REST API, setup endpoint)
- [ ] README.md covers quick start and development
- [ ] CLAUDE.md covers development commands and architecture
- [ ] Full test suite (`bun test`) passes: unit tests (Phases 1-5) + integration tests (Phase 6)
- [ ] C4 architecture docs reconciled with final implementation

## Final Checklist (Orchestrator)

After Phase 6 completes, verify all success criteria from the main plan:

- [ ] Hub starts in Docker, serves dashboard at `/`, plugin at `/plugin.ts`, setup at `/setup`
- [ ] `curl /setup | bash` registers the MCP server with Claude Code
- [ ] Plugin auto-registers with `basename(cwd)@hostname` on session start
- [ ] Agents can send direct messages, broadcast, and team messages by name
- [ ] Short name addressing works; ambiguous names return error listing full names
- [ ] Teams are created on first join, deleted when empty after last member timeout
- [ ] Team membership survives disconnect for 2 hours
- [ ] Dashboard shows live agent list, team list, message feed, and supports sending
- [ ] All unit and integration tests pass
- [ ] `from` field is hub-stamped on all messages
- [ ] C4 architecture documentation is accurate and complete
