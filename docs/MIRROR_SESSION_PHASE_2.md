# Mirror-Session — Phase M2: Remote Injection via tmux

**Part of:** `MIRROR_SESSION_IMPLEMENTATION_PLAN.md`
**Phase:** 2 of 4
**Estimated Time:** 1–2 days

## Goal

Allow a watcher at `/mirror/{sid}` (holding an owner token) to type a prompt in the browser and have it enter the *live* local Claude Code session as if typed at the terminal. Injection uses `tmux send-keys` because Claude Code has no official API to inject into an interactive session. First inject per session requires terminal-side user consent. The mirror-agent owns the tmux interaction; the hub is only the transport.

## Prerequisites

- [ ] Phase M1 complete and merged.
- [ ] Spec section 6 ("Remote input injection") re-read.
- [ ] `tmux` installed on the user's host (most Linux/macOS dev boxes already have it).

## Codebase Patterns to Follow

**Launcher extensibility** (`bin/claude-channels`) — the existing patterns of env-based configuration, hash cache, and arg splicing apply. Tmux wrapping is *additional* environment detection and exec logic layered on top of the existing patched-binary flow.

**Result-tuple error returns** on new `MirrorRegistry.inject(...)` method — same shape as `Registry.register` etc.

**Hub → mirror-agent control frames** — reuse the WS frame convention introduced in M0/M1.

**Stderr-prefixed logging** with the `[claude-net/mirror:${sid}]` scope.

## Files to Create

- `src/mirror-agent/tmux-inject.ts` — module responsible for locating the tmux target for a given `sid` and performing the `send-keys` with correct escaping.
- `src/mirror-agent/consent.ts` — prompts for in-terminal consent on first inject per session via a `Notification`-style local hook message; tracks consent state per `sid` in memory.
- `tests/mirror-agent/tmux-inject.test.ts` — unit tests with a fake `tmux` binary on `$PATH`.
- `tests/integration/mirror-inject.test.ts` — inject flow hub → mirror-agent → (fake tmux).

## Files to Modify

- `bin/claude-channels` — if `claudeNet.mirror.enabled && claudeNet.mirror.injection === "tmux"` and `$TMUX` is unset, re-exec inside a detached tmux session (`tmux new-session -A -s claude-channels-<random> -- $SELF`) and record the tmux session name in an env var that the patched binary's hooks can surface in `SessionStart` payloads. If `$TMUX` is already set, use the existing tmux session.
- `src/hub/mirror.ts` — add `POST /api/mirror/{sid}/inject` (owner-token-gated) and relay via `WS /ws/mirror/{sid}` to the mirror-agent as a `MirrorInjectFrame`.
- `src/mirror-agent/agent.ts` — handle inbound `MirrorInjectFrame`; dispatch through `consent.ts` → `tmux-inject.ts`; on success emit a `MirrorEventFrame` of kind `notification` with text "[mirror] inject from <watcher>" for auditability in the transcript.
- `src/hub/dashboard.html` — unhide compose box on `/mirror/{sid}` when the page holds an owner token; wire submit to `POST /api/mirror/{sid}/inject`. Show a status strip above compose with connection state, consent state, and injection mode.
- `src/plugin/plugin.ts` — add `mirror_consent` tool to re-arm consent (`reset`, `always`, `never`, `ask-every-time`). Default remains `ask-first-per-session`.
- `docs/CLAUDE_NET_SPEC.md` — extend FR-8 with injection endpoint and frame types.
- `README.md` — mention the tmux requirement and the consent flow.

## Key Requirements

1. **Transparent tmux wrap**: when the user runs `claude-channels` in a plain terminal, the visual experience is unchanged. The launcher creates a uniquely-named detached tmux session, attaches stdin/stdout/stderr, and execs claude inside it. On exit, the tmux session is destroyed. If the user is *already* inside tmux (`$TMUX` set), we use their existing session and a unique window.
2. **Session → tmux mapping**: mirror-agent records the tmux `session:window.pane` target for each claude session (passed through via env or a sidechannel written by the launcher). `inject()` targets that pane.
3. **Injection safety**:
   - Escape the prompt correctly for `send-keys`: use the `-l` literal mode to avoid interpreting special keys, then send `Enter` as a separate `send-keys` call.
   - Rate-limit inject calls (max 1 per 250ms per session) to prevent run-on input.
   - Reject empty or whitespace-only prompts.
   - Enforce a hard upper length (default 32 KB — generous but bounded).
4. **First-inject consent**:
   - On first `inject` for a session where consent is `ask-first-per-session` (default) or `ask-every-time`, mirror-agent emits a local console message (via `Notification`-style path) to the terminal Claude is running in: `[mirror] inject from <watcher> — accept? (Enter within 5s to accept, Ctrl+C to reject)`.
   - How: mirror-agent writes a special marker file (`/tmp/claude-net/consent-<sid>.req`); the consent process runs on the terminal side by the mirror-agent's own bash helper that the launcher sets up to read from a consent FIFO. Implementation detail — design in the `consent.ts` module.
   - If rejected or timed out, the inject returns an error; watcher sees a toast "Rejected by user".
   - Once accepted, subsequent injects in the session pass silently.
5. **Compose UX**:
   - Textarea with Shift+Enter for newline, Enter to send (mimic chat convention).
   - Pending-send spinner while awaiting ack from mirror-agent.
   - Disable compose if token is reader-only or if status strip reports tmux unavailable.
   - On `Injection disabled (not in tmux)`, the compose box surface message includes a "Pause and hand off to headless?" button — disabled by default, documented but intentionally unimplemented in M2 (it's a big UX change and belongs in its own phase).
6. **Audit trail**: every successful inject appears in the transcript as a `notification` event with watcher identity and timestamp. No silent injections.

## Integration Points

- The tmux launcher wrap must coexist cleanly with the existing patched-binary flow. Specifically: if we re-exec ourselves inside tmux, the re-exec must NOT re-trigger the "should I tmux-wrap?" branch (guard with a `CLAUDE_NET_IN_TMUX_WRAP=1` env var).
- The owner token from M1 is the auth for the inject endpoint. Reader tokens (M3) never authorize inject.
- Transcript audit entries are regular `MirrorEventFrame`s — no new frame type needed.

## Implementation Guidance

**Solution Quality Standards:**
- Implement general solutions that work for all valid inputs, not just test cases.
- Use standard tools directly; avoid creating helper scripts as workarounds.
- If requirements are unclear or tests appear incorrect, note this for the implementer to raise with the user.

**Tmux detection strategy.** Priority:
1. `$TMUX` set → use existing session; create a dedicated window named `claude-channels-<pid>`.
2. `$TMUX` unset, tmux in `$PATH`, `claudeNet.mirror.injection === "tmux"` → detached new-session wrap.
3. `claudeNet.mirror.injection === "tmux"` but no tmux available → print a clear message and exec claude directly; mirror is read-only for this invocation. `mirror_status` reports `injection: "unavailable"`.
4. `claudeNet.mirror.injection === "none"` → never wrap (read-only mirror only).

**Consent FIFO design.** The consent mechanism must not rely on the patched claude binary exposing any new hooks. Use:
- A helper `claude-net-mirror-consent-listener` that the launcher spawns in the same tty/pty as claude (not as claude's child, but sharing stdin — tricky; alternative: display consent via `tmux display-popup` when we're inside tmux anyway).
- Prefer the `tmux display-popup` approach in M2 since we already mandate tmux for inject. Fallback to stderr print for non-tmux (read-only anyway).

**Ordering guarantee.** An inject frame carries a monotonically increasing `seq` within a session; the mirror-agent processes injects strictly in seq order and rejects out-of-order frames (returns "retry" to the watcher, which re-sends with fresh seq).

**Safety valve.** A global kill-switch env var `CLAUDE_NET_NO_INJECT=1` on the launcher environment disables all inject, regardless of settings — for users who want mirror for visibility only.

## Testing Strategy

**What to Test:**

- Tmux detection precedence (env var / tmux present / settings value).
- `tmux-inject.ts` correctly escapes payloads containing quotes, newlines, backticks, backslashes, and unicode.
- Rate limiter drops bursts; returns correct error to watcher.
- Consent flow: accept / reject / timeout all produce correct outcomes and transcript audit entries.
- End-to-end inject: spawn a fake `tmux` binary on `$PATH` that records `send-keys` invocations; push an inject frame from hub to mirror-agent; assert the fake records the expected commands.
- Reader token cannot inject (403/401 with informative error).
- `CLAUDE_NET_NO_INJECT=1` disables inject end-to-end.

**How to Test:**

- `bun test tests/mirror-agent/tmux-inject.test.ts` — unit.
- `bun test tests/integration/mirror-inject.test.ts` — integration.
- Manual: real tmux, real claude-channels, inject "hello" from a phone browser — verify it enters the local REPL.
- Manual: no tmux on PATH — verify graceful degradation (compose box disabled, clear message).
- Manual: inject consent flow — first inject pops the popup, accept; second inject passes silently.
- Manual: kill the mirror-agent mid-inject — verify the hub returns an error to the watcher within 2s.

**Success Criteria:**

- [ ] Watcher can inject a prompt and see it enter the local REPL exactly once.
- [ ] First inject per session requires consent; subsequent injects pass.
- [ ] Compose box is disabled with a clear message when tmux is not available.
- [ ] Reader token cannot inject.
- [ ] Audit entry appears in transcript for every successful inject.
- [ ] Unit + integration tests green.
- [ ] `bun run lint` green.

## Dependencies

**External:** `tmux` at runtime on the user's host. Not a bundled dependency; documented as required for injection.

**Internal:** Phase M1 infrastructure (mirror-agent, `MirrorRegistry`, owner token).

## Risks and Mitigations

- **Risk:** User doesn't have tmux; finds the requirement annoying.
  - **Mitigation:** Read-only mirror still works without tmux (everything M1 offers). Injection is opt-in and explicitly annotated. M4 will remove the tmux dependency.
- **Risk:** tmux `send-keys` escaping is subtle; a malicious payload could break out.
  - **Mitigation:** Use `send-keys -l` literal mode for content and send `Enter` separately. Write an exhaustive escaping test matrix.
- **Risk:** Consent popup conflicts with tmux copy-mode / user's current interaction.
  - **Mitigation:** Popup is modal but short-lived (5s timeout); configurable via `claudeNet.mirror.consentTimeoutMs`.
- **Risk:** Injection while claude is mid-tool-call corrupts state.
  - **Mitigation:** `send-keys` only delivers characters — claude's REPL buffers them as typed input, which it only acts on when prompt-ready. (Same as the user typing ahead.)
- **Risk:** Users type in the local terminal *and* someone injects — two prompts interleave.
  - **Mitigation:** Documented behavior. Audit log in transcript shows exactly what came from where.

## Next Steps

After completing this phase:
1. Run the testing strategy and verify all success criteria.
2. Commit on `feat/mirror-m2-tmux-inject`.
3. Proceed to `MIRROR_SESSION_PHASE_3.md` for hardening, or pause here and ship M1+M2 as the initial public release.
