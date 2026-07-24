# Migrating this work + conversation to `carbon` (native Linux, user `corona`)

Date: 2026-07-24
Why: root-cause the mpy plugin's ~31s hub-WS reconnect loop + ~3.5% idle CPU
on native Linux where `strace`/`ptrace` work (WSL blocks them), and continue
this conversation via `claude -c`.

## carbon is user `corona` — this is a PATH-REWRITE move, not a plain rsync

Source paths are `/home/anl/...`; carbon paths are `/home/corona/...`. Three
things are absolute-path-keyed and must be adapted:
1. the git **worktree link** (`claude-net-mpy/.git` → the main repo's
   `worktrees/` dir),
2. the **`claude -c` history dir** (encoded cwd `-home-anl-picolet` →
   `-home-corona-picolet`),
3. **hardcoded `/home/anl`** in test harnesses / debug repros / package script
   / CI (the plugin *runtime* is path-portable — uses `__file__`/romfs — so
   only tests+tooling need fixing).

## 1. rsync to /home/corona (note the RENAMED history dest)

```
rsync -a /home/anl/picolet/        corona@carbon:/home/corona/picolet/
rsync -a /home/anl/claude-net/     corona@carbon:/home/corona/claude-net/       # worktree link target — required
rsync -a /home/anl/claude-net-mpy/ corona@carbon:/home/corona/claude-net-mpy/   # the mpy-plugin worktree
# conversation history: source dir -home-anl-picolet -> dest RENAMED to -home-corona-picolet
rsync -a ~/.claude/projects/-home-anl-picolet/ \
         corona@carbon:/home/corona/.claude/projects/-home-corona-picolet/
```
Optional slimming (regenerable): `--exclude 'build/' --exclude 'build-*/'
--exclude '__pycache__/'`.

## 2. On carbon: repair the worktree link

The rsync'd `.git` files still point at `/home/anl/...`. `git worktree repair`
rewrites both ends for a moved worktree:
```
cd /home/corona/claude-net
git worktree repair /home/corona/claude-net-mpy
git -C /home/corona/claude-net-mpy status     # confirm it resolves
```

## 3. On carbon: rewrite hardcoded /home/anl -> /home/corona

Only tooling/tests hardcode paths (runtime is portable). Bulk-fix, then
commit as a carbon-adaptation:
```
cd /home/corona/claude-net-mpy
git grep -l /home/anl | xargs sed -i 's,/home/anl,/home/corona,g'
git commit -asm "adapt hardcoded paths for carbon (/home/anl -> /home/corona)"
# picolet repo has few/none in code, but check:
cd /home/corona/picolet && git grep -l /home/anl
```
(Longer-term these tests should derive the binary path from an env var / repo
root instead of hardcoding — worth a follow-up so the next move is a plain
rsync.)

## 4. On carbon: continue this conversation

```
cd /home/corona/picolet && claude -c
```
Resumes THIS session (history dir now `-home-corona-picolet`). The transcript
entries embed the old `cwd:/home/anl/picolet` as historical metadata — that's
fine for replay. If `-c` fails to find it, the session's stored cwd may need
adjusting; report and we'll patch the session file.

## 5. On carbon: rebuild + debug (the point of the move)

- Rebuild the mcp variant natively (after the path sed):
  `bash /home/corona/claude-net-mpy/planning/debug/build_mcp_integration.sh`
  (needs gcc/make/python3/uv/mpremote/openssl; or the ephemeral-docker
  pattern). Confirm the picolet submodule carries `integration` +
  `pr/unix-asyncio-stdin-poll-fix`.
- Root-cause the reconnect loop WITH strace (now available): run the full
  `plugin.py` idle against the hub, `strace -f -p <pid>`, and compare which
  fd/syscall the loop services vs the hub socket. Healthy baseline:
  `planning/debug/realhub_idle_probe.py` (bare client, 0.2% CPU, receives the
  5s pings). The bug: the full stack (`_hub` + mpyfastmcp + stdin shim) misses
  those pings.

## Gotchas

- **Agent name collisions:** carbon already runs `corona@carbon` agents; don't
  start same-named ones. Conversation continuation is independent of agents.
- **MCP tools on carbon:** `/home/corona/.claude.json` needs its own
  claude-net MCP entry to USE the tools (bun, NOT the mpy binary while
  debugging). The conversation resumes regardless of MCP config.
- **This host (LAP-AU-PF65PM2K):** rolled back to bun (22 agents reconnected);
  the mpy install at `~/.claude-net/bin/` is inert while config points at bun.
- **The pushed fix** (`pr/unix-asyncio-stdin-poll-fix`) is on
  `andrewleech/micropython` already — independent of this move.
