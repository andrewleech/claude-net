# Migrating this work + conversation to `carbon` (native Linux)

Date: 2026-07-24
Why: root-cause the mpy plugin's ~31s hub-WS reconnect loop + ~3.5% idle CPU
on a native Linux host where `strace`/`ptrace` work (WSL blocks them), and
continue this Claude Code conversation there via `claude -c`.

## Hard prerequisite — identical paths on carbon

`claude -c` locates history by the ENCODED cwd, and the git worktree link is
an ABSOLUTE path. Both only work if carbon has user `anl` with home
`/home/anl` (same as here). Verify before moving:
```
ssh anl@carbon 'echo $HOME; whoami'      # must be /home/anl and anl
```
If carbon's home differs, the worktree `.git` link and the `-home-anl-picolet`
history dir won't resolve without extra fixup (rewrite the worktree gitdir
pointer; rename the history dir to the new encoded cwd). Assume matched paths
below.

## What to move

Three code trees + one history dir. The git worktree makes ordering matter.

1. **picolet** (this session's cwd; runtime + micropython submodule carrying
   the `integration` branch and the local `pr/unix-asyncio-stdin-poll-fix`):
   ```
   rsync -a /home/anl/picolet/ anl@carbon:/home/anl/picolet/
   ```
2. **claude-net** (main repo — REQUIRED even though the work is in the
   worktree, because the worktree's `.git` file points into
   `/home/anl/claude-net/.git/worktrees/mpy-plugin`):
   ```
   rsync -a /home/anl/claude-net/ anl@carbon:/home/anl/claude-net/
   ```
3. **claude-net-mpy** (the `mpy-plugin` worktree — all the P0-P8 work):
   ```
   rsync -a /home/anl/claude-net-mpy/ anl@carbon:/home/anl/claude-net-mpy/
   ```
   The worktree link resolves on carbon because the absolute paths match.
4. **This conversation's history** (so `claude -c` continues it):
   ```
   rsync -a ~/.claude/projects/-home-anl-picolet/ \
            anl@carbon:~/.claude/projects/-home-anl-picolet/
   ```

Slim the transfer (all regenerable) — optional excludes:
`--exclude 'build/' --exclude 'build-*/' --exclude '__pycache__/'`. The
micropython submodule + its build dirs are the bulk; rebuild on carbon.

## On carbon — continue + verify

```
cd /home/anl/picolet && claude -c        # resumes THIS conversation
git -C /home/anl/claude-net-mpy status                 # worktree link intact?
git -C /home/anl/claude-net-mpy log --oneline -8       # P0-P8 commits present?
git -C /home/anl/picolet/packages/picolet-runtime/micropython branch  # integration + fix branch?
```

## On carbon — rebuild + debug (the point of the move)

- Rebuild the mcp variant natively (correct paths + debug info):
  `bash /home/anl/claude-net-mpy/planning/debug/build_mcp_integration.sh`
  (needs gcc/make/python3/uv/mpremote/openssl; or the ephemeral-docker
  pattern).
- Root-cause the reconnect loop WITH strace (now available):
  run the full `plugin.py` idle against the hub, `strace -f -p <pid>` and see
  which fd/syscall the event loop services vs the hub socket — the bare-client
  repro (`planning/debug/realhub_idle_probe.py`) is the healthy comparison.

## Gotchas

- **Agent name collisions:** don't run the same-named agents on both hosts
  against the hub at once. The conversation continuation is independent of
  agents.
- **MCP tools on carbon:** carbon's `~/.claude.json` needs its own claude-net
  MCP entry to USE the tools (bun, or skip — do NOT point it at the mpy binary
  while debugging). The conversation resumes regardless.
- **Rollback state:** this host (LAP-AU-PF65PM2K) has been reverted to the bun
  plugin (user-scope `claude-net` restored from
  `~/.claude.json.bak-pre-mpy-*`); agents revert on reconnect. The mpy install
  at `~/.claude-net/bin/` is inert once the config points at bun.
- **The pushed fix** (`pr/unix-asyncio-stdin-poll-fix`) is already on
  `andrewleech/micropython` (origin) — independent of the move.
