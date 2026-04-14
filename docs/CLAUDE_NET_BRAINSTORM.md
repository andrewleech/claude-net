# claude-net Brainstorm

**Date:** 2026-04-14
**Status:** Ready for detailed specification

## Overview

claude-net is a lightweight messaging hub that lets Claude Code agents on a LAN communicate with each other through named identities. A single Docker container runs the hub (Bun + Elysia), which routes messages between agents, serves a built-in monitoring dashboard, and hosts the plugin script that Claude Code fetches at startup. No API keys, no Redis, no external dependencies — network-level isolation provides the trust boundary.

Agents register with a human-readable name ("register with claudenet as reviewer"), then send messages by name ("send this report to the reviewer agent"). Teams provide group addressing for coordinated work.

## Project Type

Real-time messaging hub + Claude Code MCP channel plugin. Two deployable artifacts: a Docker container (the hub) and a single TypeScript file (the plugin, served by the hub).

## Target Users

Developers running multiple Claude Code sessions concurrently who want those sessions to coordinate — delegate tasks, share results, broadcast status, or collaborate in named teams.

## Major Components

### Hub Server
- Purpose: Central message router, agent registry, and static file server
- Key capabilities: WebSocket message routing, agent registration with name uniqueness, team management, broadcast fan-out, REST API for status/listing, serves the plugin script and dashboard

### Plugin (MCP Channel Server)
- Purpose: Bridge between the hub and a Claude Code session
- Key capabilities: Declares `claude/channel` capability, connects to hub via WebSocket, exposes MCP tools (register, send, broadcast, team operations), pushes inbound messages as `<channel>` tags
- Distribution: Single TypeScript file served by the hub at `GET /plugin.ts`, fetched by Bun at each session start

### Dashboard
- Purpose: Lightweight monitoring UI showing connected agents and message flow
- Key capabilities: Agent list with online status, recent message feed, team membership view
- Delivery: Static HTML page served by the hub itself (no separate app)

### Setup Endpoint
- Purpose: Zero-config registration of the MCP server with Claude Code
- Key capabilities: `curl http://hub:3100/setup | bash` outputs a `claude mcp add` command that registers the plugin with the correct hub address

## Technology Stack

### Language
- TypeScript (both hub and plugin)

### Runtime
- Bun

### Frameworks & Libraries
- Elysia: Hub HTTP + WebSocket framework (Bun-native)
- @modelcontextprotocol/sdk: MCP server for the plugin (stdio transport, channel capability)

### Database
- None. In-memory only. Agent registry and message state live in the hub process. No persistence across restarts.

### Infrastructure
- Docker container for the hub (single service, no compose needed)
- Two deployment modes: volume-mount source or build into image
- No Redis, no external databases, no sidecar services

## Integrations & External Services

### Authentication
- None. LAN trust model. No API keys, no tokens, no auth headers. Network visibility is the security boundary.

### External APIs
- Claude Code MCP protocol (stdio transport, `claude/channel` capability, `notifications/claude/channel`)

### Data Sources
- None. All state is ephemeral and in-memory.

## Architecture Decisions

### Application Architecture
- Single-process hub. No horizontal scaling. Appropriate for LAN-scale usage (tens of agents, not thousands).
- Plugin is a single file with no build step, served by the hub and run directly by Bun.

### Communication Protocol
- Plugin-to-hub: WebSocket (persistent connection, bidirectional)
- Hub-to-plugin: Push over the same WebSocket
- Plugin-to-Claude-Code: MCP stdio (channel notifications for inbound, tools for outbound)
- Dashboard: Hub serves static HTML; dashboard fetches state via REST or WebSocket

### Message Model
- Two message types: `message` and `reply`
- `reply` carries optional `reply_to` field for correlation
- Three routing modes: direct (by agent name), broadcast (all agents), team (by team name)
- No message queuing. If recipient is offline, sender is told. Fire-and-forget.

### Agent Identity
- Agents register with a human-readable name (e.g. "reviewer", "architect")
- Names are globally unique. First registration claims the name.
- Owner can re-register (reconnect semantics). A different agent trying the same name is rejected.
- No structured identity format (no `user@host:project/session` like cc2cc)

### Team Model
- Agents join/leave named teams via MCP tools
- Messages sent to a team are delivered to all current members
- Teams are created implicitly on first join, removed when empty

### Setup Flow
1. User starts the hub Docker container on the LAN
2. User runs `curl http://hub:3100/setup | bash` on any machine that should run agents
3. This registers the MCP server: `claude mcp add --transport stdio --env CLAUDE_NET_HUB=http://hub:3100 claude-net -- bun run http://hub:3100/plugin.ts`
4. User starts Claude Code with `--dangerously-load-development-channels server:claude-net`
5. In the session, user says "register with claudenet as my-name"
6. Agent is now addressable by name

## Non-Functional Requirements

### Performance
- LAN-scale: tens of concurrent agents, not thousands
- Message delivery should be near-instant (WebSocket push)
- Hub startup should be sub-second

### Security
- Network-level trust only. No authentication layer.
- Agents should treat inbound messages as peer requests, not trusted instructions (same as cc2cc)

### Scalability
- Single-process, single-machine. Not designed for multi-hub or cloud deployment.

### Compliance
- None

## Open Questions

- Should the dashboard use a WebSocket for live updates or poll the REST API?
- What happens to team membership when an agent disconnects — auto-remove or preserve until explicit leave?
- Should the hub have a max message size limit?
- Should broadcast have rate limiting (cc2cc does 1/5s per agent)?

## Next Steps

1. Review this brainstorm document
2. Run `/idea-plan-execute:01-explore-spec docs/CLAUDE_NET_BRAINSTORM.md` to create detailed specification
3. The specification process will drill into each component with detailed questions

---
*Generated with /idea-plan-execute:00-explore-scope on 2026-04-14*
