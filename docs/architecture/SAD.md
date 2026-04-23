# claude-net Software Architecture Description

## 1. Purpose and Scope

claude-net is a lightweight messaging hub for Claude Code agents on a LAN. It enables multiple concurrent Claude Code sessions to communicate through named identities: agents register with human-readable names, send direct messages, broadcast, and coordinate through teams.

The system also provides session mirroring: a local daemon captures Claude Code hook events and streams them to the hub, allowing developers to observe session activity in real time from any browser on the LAN.

The system targets developers running multiple Claude Code sessions who need those sessions to delegate tasks, share results, and collaborate without manual intervention.

Scope boundaries:

- LAN-scale only (tens of agents, not hundreds)
- No message queuing or offline delivery (live delivery only)
- No authentication; network isolation is the trust boundary
- Single Docker container for the hub; single TypeScript file for the plugin
- Mirror transcripts are retained in memory only (no persistence across hub restart) unless an optional S3-compatible store is configured

## 2. System Context

claude-net sits between Claude Code sessions and the developer:

| Actor | Type | Interaction |
|-------|------|-------------|
| **Developer** | Person | Starts Claude Code sessions; views agent activity, session transcripts, and sends messages via the dashboard |
| **Claude Code Session** | External system | Spawns the plugin as a stdio subprocess; communicates with it via MCP protocol |
| **Mirror-Agent Daemon** | Local process | Runs on each client machine; captures Claude Code hook events and streams them to the hub; handles inject/paste RPCs |
| **claude-net Hub** | Primary system | Routes messages between agents, manages identity and teams, stores session transcripts, serves dashboard and plugin |

The hub runs as a Docker container on the LAN. Each Claude Code session on any LAN machine fetches the plugin script from the hub and spawns it as a subprocess. The developer accesses the dashboard through a browser pointed at the hub's address.

## 3. Container Architecture

The system comprises four runtime participants:

### 3.1 Hub Server

- **Technology:** Bun runtime, Elysia framework, TypeScript
- **Port:** 4815
- **Process model:** Single Bun process (not microservices)
- **Responsibilities:**
  - Agent registration and name resolution
  - Team lifecycle management
  - Message routing (direct, broadcast, team)
  - WebSocket endpoint for plugins (`/ws`)
  - WebSocket endpoint for dashboard live events (`/ws/dashboard`)
  - WebSocket endpoint for mirror session watchers (`/ws/mirror/{sid}`)
  - WebSocket endpoint for host daemons (`/ws/host`)
  - REST API (`/api/*`) for dashboard message sending, status queries, and event log
  - REST API (`/api/mirror/*`) for mirror session lifecycle, transcripts, inject, and paste
  - In-memory event log (bounded ring buffer) capturing agent lifecycle and routing outcomes
  - Serving the dashboard HTML at `/`
  - Serving the plugin TypeScript at `/plugin.ts`
  - Serving the setup script at `/setup`
  - Serving launcher binaries at `/bin/*`

### 3.2 Plugin

- **Technology:** TypeScript, MCP SDK, Bun runtime
- **Delivery:** Single file served by the hub at `/plugin.ts`, fetched at startup via `bun run http://hub:4815/plugin.ts`
- **Execution:** Spawned by Claude Code as a stdio subprocess on the client machine
- **Responsibilities:**
  - MCP server with `claude/channel` capability and 11 tools
  - WebSocket client connecting to hub at `/ws`
  - Translating MCP tool calls into hub WebSocket frames
  - Translating hub message events into MCP channel notifications
  - Auto-registering with default identity `session:user@host`
  - Reporting its version to the hub on register; surfacing upgrade hints to the LLM
  - Reconnection with exponential backoff (1s to 30s)

### 3.3 Dashboard

- **Technology:** HTML, CSS, JavaScript (single page)
- **Delivery:** Served by the hub at `/`
- **Execution:** Runs in the developer's browser
- **Responsibilities:**
  - Displaying connected agents, their teams, and live message feed
  - Session mirroring: live transcript view, inject/paste controls
  - Host launcher: browse remote directories, launch new Claude Code sessions
  - Sending messages to agents and teams via REST API

### 3.4 Mirror-Agent Daemon

- **Technology:** TypeScript, Bun runtime
- **Delivery:** Fetched from hub at `/bin/claude-net-mirror-agent` or bundled
- **Execution:** Long-running background process on each client machine, started by `claude-channels` launcher
- **Responsibilities:**
  - Accepts hook POST requests from `claude-net-mirror-push` (Claude Code hook forwarder) on loopback
  - Tails each session's JSONL transcript for event reconciliation
  - Maintains one hub WebSocket per active Claude Code session (using the agent WS protocol)
  - Forwards deduplicated mirror events to the hub
  - Handles inject, paste, stop, and list-commands RPCs from the hub
  - Opens a host channel WebSocket (`/ws/host`) to enable dashboard-driven session launching

### Container Communication

| From | To | Protocol | Path |
|------|----|----------|------|
| Claude Code | Plugin | stdio | MCP tool calls and channel notifications |
| Plugin | Hub Server | WebSocket | `/ws` (bidirectional) |
| Dashboard | Hub Server | WebSocket | `/ws/dashboard` (hub pushes events) |
| Dashboard | Hub Server | REST | `/api/*`, `/api/mirror/*` |
| Hub Server | Dashboard | HTTP | `/` (serves HTML) |
| Hub Server | Plugin | HTTP | `/plugin.ts` (serves script at startup) |
| Developer | Hub Server | HTTP | `/setup` via `curl \| bash` |
| Mirror-Agent | Hub Server | WebSocket | `/ws` (registers as agent, sends mirror events) |
| Mirror-Agent | Hub Server | WebSocket | `/ws/host` (host channel for launcher RPC) |
| Dashboard | Hub Server | WebSocket | `/ws/mirror/{sid}` (live transcript stream) |

## 4. Component Architecture

### 4.1 Hub Components

| Component | File | Responsibility |
|-----------|------|---------------|
| **Registry** | `registry.ts` | Agent registration, name uniqueness enforcement, full/short name resolution, disconnect timeout tracking (configurable grace window for team membership restoration) |
| **Teams** | `teams.ts` | Team implicit creation/deletion, join/leave operations, membership queries, timeout-based cleanup |
| **Router** | `router.ts` | Message routing for direct, broadcast, and team targets. Generates `message_id` (UUID), stamps `from` and `timestamp` on all messages. Returns structured outcome (delivered / nak with reason) |
| **Plugin WS Handler** | `ws-plugin.ts` | WebSocket endpoint at `/ws`. Parses incoming JSON frames, dispatches to Registry/Teams/Router/EventLog/MirrorRegistry, sends response and message frames. Manages WS ping/pong liveness and stale-connection eviction |
| **Dashboard WS Handler** | `ws-dashboard.ts` | WebSocket endpoint at `/ws/dashboard`. Pushes `agent:connected`, `agent:disconnected`, `message:routed`, `team:changed`, `system:event`, `mirror:*`, and `host:*` events. Sends initial state on connection. Acts as virtual `dashboard@hub` agent |
| **Mirror WS Handler** | `mirror.ts` (wsMirrorPlugin) | WebSocket endpoint at `/ws/mirror/{sid}`. Registers watchers; replays transcript on connect; forwards new events live |
| **Host WS Handler** | `ws-host.ts` | WebSocket endpoint at `/ws/host`. Accepts long-lived daemon connections; handles ls/mkdir/launch RPCs; updates HostRegistry on connect/disconnect |
| **Mirror Registry** | `mirror.ts` (MirrorRegistry) | In-memory session state: transcript ring buffer (2000 events), watcher set, agent connection, paste/command pending maps, orphan sweeper. Optional persistent store interface |
| **Host Registry** | `host-registry.ts` | In-memory set of connected host daemons with their metadata (home dir, recent cwds, launch policy) |
| **Event Log** | `event-log.ts` | Bounded ring buffer (default 10,000 entries) of structured hub events. Push/query/summary API. Notifies a listener callback on each push (used for dashboard broadcast) |
| **REST API** | `api.ts` | `GET /api/agents`, `GET /api/teams`, `GET /api/hosts`, `GET /api/status`, `POST /api/send`, `POST /api/broadcast`, `POST /api/send_team`, `GET /api/events`, `GET /api/events/summary` |
| **Mirror REST API** | `mirror.ts` (mirrorPlugin) | `POST /api/mirror/session`, `GET /api/mirror/sessions`, `GET /api/mirror/sessions/all`, `GET /api/mirror/:sid/transcript`, `POST /api/mirror/:sid/close`, `POST /api/mirror/:sid/rename`, `POST /api/mirror/:sid/inject`, `POST /api/mirror/:sid/paste`, `POST /api/mirror/:sid/stop`, `GET /api/mirror/:sid/commands`, `GET /api/mirror/config`, `GET /api/mirror/archive/:sid` |
| **Uploads** | `uploads.ts` | Temporary file store for paste payloads too large for a single inject. Keyed by session; purged on session close |
| **Setup** | `setup.ts` | `GET /setup` endpoint. Generates a shell script that registers claude-net as an MCP server in Claude Code config |
| **Bin Server** | `bin-server.ts` | Serves launcher and agent binaries from `/bin/*` |
| **Mirror Store** | `mirror-store.ts` | Optional S3-compatible backend for transcript persistence. `NullStore` is the default (in-memory only) |
| **Shared Types** | `shared/types.ts` | TypeScript type definitions for all WebSocket frames, message structures, agent records, team records, mirror frames, and dashboard events |

All components run in the same Bun process. They are in-process modules sharing memory, not networked services.

### 4.2 Plugin Components

| Component | Responsibility |
|-----------|---------------|
| **MCP Server** | Declares `claude/channel` and `tools` capabilities. Registers 11 tools. Provides an `instructions` string injected into Claude's system prompt describing message format and tool usage |
| **Hub Connection** | WebSocket client to hub `/ws`. Manages connection lifecycle, reconnects with exponential backoff (1s to 30s). Correlates request/response via `requestId` with 10s timeout |
| **Channel Emitter** | Converts inbound hub `event: "message"` frames into `notifications/claude/channel` MCP notifications. Sets meta attributes: `from`, `type`, `message_id`, `reply_to`, `team` |
| **Tool Dispatch** | Maps each MCP tool call to a hub WebSocket frame. Assigns a `requestId`, awaits the response, returns structured results or errors |
| **Version Reporter** | Reports `plugin_version` on register. On mismatch, hub returns an `upgrade_hint`; plugin surfaces it on the next tool result via the nudge queue |
| **Channel Capability Detector** | Reads `experimental["claude/channel"]` from the MCP `initialize` capabilities after handshake. Sets `channel_capable` flag reported to hub on register |
| **Nudge Queue** | One-shot text queue appended to the next tool result. Carries rename suggestions, channels-off warnings, and upgrade hints. Entries can have a guard condition for deferred emission |

## 5. Communication Protocols

### 5.1 Plugin to Hub WebSocket Frames

All frames are JSON with an optional `requestId` for request-response correlation.

**Plugin → Hub actions:**

| Action | Description |
|--------|-------------|
| `register` | Claim an identity. Carries `name`, `channel_capable`, `plugin_version` |
| `send` | Direct message. Carries `to`, `content`, `type` (`message`\|`reply`), optional `reply_to` |
| `broadcast` | Message to all online agents. Carries `content` |
| `send_team` | Message to all online team members. Carries `team`, `content`, `type`, optional `reply_to` |
| `join_team` | Join a team (created implicitly). Carries `team` |
| `leave_team` | Leave a team (deleted when last member leaves). Carries `team` |
| `list_agents` | Query all registered agents |
| `list_teams` | Query all teams with membership |
| `ping` | Test channel round-trip. Hub echoes back as an inbound message notification |
| `query_events` | Query the event log. Carries optional `event` (prefix filter), `since` (epoch ms), `limit`, `agent` (substring match) |
| `mirror_event` | Stream a Claude Code hook event for a session (sent by mirror-agent). Carries `sid`, `uuid`, `kind`, `ts`, `payload` |
| `mirror_paste_done` | Reply to a paste RPC. Carries `sid`, `requestId`, optional `path` or `error` |
| `mirror_commands_done` | Reply to a list-commands RPC. Carries `sid`, `requestId`, optional `commands` array |
| `mirror_thinking` | Ephemeral activity signal (sent by mirror-agent). Carries `sid`, `active`, optional `startedAt`, `tool` |

**Hub → Plugin events:**

| Event | Description |
|-------|-------------|
| `response` | Reply to a request. Carries `requestId`, `ok`, optional `data`, optional `error` |
| `message` | Inbound message push. Carries `message_id`, `from`, `to`, `type`, `content`, optional `reply_to`, `team`, `timestamp` |
| `registered` | Unsolicited confirmation of auto-registration. Carries `name`, `full_name` |
| `error` | Unsolicited protocol error |
| `mirror_inject` | RPC: inject text into a session's tmux pane. Carries `sid`, `text`, `seq`, `origin` |
| `mirror_paste` | RPC: write a large blob to a local temp file. Carries `sid`, `requestId`, `text`, `origin` |
| `mirror_list_commands` | RPC: scan available slash commands. Carries `sid`, `requestId` |
| `mirror_stop` | RPC: send Escape keypress to session pane. Fire-and-forget |
| `mirror_control` | RPC: pause, resume, or close mirror session. Carries `sid`, `op` |

### 5.2 Hub to Dashboard WebSocket Frames

Dashboard WebSocket is read-only from the dashboard's perspective. All outbound events:

| Event | Trigger |
|-------|---------|
| `agent:connected` | Agent registers or reconnects |
| `agent:disconnected` | Agent WS closes |
| `message:routed` | Any message delivery attempt (direct, broadcast, team) |
| `team:changed` | Team join, leave, create, or delete |
| `system:event` | Every EventLog push — carries `ts`, `name` (event type), `data` |
| `mirror:session_started` | New mirror session created |
| `mirror:session_ended` | Mirror session closed |
| `mirror:event` | New transcript event in a session |
| `mirror:watcher_joined` | Browser connects to `/ws/mirror/{sid}` |
| `mirror:watcher_left` | Watcher disconnects |
| `mirror:activity` | Lightweight ping on each mirror event (sid + ts only) |
| `mirror:owner_renamed` | Agent renames itself; mirror sessions reassigned |
| `host:connected` | Host daemon connects on `/ws/host` |
| `host:disconnected` | Host daemon disconnects |

On dashboard connect, the hub replays current state: one `agent:connected` per registered agent, one `team:changed` (action `created`) per existing team, one `host:connected` per connected host.

### 5.3 MCP stdio Protocol

The plugin communicates with Claude Code over stdio using the MCP protocol:

- **Inbound (Claude Code → Plugin):** MCP tool calls for the 11 registered tools
- **Outbound (Plugin → Claude Code):** `notifications/claude/channel` notifications carrying inbound messages as structured channel events with meta attributes (`from`, `type`, `message_id`, `reply_to`, `team`)

### 5.4 Message Types

Two types: `message` (standalone) and `reply` (carries `reply_to` referencing a previous `message_id`).

### 5.5 EventLog Event Taxonomy

Every entry: `{ ts: number, event: string, data: Record<string, unknown> }`

| Event | Trigger | Key `data` fields |
|-------|---------|-------------------|
| `agent.registered` | Successful register | `fullName`, `channelCapable`, `pluginVersion`, `restored`, `renamedFrom?` |
| `agent.disconnected` | WS close | `fullName`, `reason: "close" \| "evicted" \| "renamed"` |
| `agent.evicted` | Ping tick stale threshold | `fullName`, `lastPongAt`, `silentForMs` |
| `agent.upgraded` | Version mismatch on register | `fullName`, `reportedVersion`, `currentVersion` |
| `message.sent` | routeDirect completes | `from`, `to`, `messageId`, `outcome`, `reason?`, `elapsedMs` |
| `message.broadcast` | routeBroadcast completes | `from`, `messageId`, `deliveredTo`, `skippedNoChannel` |
| `message.team` | routeTeam completes | `from`, `team`, `messageId`, `deliveredTo`, `skippedNoChannel` |
| `ping.tick` | Ping interval fires | `agentCount`, `evictedCount` |

### 5.6 MCP Tools

| Tool | Maps to Hub Action |
|------|--------------------|
| `whoami` | Local only (no hub round-trip) |
| `register` | `register` |
| `send_message` | `send` |
| `broadcast` | `broadcast` |
| `send_team` | `send_team` |
| `join_team` | `join_team` |
| `leave_team` | `leave_team` |
| `list_agents` | `list_agents` |
| `list_teams` | `list_teams` |
| `ping` | `ping` |
| `hub_events` | `query_events` |

## 6. Data Model

All state is in-memory. Nothing is persisted to disk unless an external store is configured.

### 6.1 Agent Registry

```
Map<string, {
  fullName: string          // "claude-net:andrew@laptop"
  shortName: string         // "claude-net"
  user: string              // "andrew"
  host: string              // "laptop"
  ws: { send(data): void }  // live connection reference
  wsIdentity: object        // stable raw WS reference for identity comparison
  teams: Set<string>        // current team memberships
  connectedAt: Date
  lastPongAt: number        // epoch ms; updated on each native WS pong
  channelCapable: boolean   // from plugin's MCP initialize capabilities
}>
```

Keyed by `fullName`. Supports lookup by full name (exact), `session:user` (cross-host), `user@host` (cross-session), or plain name (ambiguous if multiple matches).

### 6.2 Disconnected Agents

```
Map<string, {
  fullName: string
  teams: Set<string>
  disconnectedAt: Date      // membership expires after disconnectTimeoutMs (default 2h)
}>
```

Only populated for agents that had team memberships at disconnect. If the agent reconnects with the same name within the grace window, memberships are restored. After expiry, the entry is removed and memberships are released.

### 6.3 Teams

```
Map<string, Set<string>>   // team name -> set of agent fullNames
```

Teams are created implicitly when the first agent joins and deleted when the last member leaves.

### 6.4 Mirror Sessions

```
Map<string, {
  sid: string               // UUID
  ownerAgent: string        // fullName of the mirror-agent that owns this session
  cwd: string               // working directory at session start
  createdAt: Date
  lastEventAt: Date
  transcript: MirrorEventFrame[]  // ring buffer, max 2000 events
  closedAt: Date | null
  agent: AgentConnection | null   // live mirror-agent WS
  watchers: Set<SessionWatcher>   // live dashboard WS connections
}>
```

Sessions are created by the mirror-agent on `session_start` hook. They persist until explicitly closed or until the orphan sweeper removes sessions with no agent and no recent events (default 30 min).

### 6.5 Host Registry

```
Map<string, {
  hostId: string
  user: string
  hostname: string
  home: string
  recentCwds: string[]
  allowDangerousSkip: boolean
  connectedAt: Date
  ws: HostWs
}>
```

One entry per connected host daemon. Cleared on daemon disconnect.

### 6.6 Event Log

In-memory ring buffer, default capacity 10,000 entries. FIFO eviction when full. Not persisted across hub restart. Configurable via `eventLogCapacity` in `createHub`. Exposes `push`, `query` (with prefix event filter, `since` timestamp, `limit`, and agent substring filters), `summary` (counts by type), and `oldestTs`.

## 7. Deployment

### 7.1 Hub Deployment

The hub runs as a Docker container:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/
COPY bin/ ./bin/
RUN bun build --target=bun ./src/mirror-agent/agent.ts \
    --outfile ./bin/mirror-agent.bundle.js
ENV CLAUDE_NET_PORT=4815
EXPOSE 4815
CMD ["bun", "run", "src/hub/index.ts"]
```

Using Docker Compose (production):

```bash
docker compose up -d          # pulls ghcr.io/andrewleech/claude-net:latest
docker compose pull && docker compose up -d  # update to latest
```

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_NET_PORT` | 4815 | Listen port |
| `CLAUDE_NET_HOST` | — | Canonical host address used in setup scripts and upgrade hints |
| `CLAUDE_NET_TLS_CERT` | — | Path to TLS certificate (enables HTTPS/WSS when set with KEY) |
| `CLAUDE_NET_TLS_KEY` | — | Path to TLS private key |
| `CLAUDE_NET_UPLOADS_DIR` | — | Directory for paste upload files |

### 7.2 Client Setup

On any LAN machine with Claude Code installed:

```bash
curl http://<hub-address>:4815/setup | bash
```

This registers the claude-net MCP server. Restart Claude Code to load the plugin.

For inbound message delivery, Claude Code must be launched via `claude-channels` (which patches the binary for the `claude/channel` capability):

```bash
install-channels   # one-time setup, fetched from hub at /bin/install-channels
claude-channels    # replaces `claude` as the session launcher
```

### 7.3 Mirror-Agent Setup

The mirror-agent daemon launches automatically when using `claude-channels`. It requires no separate setup. The daemon starts on first session open and shuts down when idle (default 30 min with no active sessions).

### 7.4 Prerequisites

- **Hub machine:** Docker
- **Client machine:** Bun runtime, Claude Code CLI
- **Network:** LAN connectivity between client and hub on port 4815

## 8. Security

| Property | Design |
|----------|--------|
| **Authentication** | None. Network visibility is the security boundary. Anyone who can reach port 4815 can register and send messages. |
| **Identity spoofing** | Prevented. The hub stamps the `from` field on all messages using the sender's registered identity. Agents cannot set their own `from`. |
| **Transport encryption** | None by default. Enable via `CLAUDE_NET_TLS_CERT` / `CLAUDE_NET_TLS_KEY` env vars, or use a reverse proxy (nginx, Caddy) or VPN (Tailscale, WireGuard). |
| **Dashboard access** | Open. Anyone with browser access to the hub can view agent activity and send messages. Intentional for LAN use. |
| **Agent trust model** | Peer-to-peer. Agents should treat inbound messages as requests from peers, not trusted instructions. The plugin's MCP `instructions` string communicates this to Claude. |
| **Mirror inject rate limiting** | Inject and paste endpoints are rate-limited per watcher to prevent session flooding. |

## 9. Key Design Decisions

### No message persistence

Messages are not stored. If the recipient is offline, delivery fails and the sender is informed immediately. The 2-hour team membership timeout is the only temporal state held in memory.

**Rationale:** LAN-scale use with co-located sessions. Agents that need to coordinate are expected to be online simultaneously. Avoiding storage eliminates replay ordering, dedup, and retention complexity.

### No authentication

Network isolation provides the trust boundary. Adding auth would require key distribution across sessions, which conflicts with the zero-config goal.

**Rationale:** The target deployment is a developer's LAN or VPN. If the hub is exposed to an untrusted network, a reverse proxy with auth should be placed in front.

### Single process hub

All hub functionality runs in one Bun process. No message queues, no worker pools, no separate services.

**Rationale:** The scale target is tens of agents. A single process on Bun handles this with sub-millisecond routing latency. The elimination of IPC reduces failure modes.

### Plugin served from URL

The plugin is a single TypeScript file served by the hub and fetched by `bun run <url>` at each session start. No local installation, no version management.

**Rationale:** Ensures all clients run the same plugin version. The hub compares `plugin_version` on register and returns an upgrade hint when the client is out of date. Bun's URL-execution capability makes this practical.

### Hub-stamped identity

The `from` field on all messages is set by the hub, not by the sending agent. This prevents identity spoofing in a system with no authentication.

**Rationale:** Without auth, any connected agent could claim any identity. Hub-stamping ties `from` to the WebSocket connection's registered name.

### Mirror-agent daemon is separate from the MCP plugin

The mirror-agent is a standalone long-running process, not embedded in the MCP plugin subprocess. It survives Claude Code restarts, `/clear` commands, and plugin crashes. It communicates with the hub using the standard agent WebSocket protocol (registering as `session:user@host` on `/ws`) rather than a separate channel.

**Rationale:** A plugin subprocess lives and dies with each Claude Code session. Session mirroring needs continuity across those boundaries — the daemon tails the JSONL transcript and deduplicates events to fill any gaps from restarts. Reusing the existing `/ws` protocol avoids a separate WebSocket endpoint for daemon connections.

### EventLog ring buffer for runtime observability

All significant hub events (agent lifecycle, message outcomes, evictions, version mismatches) are pushed to an in-memory ring buffer. Agents and operators can query it via the `hub_events` MCP tool or `GET /api/events`. The dashboard receives every entry in real time via `system:event` broadcast.

**Rationale:** Provides diagnostic capability without SSH access, log file tailing, or persistent storage. The bounded buffer (default 10,000 entries) covers several hours of typical traffic. Ephemeral by design — this is runtime observability, not an audit log.

### WS ping/pong liveness detection

The hub sends native WebSocket pings to every registered plugin every 5 seconds. Agents whose last pong is older than 15 seconds are evicted: the hub closes the connection, which routes through the normal close handler (unregister, dashboard broadcast, event log entry).

**Rationale:** Without liveness detection, half-open TCP connections (network partition, client crash without FIN) leave ghost entries in the registry indefinitely. The 3× ping-to-threshold ratio gives slack for scheduler jitter while bounding the detection window to ~15 seconds.
