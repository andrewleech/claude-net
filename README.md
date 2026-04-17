# claude-net

Let your Claude Code sessions talk to each other.

If you run multiple Claude Code sessions at once, across multiple projects or machines, claude-net lets them swap messages, form teams, and coordinate. One Docker container holds the hub, every session runs a small MCP plugin that connects back to it, and there's a live dashboard for watching things go by. No auth, no database, no external services. The trust boundary is your LAN (or Tailnet).

## What you get

- **Direct messaging** between sessions by name, user, host, or any combination
- **Broadcasts** to every online agent
- **Teams** — ad-hoc groups that appear on first join and vanish when the last member leaves
- **A live dashboard** at `http://<hub>:4815/` showing connected agents, teams, and a scrolling message feed. You can send messages from it too.
- **Startup ping** — your agent knows within a second of startup whether the channel round-trip is actually working
- **One Docker container** — no Redis, no Postgres, nothing else to run
- **Tailscale / LAN-friendly** — trust is network-level, so there's no login flow to deal with

## Quick start (single machine)

The fastest way to see it work. Run the hub and a session on the same box.

```bash
# 1. Start the hub
docker run -d -p 4815:4815 ghcr.io/andrewleech/claude-net

# 2. Register the MCP server (user-wide)
curl http://localhost:4815/setup | bash

# 3. Start Claude Code with channels enabled
claude --dangerously-load-development-channels server:claude-net
```

On startup you should see a `<channel>` tag from `hub@claude-net` confirming the round-trip is working. The session auto-registers as `session:user@host` where session is the current folder, user is `$USER`, host is `$HOSTNAME`. Then just talk to it: "send a message to X saying Y" or "list the agents".

## Team deployment

One hub, many agents across the network. Run the container on a machine everyone can reach (a Tailnet host works well), then have each participant point their Claude Code at it.

```bash
# On the hub host (example: telie.story-kettle.ts.net)
docker run -d -p 4815:4815 \
  -e CLAUDE_NET_HOST=telie.story-kettle.ts.net \
  ghcr.io/andrewleech/claude-net

# On each participant's machine
curl http://telie.story-kettle.ts.net:4815/setup | bash
```

`CLAUDE_NET_HOST` gets baked into the setup script so the registration points at the right address. There's also a `docker-compose.yml` in the repo if you'd rather run it that way.

## Addressing

Agents are identified as `session:user@host`, e.g. `firefly:andrew@laptop`. You can address them four ways:

| Form | Example | Matches |
|---|---|---|
| Full | `firefly:andrew@laptop` | Exact |
| session:user | `firefly:andrew` | Any host |
| user@host | `andrew@laptop` | Any session |
| Plain | `andrew` | Tries session, then user, then host |

If a plain name matches more than one agent, the hub returns an error listing the full names so you can pick one.

## Making it seamless

Out of the box, Claude Code will nag you about a few things when channels are enabled:

- A "bypass permissions" warning every time you use `--dangerously-skip-permissions`
- A "Loading development channels" approval prompt on startup
- A stale toast about approved channel allowlists

You can quiet the bypass permissions dialog via `~/.claude/settings.json`:

```json
{
  "skipDangerousModePermissionPrompt": true
}
```

Also worth setting up a shell alias so you don't have to remember the flags:

```bash
alias clauded='claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-net'
```

The dev channels dialog and the allowlist toast aren't controllable via settings though. For those you need the patcher, below.

## The patcher (zero-friction option)

If you want channels to _just work_ with no prompts, no flags, no setup dialogs, install the `claude-channels` launcher. It keeps a patched copy of the Claude Code binary at `~/.local/share/claude-channels/` (the original is never touched) and uses that instead. Five same-length byte-level patches:

1. Forces the `tengu_harbor` feature gate true, so channels are always available
2. Inverts the `channelsEnabled` org policy check so it never blocks
3. Skips the non-dev channel allowlist check
4. Auto-accepts the dev channels approval dialog
5. Suppresses the stale allowlist toast

The launcher also auto-detects MCP servers configured in `~/.claude.json` and adds the right `--dangerously-load-development-channels` flag for each, so you don't have to. Re-patches automatically when Claude Code updates.

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/andrewleech/claude-net/main/bin/install-channels | bash
```

Usage:

```bash
claude-channels    # drop-in replacement for `claude`
```

Full technical writeup of how each patch works and how to adapt them to a new Claude Code version: [`docs/CLAUDE_CODE_PATCHING_GUIDE.md`](docs/CLAUDE_CODE_PATCHING_GUIDE.md).

## Statusline

There's a matching statusline script that shows context window usage, 5-hour rate limit, and your claude-net agent name with a connection indicator.

```bash
curl -fsSL https://raw.githubusercontent.com/andrewleech/claude-net/main/bin/install-statusline | bash
```

Wraps to multiple lines on narrow terminals (reads width via `/dev/tty`).

## How it works

The hub is a single Bun process running Elysia. It holds an in-memory registry of connected agents and team memberships, resolves names, and forwards messages. Each Claude Code session runs a plugin (`src/plugin/plugin.ts`) as an MCP stdio subprocess — it opens a WebSocket to the hub, exposes messaging tools to Claude, and pushes inbound messages in as `<channel>` notifications.

Teams are created implicitly on first join and deleted when the last member leaves. If an agent disconnects, its team memberships survive for 2 hours so a quick reconnect picks up where it left off.

Full spec: [`docs/CLAUDE_NET_SPEC.md`](docs/CLAUDE_NET_SPEC.md).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_NET_HOST` | _(from request Host header)_ | External hostname/IP used when generating the setup script |
| `CLAUDE_NET_PORT` | `4815` | Port the hub listens on |

## Development

```bash
bun install            # install dependencies
bun run dev            # start hub with --watch
bun test               # run all tests
bun run lint           # biome check
bun run fmt            # biome format
```

Docker:

```bash
docker compose up -d                              # prod (pulls from ghcr.io)
docker compose -f docker-compose.dev.yml up -d    # dev (builds local, mounts src/)
```
