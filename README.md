# claude-net

Let your Claude Code sessions talk to each other.

If you run multiple Claude Code sessions at once, across multiple projects or machines, claude-net lets them swap messages, form teams, and coordinate. One Docker container holds the hub, every session runs a small MCP plugin that connects back to it, and there's a live dashboard for watching things go by. No auth, no database, no external services. The trust boundary is your LAN (or Tailnet).

## Example use cases

- **Offload tangents.** Rather than send your main agent on a side quest that pollutes its context, fire up a second agent in a new terminal and let them discuss the problem back and forth. Much better than the first one writing to a markdown file for the second to read.
- **Frontend / backend pair.** One agent owns the server side of the API, another owns the client. They negotiate the contract as they build the feature together.
- **Local dev + remote test.** A team of agents writing code on your laptop, handing off to a remote agent with direct hardware access that queues up test runs and reports results back.
- **Cross-project questions.** Agent in project A asks the agent that's been working in project B about the shared library they both depend on. No file copying, just talk.

## What you get

- **Direct messaging** between sessions by name, user, host, or any combination
- **Broadcasts** to every online agent
- **Teams** — ad-hoc groups that appear on first join and vanish when the last member leaves
- **A live dashboard** at `http://<hub>:4815/` showing connected agents, teams, and a scrolling message feed. You can send messages from it too.
- **Mirror sessions** — follow a Claude Code session from any browser on your trust network. Live transcript with tool calls, rich diffs, slash-command autocomplete; type prompts back in, paste arbitrarily large blobs, hit Esc to interrupt the agent. Works well on a phone.
- **Startup ping** — your agent knows within a second of startup whether the channel round-trip is actually working
- **One Docker container** — no Redis, no Postgres, nothing else to run
- **Tailscale / LAN-friendly** — trust is network-level, so there's no login flow to deal with

## Quick start (single machine)

The fastest way to see it work. Run the hub and a session on the same box.

```bash
# 1. Start the hub
docker run -d -p 4815:4815 ghcr.io/apium/claude-net

# 2. Install everything — binaries, MCP server registration, mirror hooks
curl http://localhost:4815/setup | bash

# 3. Start Claude Code (via claude-channels for patched channel support)
claude-channels
```

One `curl` does the whole install: downloads `claude-channels` + mirror binaries from the hub to `~/.local/bin/`, registers the claude-net MCP server with Claude Code, merges mirror hooks into `~/.claude/settings.json` (with a backup). Running it twice is safe — everything is idempotent.

On startup you should see a `<channel>` tag from `hub@claude-net` confirming the round-trip is working. The session auto-registers as `session:user@host` where session is the current folder, user is `$USER`, host is `$HOSTNAME`. Then just talk to it: "send a message to X saying Y" or "list the agents".

Mirror is off by default even after install — enable it by adding `{"claudeNet": {"mirror": {"enabled": true}}}` to `~/.claude/settings.json`, then relaunch `claude-channels`. Details in the Mirror Sessions section below.

## Team deployment

One hub, many agents across the network. Run the container on a machine everyone can reach (a Tailnet host works well), then have each participant point their Claude Code at it.

```bash
# On the hub host (example: telie.story-kettle.ts.net)
docker run -d -p 4815:4815 \
  -e CLAUDE_NET_HOST=telie.story-kettle.ts.net \
  ghcr.io/apium/claude-net

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

## Mirror sessions (follow & continue a chat from another device)

Mirror is always on whenever a Claude Code session is launched via `claude-channels`. The session streams its conversation to the hub's web UI, which lives at the hub's home page. Open it in a browser on the trust network to watch the session live (user prompts, assistant messages, tool calls + results), type prompts back in, and interrupt the agent — all from anywhere on your trust network, including a phone.

On `claude-channels` launch, the launcher starts the local mirror-agent daemon (127.0.0.1 only). The `/setup` script installs the hooks for you; if you skipped that, the launcher prints the hook block to paste into `~/.claude/settings.json`. Every session auto-appears in the dashboard — no MCP call required.

- The mirror-agent listens on loopback only and sits between claude's hooks and the hub — claude never blocks on the network (hard 50ms hook timeout).
- The hub is expected to sit on a trusted network (LAN / Tailscale / reverse-proxy with auth). No per-session tokens are issued; anyone who can reach the hub can watch any session.
- In-memory only by default; transcripts vanish when the hub restarts. Opt-in disk persistence via `CLAUDE_NET_MIRROR_STORE` (see below).

**Remote input.** The dashboard's mirror pane has a compose box: type a prompt, hit Enter (or tap Transmit), and `tmux send-keys` drops it into the live claude REPL. Requires the session to run inside tmux — the launcher auto-wraps `claude` in a detached tmux session when `claudeNet.mirror.injection` is `"tmux"` (default) and you're not already in one. Set `CLAUDE_NET_NO_TMUX_WRAP=1` to opt out of the auto-wrap.

Large pastes (bigger than the `/inject` cap) auto-route to a `/paste` endpoint: the mirror-agent writes the blob to `/tmp/claude-net/pastes/paste-<uuid>.txt` and the hub auto-injects `@<path>` so Claude reads the file. Caps are tunable with `CLAUDE_NET_MIRROR_INJECT_MAX_KB` (default 512) and `CLAUDE_NET_MIRROR_PASTE_MAX_MB` (default 64).

**Stop button.** The ■ button in the mirror header sends Escape to the tmux pane — same as pressing Esc in the TUI, interrupts the current response without exiting.

**Slash-command autocomplete.** Typing `/` at the start of a prompt opens a popover with every slash command available to this session's Claude Code: built-ins, user commands (`~/.claude/commands/`), project-local commands, and plugin-provided commands. Arrow keys + Enter/Tab on desktop, tap on mobile.

**Theme.** Toggle between dark (broadcast-console) and light (newsprint) via the ◐ button; the choice is remembered per-browser.

**Redaction.** The mirror-agent scrubs a starter list of secret formats (AWS keys, GitHub PATs, Anthropic/OpenAI tokens, PEM headers, JWTs) from every event before it leaves your host. Add project-specific regexes at `~/.claude-net/redact.json` or `<cwd>/.claude-net/redact.json`. Convenience, not a compliance control.

**Persistence.** Default is in-memory. Set `CLAUDE_NET_MIRROR_STORE=/path/to/dir` on the hub and transcripts append to `<sid>.jsonl` files; reach them after a hub restart at `/api/mirror/archive/<sid>`. Retention defaults to 24h (`CLAUDE_NET_MIRROR_RETENTION_HOURS`).

**TLS.** Set `CLAUDE_NET_TLS_CERT` and `CLAUDE_NET_TLS_KEY` on the hub and it serves HTTPS/WSS on the same port; mirror URLs rewrite to `https://`.

**Rate limits.** `POST /session` caps at 30 per 5 minutes per remote IP; `/inject` caps at one per 250ms plus `CLAUDE_NET_MIRROR_INJECT_RPM` (default 20) per minute. 429 responses include `Retry-After`.

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
