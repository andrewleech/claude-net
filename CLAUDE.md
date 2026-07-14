# CLAUDE.md

## Commands

```
bun install          # install dependencies
bun run dev          # start hub with --watch
bun test             # run all tests
bun run lint         # biome check
bun run fmt          # biome format
```

## Architecture

```
src/
  hub/
    index.ts          # entry point — wires registry, teams, router, starts Elysia
    registry.ts       # agent registry (register, unregister, resolve, disconnect timeout)
    teams.ts          # team membership (join, leave, list)
    router.ts         # message routing (direct, broadcast, team)
    ws-plugin.ts      # WebSocket handler for /ws (agent connections)
    ws-dashboard.ts   # WebSocket handler for /ws/dashboard (dashboard live updates + virtual dashboard agent)
    api.ts            # REST API routes under /api/*
    setup.ts          # GET /setup — shell script for MCP registration
    dashboard.html    # built-in monitoring dashboard + /mirror/:sid single-session view
    mirror.ts         # mirror-session registry + /api/mirror/* + /ws/mirror/{sid}
  plugin/
    plugin.ts         # MCP stdio server — bridges Claude Code to hub via WebSocket (single-file, served by hub)
  mirror-agent/      # local daemon: accepts hook POSTs, streams to hub, handles inject
    agent.ts          # entry point
    hook-ingest.ts    # hook JSON → MirrorEventFrame
    jsonl-tail.ts     # tail Claude Code transcript JSONLs for reconciliation
    hub-client.ts     # reconnecting WS client per mirror session
  shared/
    types.ts          # shared type definitions (frames, events, data models)
bin/
    claude-channels   # launcher — patches Claude Code binary (via cc-patcher + claude-net-patcher), auto-spawns mirror-agent if enabled
    install-channels  # installer for claude-channels + mirror binaries on other hosts; also pip-installs cc-patcher + claude-net-patcher
patcher-ext/
    claude_net_patcher/  # claude-net's channel + workflow-gate patches, provided to the cc-patcher engine as a `cc_patcher.patches` entry point
    statusline.py     # custom statusline with clock emoji, rate limits, claude-net status
    install-statusline # installer for the statusline script
    claude-net-mirror-push  # tiny hook forwarder — stdin JSON → loopback POST to mirror-agent
    claude-net-mirror-agent # entry launcher for the mirror-agent daemon; `… inject <text>` POSTs to /inject
tests/
  hub/               # unit tests for each hub module
  plugin/            # plugin unit tests
  shared/            # type tests
  integration/       # end-to-end tests (real hub + WebSocket clients)
```

Path alias: `@/*` maps to `./src/*` (configured in tsconfig.json).

## Agent Naming

Format: `session:user@host` (e.g. `claude-net:andrew@laptop`).

Resolution modes (most to least specific):
- `session:user@host` — exact match
- `session:user` — across hosts
- `user@host` — across sessions
- plain string — tries session, then user, then host

Name persistence and `/rename` sync:
- The plugin persists the last-registered name next to the CC transcript at `~/.claude/projects/<encoded-cwd>/<sid>.claude-net.json` and restores it on `/mcp reconnect`.
- Claude Code's `/rename` writes a `custom-title` line into the session JSONL. The plugin reads it on startup and polls every 5 s while running, so claude-net auto-follows CC's renames without `/mcp reconnect`.
- The freshest of (persisted name, custom-title) wins at startup; the default `cwd-basename:user@host` is only used when neither exists.
- `/claude-net:rename <name>` is an MCP-prompt slash command that drives both surfaces in one step (calls `register(name)` and injects CC's `/rename` via the mirror-agent self-inject).

## Plugin

`src/plugin/plugin.ts` is a single self-contained file served by the hub at `GET /plugin.ts`. It runs on client machines as an MCP stdio subprocess, connecting back to the hub via WebSocket. It cannot import local project files — types are duplicated inline.

The setup endpoint (`GET /setup`) generates a shell script that downloads the plugin to a temp file and registers it with Claude Code's MCP config.

## Binary Patcher

`bin/claude-channels` patches the Claude Code binary to enable channels without manual CLI flags. Patching itself is delegated to the `cc-patcher` engine (a standalone package, sibling repo `~/cc-patcher`) plus the `claude-net-patcher` provider package (`patcher-ext/` in this repo), discovered via the `cc_patcher.patches` entry-point group — `bin/claude-channels` itself contains no patch logic. See `docs/CLAUDE_CODE_PATCHING_GUIDE.md` for technical details. Patches are same-length replacements (file size must not change or the Bun binary breaks). Patched binaries are cached by hash at `~/.local/share/cc-patcher/`, keyed on the binary's bytes plus the discovered provider registry (so installing/removing a provider invalidates the cache).

## Self-inject

`claude-net-mirror-agent inject "<text>"` lets an agent queue text at its own Claude Code prompt — useful for triggering slash commands (`/mcp reconnect`, `/clear`, `/compact`, `/resume`) that can't be invoked via a regular tool call. See `docs/SELF_INJECT.md` for the full reference, including exit codes, caveats (notably: slash commands execute silently, no `local-command-stdout` echo), and cross-session targeting.

## Testing

```
bun test                                    # all tests
bun test tests/hub/registry.test.ts         # single file
bun test tests/integration/e2e.test.ts      # integration tests
```

Tests use `bun:test` (describe/test/expect). Hub unit tests use mock WebSocket objects. Integration tests start a real hub on a random port and connect actual WebSocket clients.

Note: if the Docker hub is running on port 4815, `tests/hub/index.test.ts` will fail with EADDRINUSE. Stop the container first or run specific test files that use random ports.

## Docker

```
docker compose up -d                              # prod (pulls from ghcr.io)
docker compose -f docker-compose.dev.yml up -d    # dev (builds local, mounts src/)
```

Manual:
```
docker build -t claude-net .
docker run -p 4815:4815 claude-net
```
