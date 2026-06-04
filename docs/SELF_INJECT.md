# Self-inject from inside a Claude Code session

The `claude-net-mirror-agent inject` subcommand lets a Claude Code agent
queue text at its own prompt — the same prompt the user types into. Use
this when you need to trigger something the user-prompt line is the only
entrypoint for: slash commands, follow-up prompts, system-level
operations.

---

## Short version (copy-pasteable for other agents)

> You can queue input at your own Claude Code prompt by running
> `claude-net-mirror-agent inject "<text>"` from a Bash tool call. The
> text — including slash commands like `/mcp reconnect <server>`,
> `/clear`, `/compact`, `/resume <sid>` — lands at the prompt and
> Claude Code processes it at the next prompt cycle (after the current
> turn ends). Use this when a tool call can't achieve the same effect.
> Caveats: works only on the same host inside tmux; injected slash
> commands execute but don't produce a visible `local-command-stdout`
> block; don't inject in a loop or you'll create a runaway.

---

## When to use

- **Slash commands**: `/mcp reconnect <server>` to reload a misbehaving
  MCP, `/clear` to start fresh, `/compact` to manually trigger
  compaction, `/resume <sid>` to jump to another session.
- **Follow-up prompts**: queue text that should be processed at the
  next prompt cycle, after your current turn ends.
- **Self-driven workflows**: when an agent decides it needs to take an
  action that requires the user-prompt entrypoint rather than a tool
  call.

## How

Invoke via the `Bash` tool. The CLI is on `PATH` on any host where
`claude-channels` is installed:

```bash
claude-net-mirror-agent inject "TEXT_OR_SLASH_COMMAND"
```

Or via stdin (useful for long text or text with shell metacharacters):

```bash
echo "TEXT_OR_SLASH_COMMAND" | claude-net-mirror-agent inject
```

## Concrete examples

```bash
# Reload an MCP server that's gone unhealthy
claude-net-mirror-agent inject "/mcp reconnect figma"

# Disable an MCP server
claude-net-mirror-agent inject "/mcp disable word"

# Clear context to start fresh after a big refactor
claude-net-mirror-agent inject "/clear"

# Queue a follow-up question for after the current turn
claude-net-mirror-agent inject "now write tests for that function"
```

## What happens under the hood

1. The CLI POSTs to the local mirror-agent's loopback `/inject` endpoint
   (port file at `/tmp/claude-net/mirror-agent-<uid>.port`, mode 0600).
2. The agent locates the calling session by walking the process tree
   to find Claude Code's pid (or uses `--sid`/`--pid` if specified).
3. It runs `tmux send-keys -l "<text>"` then `tmux send-keys Enter`
   against the session's pane.
4. Keystrokes land at the prompt-line buffer; Claude Code processes
   them at the next prompt-ready cycle.

## Important caveats

- **Timing**: the action does NOT execute mid-turn. It queues at the
  prompt until your current turn finishes. Injecting `/clear` will
  preserve your CURRENT turn's context — context is cleared AFTER you
  finish.
- **Slash commands run silently**: an injected `/mcp …` or other slash
  command executes correctly but does NOT appear in your context as a
  `<local-command-stdout>` block (the way it does when the user types
  it manually). Verify by side-effect — e.g., the MCP server's tools
  becoming available/unavailable.
- **Tmux required**: returns exit code 5 if the target session isn't
  running inside tmux.
- **Same host, same user**: only works against a session on the same
  machine, running as the same OS user. Use the dashboard webui for
  cross-host inject.
- **Rate limit**: one inject per session per 250 ms. Back-to-back calls
  may return exit 5.
- **Don't inject in a loop**: an injected prompt that itself causes
  another inject can create a runaway. Reserve self-inject for
  explicit user-visible actions.

## Exit codes

| Code | Meaning | What to do |
|------|---------|------------|
| 0 | Injected | Wait for current turn to end; action runs at next prompt cycle |
| 2 | Mirror-agent unreachable | mirror-agent isn't running on this host; can't use self-inject |
| 3 | No matching session | Can't find a CC session for the calling process; try `--sid` or `--pid` |
| 4 | Bad arguments | Fix the CLI invocation |
| 5 | Session not injectable | Session is closed, not in tmux, or rate-limited |

## Targeting another session

```bash
# By Claude Code session id
claude-net-mirror-agent inject --sid 3d27a058-... "/mcp reconnect figma"

# By Claude Code process id
claude-net-mirror-agent inject --pid 46524 "follow-up question"

# Custom audit label (shows in mirror-agent logs)
claude-net-mirror-agent inject --source "workflow-A" "..."
```

## When NOT to use

- **As a substitute for tool calls**: if a tool (Edit, Bash, etc.) can
  achieve the same effect, prefer the tool. Self-inject is slower
  (waits for turn end) and less observable.
- **For arbitrary cross-session messaging**: use the claude-net MCP
  plugin's `send_message` for that. Self-inject is for prompt-line
  input, not for talking to other agents.
- **In a tight loop**: rate limit applies. Spam-injects are rejected.
