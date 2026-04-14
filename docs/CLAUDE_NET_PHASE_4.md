# claude-net - Phase 4: Hub REST API & Setup Endpoint

**Part of:** CLAUDE_NET_PLAN.md
**Phase:** 4 of 6
**Depends on:** Phase 2 (Hub Server Core)
**Parallel with:** Phase 5 (Dashboard)

## Goal

Add the REST API endpoints for external access (dashboard data, message sending), the `/setup` endpoint that generates a shell registration script, and the `/plugin.ts` endpoint that serves the plugin source file. After this phase, the hub is feature-complete for non-dashboard consumers.

## Prerequisites

- [ ] Phase 2 completed (registry, teams, router, WebSocket handler all working)
- [ ] Spec file read: docs/CLAUDE_NET_SPEC.md (sections API/Interface Design, Setup Endpoint)
- [ ] Main plan reviewed: CLAUDE_NET_PLAN.md

## Files to Create

- `src/hub/api.ts` — REST endpoint handlers as an Elysia plugin/group
- `src/hub/setup.ts` — Setup endpoint logic (host resolution, script generation)

## Files to Modify

- `src/hub/index.ts` — Import and mount API routes, setup endpoint, static file routes

## Key Requirements

### 1. REST API Endpoints (`src/hub/api.ts`)

Implement as an Elysia group or plugin that can be `.use()`'d into the main app. All endpoints return JSON with appropriate Content-Type.

**`GET /api/agents`**
- Call `registry.list()`
- Return `AgentInfo[]`

**`GET /api/teams`**
- Call `teams.list()`
- Return `TeamInfo[]`

**`GET /api/status`**
- Return:
  ```json
  {
    "uptime": <seconds since hub start>,
    "agents": { "online": <count>, "offline": <count> },
    "teams": <count>
  }
  ```

**`POST /api/send`**
- Body: `{ to: string, content: string, reply_to?: string }`
- The `from` field for dashboard-originated messages should be `"dashboard@hub"` (or similar fixed identity)
- Call `router.routeDirect()`
- Return `{ message_id, delivered }` or error with appropriate HTTP status

**`POST /api/broadcast`**
- Body: `{ content: string }`
- `from` is `"dashboard@hub"`
- Call `router.routeBroadcast()`
- Return `{ message_id, delivered_to }`

**`POST /api/send_team`**
- Body: `{ team: string, content: string, reply_to?: string }`
- `from` is `"dashboard@hub"`
- Call `router.routeTeam()`
- Return `{ message_id, delivered_to }` or error

**Error responses:** Return `{ error: string }` with HTTP 400 for client errors (missing fields, agent not found, team not found). HTTP 500 for unexpected errors.

### 2. Setup Endpoint (`src/hub/setup.ts`)

**`GET /setup`**
- Response Content-Type: `text/plain`
- Determine the hub address:
  1. If `CLAUDE_NET_HOST` env var is set → use it
  2. Otherwise → extract from the `Host` header of the incoming request
- If a port is present in the resolved address, use it. If not, append the configured port.
- Generate and return this shell script:

```bash
#!/bin/bash
set -e
HUB="<resolved_address>"
echo "Registering claude-net MCP server..."
claude mcp add --transport stdio \
  --env CLAUDE_NET_HUB=http://$HUB \
  claude-net -- bun run http://$HUB/plugin.ts
echo ""
echo "claude-net registered. Start Claude Code with:"
echo "  claude --dangerously-load-development-channels server:claude-net"
```

### 3. Plugin File Serving

**`GET /plugin.ts`**
- Read `src/plugin/plugin.ts` from the filesystem and serve it
- Content-Type: `text/typescript` (or `application/typescript`)
- In Docker built-in mode: the file is at `/app/src/plugin/plugin.ts`
- In volume-mount mode: same path (volume mounts over `/app/src`)
- Cache the file content in memory on first read (avoid repeated disk I/O). Invalidate on file change in dev mode if straightforward, otherwise just read once.

### 4. Health Endpoint Update

The Phase 1 skeleton has `GET /health`. Enhance it to include more info:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 123.4,
  "agents": 5,
  "teams": 2
}
```

## Integration Points

- `api.ts` needs access to `registry`, `teams`, and `router` instances. Pass them as dependencies (Elysia's `decorate` or closure pattern).
- `setup.ts` needs access to `CLAUDE_NET_HOST` env var and the request's `Host` header.
- The router needs to handle `"dashboard@hub"` as a sender — this isn't a registered agent. The router should accept an arbitrary `from` string for REST-originated messages (or register a virtual dashboard agent).

## Implementation Guidance

**Dashboard sender identity:** The simplest approach is for the router's `routeDirect`/`routeBroadcast`/`routeTeam` to accept `from` as a plain string parameter rather than looking it up in the registry. The WS handler looks up the registered name; the REST handler passes `"dashboard@hub"` directly. This avoids registering a fake agent.

**Elysia groups:** Use Elysia's `.group('/api', app => ...)` or create a separate `new Elysia({ prefix: '/api' })` and `.use()` it into the main app. Both work; pick whichever is cleaner.

## Testing Strategy

**Tester agent responsibilities for this phase:**

**Test files to create:**

- `tests/hub/api.test.ts`
  - `GET /api/agents` returns agent list (register some agents via WS first)
  - `GET /api/teams` returns team list
  - `GET /api/status` returns uptime, counts
  - `POST /api/send` with valid body → message delivered to connected agent
  - `POST /api/send` with offline agent → 400 error
  - `POST /api/send` with missing fields → 400 error
  - `POST /api/broadcast` → delivered to all connected agents
  - `POST /api/send_team` → delivered to team members
  - `POST /api/send_team` with nonexistent team → 400 error
  - Messages from REST have `from: "dashboard@hub"`

- `tests/hub/setup.test.ts`
  - `GET /setup` without `CLAUDE_NET_HOST` → uses Host header
  - `GET /setup` with `CLAUDE_NET_HOST=mybox:4815` → script contains `mybox:4815`
  - Response is valid bash (starts with `#!/bin/bash`)
  - Script contains `claude mcp add` command with correct args

- `tests/hub/plugin-serve.test.ts`
  - `GET /plugin.ts` returns the plugin source file
  - Content-Type is `text/typescript` or similar
  - Response body contains expected markers (e.g. `@modelcontextprotocol/sdk` import)

## Risks and Mitigations

- **Risk:** Dashboard sender `"dashboard@hub"` bypasses registry validation
  - **Mitigation:** This is intentional. The router accepts `from` as a parameter. REST endpoints are trusted (LAN model). Document this in code comments.
- **Risk:** `GET /plugin.ts` reads from filesystem — path could be wrong in Docker
  - **Mitigation:** Use `import.meta.dir` or `__dirname` equivalent in Bun to resolve the path relative to the hub source, not cwd.

## Success Criteria

- [ ] All REST endpoints return correct JSON responses
- [ ] `POST /api/send` delivers messages to connected agents with `from: "dashboard@hub"`
- [ ] `GET /setup` generates a valid setup script with correct hub address
- [ ] `GET /setup` respects `CLAUDE_NET_HOST` env var with Host header fallback
- [ ] `GET /plugin.ts` serves the plugin source file
- [ ] `GET /health` returns enhanced status info
- [ ] Error responses use HTTP 400 with `{ error: string }` body
- [ ] All tests pass

## Next Steps

After completing this phase:
1. Tester writes and runs all tests
2. Reviewer checks: endpoint compliance with spec, error handling, setup script correctness
3. Phase 4 is complete. Proceed to Phase 6 once Phase 5 is also done.
