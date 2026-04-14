# claude-net - Phase 2: Hub Server Core

**Part of:** CLAUDE_NET_PLAN.md
**Phase:** 2 of 6
**Depends on:** Phase 1
**Parallel with:** Phase 3 (Plugin)

## Goal

Implement the hub's core logic: agent registry with name uniqueness and short-name resolution, team management with implicit lifecycle and 2-hour disconnect timeout, message routing (direct, broadcast, team), and the WebSocket handler for plugin connections at `/ws`.

After this phase, plugins can connect over WebSocket, register, send/receive messages, and manage team membership. No REST API or dashboard yet.

## Prerequisites

- [ ] Phase 1 completed (project scaffold, shared types, hub skeleton)
- [ ] Spec file read: docs/CLAUDE_NET_SPEC.md (sections FR-1 through FR-5)
- [ ] Main plan reviewed: CLAUDE_NET_PLAN.md

## Files to Create

- `src/hub/registry.ts` — Agent registry: register, unregister, resolve by full/short name, list all
- `src/hub/teams.ts` — Team management: join, leave, list, implicit create/delete, disconnect timeout
- `src/hub/router.ts` — Message routing: direct send, broadcast, team send. Generates message_id, stamps `from` and `timestamp`
- `src/hub/ws-plugin.ts` — Elysia WebSocket handler for `/ws`. Parses plugin frames, dispatches to registry/teams/router, sends responses and pushes inbound messages

## Files to Modify

- `src/hub/index.ts` — Import and mount the `/ws` WebSocket handler and wire up registry/teams/router

## Key Requirements

### 1. Agent Registry (`src/hub/registry.ts`)

**State:**
- `agents: Map<string, AgentEntry>` — keyed by `fullName` (e.g. `myproject@laptop`)
- `disconnected: Map<string, DisconnectedEntry>` — keyed by `fullName`, for team timeout tracking

**AgentEntry:**
```
{ fullName, shortName, host, ws, teams: Set<string>, connectedAt: Date }
```

**DisconnectedEntry:**
```
{ fullName, teams: Set<string>, disconnectedAt: Date, timeoutId: ReturnType<typeof setTimeout> }
```

**Operations:**
- `register(fullName, ws)` → success or error if name taken by a different connection
  - Parse `fullName` into `shortName` (before `@`) and `host` (after `@`)
  - If `fullName` exists in `agents` and the WS is different → reject
  - If `fullName` exists in `disconnected` → restore team memberships, cancel timeout, move to `agents`
  - Otherwise → add to `agents`
- `unregister(fullName)` → move to `disconnected` with 2h timeout. When timeout fires, remove from `disconnected` and clean up team memberships via teams module.
- `resolve(name)` → returns the `AgentEntry` or an error
  - If `name` contains `@` → exact match lookup in `agents`
  - If no `@` → scan `agents` for entries where `shortName === name`
    - 0 matches → error "Agent 'X' is not online"
    - 1 match → return it
    - 2+ matches → error "Multiple agents match 'X': full1, full2. Use the full name."
- `list()` → returns all agents (online from `agents` map, offline from `disconnected` map) as `AgentInfo[]`
- `getByFullName(fullName)` → direct lookup, returns entry or null

### 2. Team Management (`src/hub/teams.ts`)

**State:**
- `teams: Map<string, Set<string>>` — team name → set of agent `fullName`s

**Operations:**
- `join(teamName, agentFullName)` → add agent to team. If team doesn't exist, create it. Return current member list.
- `leave(teamName, agentFullName)` → remove agent from team. If team becomes empty, delete it. Return remaining member count.
- `getTeamsForAgent(agentFullName)` → return set of team names
- `getMembers(teamName)` → return set of agent fullNames, or null if team doesn't exist
- `removeFromAllTeams(agentFullName)` → remove agent from every team they belong to. Delete any teams that become empty.
- `list()` → return all teams as `TeamInfo[]` (with member online/offline status from registry)

**Interaction with registry:** The teams module needs a reference to the registry to determine online/offline status of members. Pass the registry as a dependency (constructor injection or function parameter).

### 3. Message Router (`src/hub/router.ts`)

**Operations:**
- `routeDirect(from, to, content, type, reply_to?)` → resolve `to` via registry, send `InboundMessageFrame` to recipient's WS. Return `{ message_id, delivered: true }` or error.
- `routeBroadcast(from, content)` → iterate all agents except sender, send `InboundMessageFrame` to each. Return `{ message_id, delivered_to: count }`.
- `routeTeam(from, team, content, type, reply_to?)` → get team members from teams module, send to all online members except sender. Return `{ message_id, delivered_to: count }` or error if team doesn't exist or no online members.

**Message envelope:** Every routed message gets:
- `message_id` — `crypto.randomUUID()`
- `from` — sender's `fullName` (hub-stamped, never from client)
- `timestamp` — `new Date().toISOString()`
- `team` — set only for team messages

### 4. WebSocket Handler (`src/hub/ws-plugin.ts`)

Export a function or Elysia plugin that adds `.ws('/ws', { open, message, close })` to the app.

**`open(ws)`:**
- No action yet — agent must send a `register` frame to claim a name. Store the raw WS reference temporarily (unregistered connections).

**`message(ws, data)`:**
- Parse JSON. If invalid → send `ErrorFrame`.
- Switch on `action` field:
  - `"register"` → call `registry.register()`, if success send `RegisteredFrame` (and `ResponseFrame` if requestId present). Emit `AgentConnectedEvent` to dashboard clients.
  - `"send"` → call `router.routeDirect()`, send `ResponseFrame` with result
  - `"broadcast"` → call `router.routeBroadcast()`, send `ResponseFrame` with result
  - `"send_team"` → call `router.routeTeam()`, send `ResponseFrame` with result
  - `"join_team"` → call `teams.join()`, update agent's teams set, send `ResponseFrame`. Emit `TeamChangedEvent`.
  - `"leave_team"` → call `teams.leave()`, update agent's teams set, send `ResponseFrame`. Emit `TeamChangedEvent`.
  - `"list_agents"` → call `registry.list()`, send `ResponseFrame` with data
  - `"list_teams"` → call `teams.list()`, send `ResponseFrame` with data
  - Unknown action → send `ResponseFrame` with `ok: false, error: "Unknown action"`

**`close(ws)`:**
- Look up which agent this WS belongs to
- Call `registry.unregister()` (starts 2h timeout)
- Emit `AgentDisconnectedEvent` to dashboard clients

**Dashboard event emission:** The WS handler needs a way to push events to dashboard clients. For now, export a `dashboardBroadcast(event: DashboardEvent)` function that later phases will wire up. In Phase 2, it can be a no-op or store events in a list.

### 5. Hub Entry Point Updates (`src/hub/index.ts`)

- Import and instantiate registry, teams, router
- Mount the `/ws` handler
- Wire dependencies (registry → teams, router → registry + teams)

## Integration Points

- Uses all types from `src/shared/types.ts` (PluginFrame, HubFrame, DashboardEvent)
- The `ws` object in Elysia handlers is Elysia's WebSocket wrapper. Use `ws.send(JSON.stringify(frame))` for outbound. Use `ws.data` for any context stored during upgrade.
- Elysia's `.ws()` automatically parses JSON if the message is a string. Verify whether you need `JSON.parse()` or if Elysia does it.

## Testing Strategy

**Tester agent responsibilities for this phase:**

Create test files that verify all hub core behavior WITHOUT requiring a real WebSocket connection where possible. Use direct function calls on registry, teams, and router with mock WS objects.

**Test files to create:**

- `tests/hub/registry.test.ts`
  - Register an agent, verify it appears in list
  - Register duplicate name with different WS → error
  - Re-register same name with same WS context → success (reconnect)
  - Unregister → agent moves to disconnected, appears offline in list
  - Reconnect within timeout → team memberships restored
  - Timeout expires → agent fully removed
  - Resolve by full name → exact match
  - Resolve by short name → single match found
  - Resolve by ambiguous short name → error with full names listed
  - Resolve nonexistent → error

- `tests/hub/teams.test.ts`
  - Join creates team if new
  - Join existing team adds member
  - Leave removes member
  - Leave last member deletes team
  - List returns all teams with members
  - removeFromAllTeams cleans up correctly

- `tests/hub/router.test.ts`
  - Direct send delivers to recipient WS (mock)
  - Direct send to offline agent → error
  - Broadcast delivers to all except sender
  - Broadcast with 0 other agents → delivered_to: 0
  - Team send delivers to online team members except sender
  - Team send to nonexistent team → error
  - Team send with no online members → error
  - All routed messages have message_id, from (hub-stamped), timestamp

- `tests/hub/ws-plugin.test.ts`
  - Start hub, connect via WebSocket, send register frame, receive registered event
  - Send message between two connected agents
  - Broadcast from one agent, verify others receive
  - Join team, send team message, verify delivery
  - Disconnect agent, verify timeout behavior
  - Invalid JSON frame → error event
  - Unknown action → error response

## Risks and Mitigations

- **Risk:** Elysia WS handler's `ws` object API may differ from raw Bun WebSocket
  - **Mitigation:** Test early with a real WS connection in `ws-plugin.test.ts`. Elysia's `ws.send()` and `ws.close()` should match, but verify.
- **Risk:** Mock WS objects in unit tests may not catch real serialization issues
  - **Mitigation:** `ws-plugin.test.ts` uses real WebSocket connections as integration-level tests.
- **Risk:** Timer-based team timeout (2h) is hard to test without mocking time
  - **Mitigation:** Make the timeout duration configurable (default 2h) so tests can use a short value (e.g. 100ms).

## Success Criteria

- [ ] Agents can register via WebSocket and receive `registered` event
- [ ] Duplicate name registration is rejected
- [ ] Direct messages route to the correct recipient
- [ ] Broadcast delivers to all connected agents except sender
- [ ] Team join creates team implicitly, leave deletes when empty
- [ ] Team messages deliver to all online members except sender
- [ ] Agent disconnect starts 2h timeout; reconnect within window restores memberships
- [ ] Short name resolution works; ambiguous names return an error with alternatives
- [ ] `from` field is hub-stamped on all routed messages
- [ ] All unit and WS integration tests pass

## Next Steps

After completing this phase:
1. Tester writes and runs all tests listed above
2. Reviewer checks: spec compliance (FR-1 through FR-5), code quality, type usage
3. Orchestrator can launch Phase 4 (REST API) and Phase 5 (Dashboard) once Phase 2 passes
