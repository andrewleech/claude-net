# claude-net - Phase 0: C4 Architecture Documentation

**Part of:** CLAUDE_NET_PLAN.md
**Phase:** 0 of 6
**Parallel with:** Phase 1 (Foundation)
**Updated during:** Phase 6 (final reconciliation)

## Goal

Generate C4 model architecture documentation using the `/c4-architecture-docs` skill before implementation begins. This produces a Structurizr DSL workspace, rendered C4 diagrams (System Context, Container, Component), and a Software Architecture Description (SAD) document. The documentation serves as a shared reference for all team agents during implementation and is updated at the end to reflect the final architecture.

## Prerequisites

- [ ] Spec file read: docs/CLAUDE_NET_SPEC.md
- [ ] Main plan reviewed: CLAUDE_NET_PLAN.md

## Skill to Use

**Invoke `/c4-architecture-docs` with the claude-net spec as input.**

The skill generates IEC 62304 architecture documentation with C4 model diagrams from Structurizr DSL. Provide it with the full spec and the architectural decisions from the plan.

## Deliverables

### 1. Structurizr DSL Workspace (`docs/architecture/workspace.dsl`)

The C4 model should capture:

**Level 1 — System Context:**
- **claude-net Hub** — the central system
- **Claude Code Session** — external actor (spawns the plugin subprocess)
- **Developer** — human user who starts Claude Code and interacts via dashboard
- **LAN Network** — the trust boundary

**Level 2 — Container Diagram:**
- **Hub Server** (Bun + Elysia process)
  - Listens on port 4815
  - Manages agent registry, teams, message routing
  - Serves dashboard, plugin script, setup endpoint
- **Plugin** (MCP stdio server, TypeScript file)
  - Spawned by Claude Code as a subprocess
  - Bridges hub WebSocket ↔ Claude Code MCP channel
  - Runs on client machine, fetched from hub at startup
- **Dashboard** (embedded HTML page)
  - Served by the hub at `/`
  - WebSocket connection for live updates
  - REST API calls for sending messages

**Level 3 — Component Diagrams:**

Hub components:
- **Registry** (`registry.ts`) — agent registration, name resolution, disconnect timeout
- **Teams** (`teams.ts`) — team lifecycle, membership management
- **Router** (`router.ts`) — message routing (direct, broadcast, team)
- **Plugin WS Handler** (`ws-plugin.ts`) — WebSocket endpoint for agent connections
- **Dashboard WS Handler** (`ws-dashboard.ts`) — WebSocket endpoint for dashboard
- **REST API** (`api.ts`) — HTTP endpoints for external access
- **Setup** (`setup.ts`) — registration script generator
- **Shared Types** (`types.ts`) — type definitions used across all components

Plugin components:
- **MCP Server** — declares `claude/channel` capability, registers tools
- **Hub Connection** — WebSocket client with reconnect logic
- **Channel Emitter** — converts hub messages to MCP channel notifications
- **Tool Dispatch** — maps MCP tool calls to hub WebSocket frames

**Relationships to model:**
- Developer → Dashboard (HTTPS, views agents/teams/messages, sends messages)
- Developer → Claude Code Session (starts with `--dangerously-load-development-channels`)
- Claude Code Session → Plugin (spawns as stdio subprocess)
- Plugin → Hub Server (WebSocket at `/ws`, bidirectional)
- Dashboard → Hub Server (WebSocket at `/ws/dashboard` for events, REST for sending)
- Hub Server → Plugin (pushes inbound messages over WebSocket)
- Hub Server serves Dashboard HTML, Plugin TypeScript, Setup script

### 2. Software Architecture Description (`docs/architecture/SAD.md`)

Document sections:
- **Purpose and Scope** — what claude-net is, LAN-scale agent messaging
- **System Context** — how it fits into the Claude Code ecosystem
- **Container Architecture** — hub, plugin, dashboard and their responsibilities
- **Component Architecture** — internal structure of hub and plugin
- **Communication Protocols** — WebSocket frame format (plugin↔hub, hub↔dashboard), MCP stdio
- **Data Model** — in-memory state (agent registry, disconnected agents, teams)
- **Deployment** — Docker container, `curl | bash` setup, client prerequisites
- **Security** — LAN trust model, hub-stamped `from`, no auth
- **Key Design Decisions** — why no persistence, why no auth, why single process, why plugin served from URL

### 3. Rendered Diagrams (`docs/architecture/diagrams/`)

The `/c4-architecture-docs` skill will render diagrams from the Structurizr DSL. Expected outputs:
- `system-context.png` or `.svg` — Level 1
- `container.png` or `.svg` — Level 2
- `hub-components.png` or `.svg` — Level 3 (hub internals)
- `plugin-components.png` or `.svg` — Level 3 (plugin internals)

## Implementation Guidance

**Invoke the skill:** The assignee should run `/c4-architecture-docs` and provide the spec file path (`docs/CLAUDE_NET_SPEC.md`) along with the architectural context from the plan. The skill handles Structurizr DSL generation and diagram rendering.

**Key architectural boundaries to capture:**
- The hub is a single process — registry, teams, router are in-process modules, not separate services
- The plugin is a single file that runs on a different machine than the hub
- The WebSocket connection between plugin and hub crosses a network boundary
- The MCP stdio connection between plugin and Claude Code is local (same machine)
- The dashboard is not a separate container — it's an HTML file served by the hub process

**Styling guidance for the model:**
- Hub = blue container
- Plugin = green container (runs on client)
- Dashboard = orange container (browser)
- Claude Code = grey external system
- Developer = person shape

## Phase 6 Update

During Phase 6 (Docker & Integration), revisit this documentation:

1. **Verify accuracy** — compare the C4 model against the implemented code. Check that all components exist, relationships are correct, and no new components were introduced.
2. **Update if needed** — modify the Structurizr DSL and regenerate diagrams for any architectural changes that occurred during implementation.
3. **Add deployment view** — if not already present, add a C4 deployment diagram showing the Docker container, port mapping, and client-side plugin runtime.

## Testing Strategy

**Reviewer agent responsibilities:**
- Verify the C4 model accurately represents the spec
- Check all relationships between components are captured
- Verify the SAD document covers all architectural decisions from the spec
- Confirm diagram readability and completeness

No automated tests for this phase — it's documentation.

## Success Criteria

- [ ] Structurizr DSL workspace created with all three C4 levels
- [ ] SAD document generated with all required sections
- [ ] Diagrams rendered and readable
- [ ] System Context shows claude-net hub, Claude Code, developer, LAN boundary
- [ ] Container diagram shows hub server, plugin, dashboard with correct communication protocols
- [ ] Component diagrams show internal structure of hub (registry, teams, router, handlers) and plugin (MCP server, hub connection, channel emitter, tool dispatch)
- [ ] Documentation is consistent with spec (no contradictions)

## Next Steps

After completing this phase:
1. Reviewer validates architecture docs against spec
2. Architecture docs are available as reference for all Implementor and Tester agents
3. During Phase 6, reconcile docs with final implementation
