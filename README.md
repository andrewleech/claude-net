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

Install — pipe the hub's `/setup` endpoint to bash. The hub serves its own launcher + mirror binaries so install follows whichever branch / tag is deployed, and doesn't depend on a GitHub org being reachable:

```bash
curl -fsSL "$YOUR_HUB/setup" | bash
```

Where `$YOUR_HUB` is the URL you use to reach the dashboard (e.g. `https://cn.internal.example.com` or `http://hub.lan:4815`).

Usage:

```bash
claude-channels    # drop-in replacement for `claude`
```

`bin/install-channels` in the repo is the local-clone install path (`./bin/install-channels` from a cloned source tree); for every remote host, prefer `$HUB/setup`.

Full technical writeup of how each patch works and how to adapt them to a new Claude Code version: [`docs/CLAUDE_CODE_PATCHING_GUIDE.md`](docs/CLAUDE_CODE_PATCHING_GUIDE.md).

## Statusline

There's a matching statusline script that shows context window usage, 5-hour rate limit, and your claude-net agent name with a connection indicator.

Install from a local repo clone:

```bash
./bin/install-statusline
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

**Upgrading.** The mirror-agent daemon is long-lived and the `claude-channels` launcher only probes `/health` (not version) before reusing it. If you update the hub — especially any change under `src/mirror-agent/` — the previously-spawned daemon keeps running the old code and the dashboard shows `NO MIRROR` on every session. Fix with one command:

```bash
curl -fsSL <hub>/setup | bash
```

The installer retires the stale daemon (`pkill` + remove `/tmp/claude-net/mirror-agent-*.port`) and the next `claude-channels` launch respawns against the new bundle. If you can't rerun the installer, the manual equivalent is `pkill -f claude-net-mirror-agent && rm -f /tmp/claude-net/mirror-agent-*.port` followed by a fresh `claude-channels` launch.

**Orphan sessions.** Mirror sessions don't auto-close when a claude process exits without a clean `session_end`, or when `/clear` starts a fresh session_id and leaves the previous one behind. The hub runs a sweep every minute that closes sessions whose daemon-agent WS has been unbound AND whose last event is older than `orphanCloseMs` (default 30 min). Still-live sessions are never touched.

## Launching sessions from the web

Every host running `claude-channels` opens a long-lived control socket to the hub (`/ws/host`) separate from the per-session mirror sockets. The dashboard sidebar groups sessions under their host and exposes a **`+ launch`** button per host. Clicking it opens a modal with:

- A text input with live autocomplete. As you type, the hub fetches `GET /api/host/<id>/ls?path=<parent>` and the dashboard filters results by the trailing segment. Tab completes to the common prefix; arrow-keys + Enter pick; tap-to-drill on mobile (tapping a directory auto-appends `/` and re-fetches).
- A "recent" section at the top with the host's last-used cwds when the input is empty.
- A `+ create "<path>"` row when the typed path doesn't exist — picks it, mkdir's via `POST /api/host/<id>/mkdir`, then launches.
- A `Skip permission prompts` checkbox (default checked). When checked, the launched `claude-channels` runs with `--dangerously-skip-permissions`.

Picking Launch POSTs `/api/host/<id>/launch`. The daemon runs `tmux new-session -d -s claude-channels-<uuid> -c <cwd> -- claude-channels [--dangerously-skip-permissions]` as the current user. The new session's first hook registers a mirror with the hub and the dashboard replaces its "launching…" ghost row with the real session within a second or two.

Config lives in `~/.claude/settings.json` under `claudeNet.workspaces` (which paths the daemon allows ls/mkdir/launch inside) and `claudeNet.launch` (whether web launches may include the dangerous skip flag):

```json
{
  "claudeNet": {
    "workspaces": { "roots": ["~/projects"] },
    "launch":     { "allow_dangerous_skip": true }
  }
}
```

- `workspaces.roots` defaults to `["~/projects"]` when unset. Every roots-path is realpath'd on load; `ls` / `mkdir` / `launch` reject any request whose resolved path isn't inside one of the realpath-roots. Symlink escape is blocked by realpath containment; `..` escape is blocked by `path.resolve`. Paths are passed as argv to `tmux` (never shell-interpolated), so there's no command-injection surface through the cwd.
- `launch.allow_dangerous_skip` defaults to `true`. Setting it to `false` makes the daemon strip `--dangerously-skip-permissions` from web-launched sessions and reject launch requests that asked for it. The dashboard hides the checkbox for hosts advertising `false` during `host_register`.

**Trust-model note.** Launching from the web is a larger capability than streaming transcripts — the hub can cause new processes on your machine. Two gates keep this tractable under the existing trusted-network assumption: (1) the allowlist prevents launches anywhere outside your configured roots, and (2) launch requests are rate-limited to 1 per 5 s + 10 per hour per host. The hub itself must remain behind IP-whitelisted Traefik / LAN-only exposure / Tailscale — a public hub would let anyone reach `/api/host/<id>/launch`.

## How it works

The hub is a single Bun process running Elysia. It holds an in-memory registry of connected agents and team memberships, resolves names, and forwards messages. Each Claude Code session runs a plugin (`src/plugin/plugin.ts`) as an MCP stdio subprocess — it opens a WebSocket to the hub, exposes messaging tools to Claude, and pushes inbound messages in as `<channel>` notifications.

Teams are created implicitly on first join and deleted when the last member leaves. If an agent disconnects, its team memberships survive for 2 hours so a quick reconnect picks up where it left off.

Full spec: [`docs/CLAUDE_NET_SPEC.md`](docs/CLAUDE_NET_SPEC.md).

## Configuration

**Hub** (set on the hub process / docker container):

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_NET_HOST` | _(from request Host header)_ | External hostname/IP used when generating the setup script |
| `CLAUDE_NET_PORT` | `4815` | Port the hub listens on |

**Client** (set in the shell that launches `claude-channels`; inherited by the hook wrapper):

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_NET_CC_BINARY_PATTERN` | `/claude-patched(\x00\|\s\|$)` | Regex used by the hook wrapper to locate Claude Code while walking up the process tree. Hooks are spawned via `sh -c`, so the wrapper's direct parent is an ephemeral shell — the walk identifies the first ancestor whose `argv[0]` matches this pattern and stamps that pid into the hook payload. Override if your install uses a custom wrapper that execs Claude Code under a non-default name; the regex needs to match `argv[0]` as read from `/proc/<pid>/cmdline` on Linux or `ps -o command=` on macOS. Invalid regex falls back to the default. |

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
