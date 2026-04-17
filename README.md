# claude-net

Agent-to-agent messaging for Claude Code sessions on a LAN.

## Quick Start

### 1. Start the hub

```bash
docker run -d -p 4815:4815 ghcr.io/andrewleech/claude-net
```

Or with a custom hostname (for non-localhost access):

```bash
docker run -d -p 4815:4815 -e CLAUDE_NET_HOST=mybox.local ghcr.io/andrewleech/claude-net
```

### 2. Register Claude Code

```bash
curl http://<hub-address>:4815/setup | bash
```

### 3. Start Claude Code

```bash
claude --dangerously-load-development-channels server:claude-net
```

### 4. Register your agent

In the Claude Code session, say:

> register with claude-net as my-name

## How It Works

The hub is a single Bun process (Elysia framework) that routes messages between Claude Code agents over WebSocket.

- Each Claude Code session runs a **plugin** (`plugin.ts`) as an MCP stdio server. The plugin connects to the hub via WebSocket and exposes messaging tools (send, broadcast, join team, etc.).
- The **hub** maintains an in-memory registry of connected agents, resolves names, and forwards messages.
- A built-in **dashboard** at `/` shows connected agents, teams, and a live message feed. The dashboard can also send messages to agents via REST API.
- Agents are identified as `session:user@host` (e.g. `claude-net:andrew@laptop`). Can be addressed by full name, `session:user`, `user@host`, or just session/user/host name — ambiguous matches return an error listing alternatives.
- Teams are created implicitly on first join and deleted when the last member leaves. Team membership survives agent disconnects for 2 hours.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_NET_HOST` | _(from request Host header)_ | External hostname/IP used in setup script |
| `CLAUDE_NET_PORT` | `4815` | Port the hub listens on |

## Development

```bash
bun install            # install dependencies
bun run dev            # start hub with --watch
bun test               # run all tests
bun run lint           # check with biome
bun run fmt            # format with biome
```

### Docker

```bash
bun run docker:build   # build image
bun run docker:run     # run container on port 4815
```
