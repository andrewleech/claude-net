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
    dashboard.html    # built-in monitoring dashboard
  plugin/
    plugin.ts         # MCP stdio server — bridges Claude Code to hub via WebSocket (single-file, served by hub)
  shared/
    types.ts          # shared type definitions (frames, events, data models)
bin/
    claude-channels   # launcher — patches Claude Code binary to enable channels without CLI flags
    patch-binary.py   # same-length binary patcher (5 patches for channel restrictions)
    install-channels  # installer for claude-channels on other hosts
    statusline.py     # custom statusline with clock emoji, rate limits, claude-net status
    install-statusline # installer for the statusline script
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

## Plugin

`src/plugin/plugin.ts` is a single self-contained file served by the hub at `GET /plugin.ts`. It runs on client machines as an MCP stdio subprocess, connecting back to the hub via WebSocket. It cannot import local project files — types are duplicated inline.

The setup endpoint (`GET /setup`) generates a shell script that downloads the plugin to a temp file and registers it with Claude Code's MCP config.

## Binary Patcher

`bin/claude-channels` patches the Claude Code binary to enable channels without manual CLI flags. See `docs/CLAUDE_CODE_PATCHING_GUIDE.md` for technical details. Patches are same-length replacements (file size must not change or the Bun binary breaks). Patched binaries are cached by hash at `~/.local/share/claude-channels/`.

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
