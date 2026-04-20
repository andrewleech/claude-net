# Mirror-Session — Phase M4: Patched IPC Injection (Opt-in)

**Part of:** `MIRROR_SESSION_IMPLEMENTATION_PLAN.md`
**Phase:** 4 of 4 — research-heavy, explicitly optional
**Estimated Time:** 3–5 days (incl. anchor spike)

## Goal

Remove the tmux dependency for remote input injection by adding a 6th same-length binary patch to Claude Code. The patch causes Claude's REPL, at each idle tick before redrawing the prompt, to check for pending content in a per-process FIFO and submit it through the same internal submit path the user's `Enter` key triggers. Injection latency drops to near-zero, the user no longer needs tmux, and the visible-typing artefact disappears.

This phase is **opt-in**: it remains behind `claudeNet.mirror.injection === "patch"`. Tmux (Phase M2) stays the default until this phase has a release or two of proof, and can always be re-selected via settings.

## Prerequisites

- [ ] Phases M1 and M2 complete; M3 strongly recommended for the production-ready security surface.
- [ ] Familiarity with `docs/CLAUDE_CODE_PATCHING_GUIDE.md`, `bin/patch-binary.py`, and `bin/claude-channels`.
- [ ] Willingness to maintain the new patch anchor across Claude Code releases. If that maintenance cost isn't acceptable, do not start M4.

## Codebase Patterns to Follow

**Patch declaration style** (`bin/patch-binary.py:1-72`):
```
PATCHES = [
  { "name": "Feature gate",
    "pattern": rb'...',
    "type": "regex_pad" | "literal" | "regex_replace",
    "replacement_prefix": b"...",
    "replacement_suffix": b"}",
    "diag_anchor": b"tengu_harbor",
  },
  ...
]
```
Each patch is same-length; the replacement must occupy the exact byte count of the match. Padding with spaces is the idiomatic filler.

**Anchor hunting methodology** (`docs/CLAUDE_CODE_PATCHING_GUIDE.md`):
1. Extract the minified JS from the `.bun` section.
2. Search for stable string anchors near the target function (Statsig flag names, error strings, setting names).
3. Identify a local pattern that's unique (grep count == expected_matches).
4. Design a same-length replacement that preserves byte count exactly.
5. Verify with `--version` check and a functional test.

**Launcher cache** (`bin/claude-channels:102-141`) — patched binary is cached at `~/.local/share/claude-channels/claude-patched-<hash>`. The M4 patch participates in the same cache + re-patch-on-binary-change flow.

## Files to Create

- `src/patch-anchors/repl-idle.md` — a living document describing the chosen anchor for the REPL-idle hook, why it was chosen, the grep commands to verify it, and the procedure to re-find it on a new Claude Code release.
- `tests/patcher/m4-patch.test.ts` — unit test against a synthetic minified JS fixture containing the anchor pattern; assert `patch-binary.py` applies the replacement correctly.
- `tests/integration/mirror-patch.test.ts` — stand up a local hub + a *stubbed* claude binary (tiny Bun script with the same anchor signature) that mirrors the patched behavior; exercise the FIFO path end-to-end.

## Files to Modify

- `bin/patch-binary.py` — append the 6th patch to the `PATCHES` list. Gate its application behind a CLI flag `--enable-ipc-inject` (default off) so the patcher can still be invoked without M4 changes.
- `bin/claude-channels` — when `claudeNet.mirror.injection === "patch"`, pass `--enable-ipc-inject` to the patcher. Cache the patched output under a distinct filename (`claude-patched-ipc-<hash>`) so the standard 5-patch and 6-patch variants don't conflict.
- `src/mirror-agent/agent.ts` — when `injection === "patch"`:
  - Create `/tmp/claude-net/inject-<claude-pid>.fifo` (mkfifo, mode 0600) on session start.
  - Handle `MirrorInjectFrame` by `write`-then-`fflush`ing the prompt text (plus framing delimiter) to the FIFO.
  - No tmux involvement.
- `src/mirror-agent/fifo-inject.ts` — new module responsible for FIFO creation/write, and for tearing down on session end.
- `docs/CLAUDE_CODE_PATCHING_GUIDE.md` — append an "M4 patch" section with the anchor, replacement, verification steps, and caveats.
- `docs/CLAUDE_NET_SPEC.md` — note the new `injection: "patch"` config option.
- `README.md` — mention M4 as an opt-in alternative to tmux, with clear caveats about release-tracking maintenance.

## Key Requirements

1. **Anchor discovery.** The patch targets the REPL's idle tick — the place where claude's interactive loop waits for stdin. The anchor must be stable (a string unique enough to grep) and local to the submit-path dispatch. Document alternatives considered and rejected. If no safely-stable anchor is found after the spike, *abort the phase* and leave M2 as the injection path.
2. **Same-length replacement.** The replacement must preserve file size exactly. Use the established padding / dead-code / boolean-inversion techniques. No file-size change. Ever.
3. **FIFO framing.** Each message is length-prefixed (`LENGTH\n<bytes>`) so the reader can handle partial reads deterministically and reject garbage without hanging.
4. **FIFO lifecycle.** Created by the mirror-agent at session start with `mkfifo`, opened non-blocking by claude, cleaned up on session end. If a FIFO already exists (e.g. a prior session that crashed), it is unlink-and-recreated with 0600.
5. **Injection flow.** Web watcher → hub → mirror-agent (same path as M2) → FIFO. The patched claude reads the FIFO during its REPL idle tick; if content is present, it invokes the submit path as if the user hit Enter.
6. **Safety valve.** `CLAUDE_NET_NO_INJECT=1` also disables the patched path. The launcher reports `injection: "patch"` / `injection: "disabled"` in `mirror_status`.
7. **Consent.** Same first-inject-per-session consent as M2. Implementation is cleaner here because we can bundle a small consent dialog on the patched-claude side using the same submit path — but simplest is to *reuse* the M2 consent flow (write to a consent FIFO; mirror-agent intercepts the inject and holds it until consent arrives). Keep it consistent.
8. **Rollback.** If the patch fails to apply (pattern not found or match count wrong), the launcher *falls back* to the 5-patch cached binary and logs `[claude-net/mirror] IPC patch unavailable on this Claude Code version; falling back to tmux injection mode`. User-visible behavior regresses to M2 gracefully.
9. **Version compatibility matrix.** CI / manual test matrix documents which Claude Code versions the M4 patch has been verified against. The matrix is part of the living anchor doc.

## Integration Points

- `patch-binary.py` is invoked by `claude-channels`. M4 cleanly adds a conditional patch — the script remains a drop-in tool.
- `MirrorRegistry` and `mirror-agent`'s inject entrypoint are unchanged — the *transport* from `MirrorInjectFrame` to the local target is what differs (tmux send-keys vs FIFO write). Abstract this by making `mirror-agent` pick a "local injector" strategy on session start: `TmuxInjector` or `FifoInjector`, with a common interface `LocalInjector.inject(sid, text): Promise<InjectResult>`.
- Consent reuses M2 code.

## Implementation Guidance

**Solution Quality Standards:**
- Implement general solutions that work for all valid inputs, not just test cases.
- Use standard tools directly; avoid creating helper scripts as workarounds.
- If requirements are unclear or tests appear incorrect, note this for the implementer to raise with the user.

**Spike first.** Before writing any patch code, do a 0.5-day spike:
1. Extract the embedded JS from the current Claude Code release.
2. Hunt for the REPL idle / submit path: look for strings like "prompt", "enter", Statsig flags adjacent to input handling, function bodies that dispatch the user-submit event.
3. Evaluate two or three candidate anchors. For each, measure: (a) grep uniqueness, (b) local stability (search adjacent releases), (c) available same-length replacement budget.
4. If no anchor meets a reasonable stability bar (heuristic: the surrounding 256 bytes unchanged across the last 3 releases), **stop here** and revisit in a future release.

**Bounded risk.** M4 changes runtime behavior of the patched binary. A miscrafted patch can crash claude at startup. Protect with:
- Unit tests against fixtures (see `tests/patcher/m4-patch.test.ts`).
- Smoke test the patched binary with `claude --version` and a trivial conversation before accepting it into the cache.
- Hash the cached patched binary and verify on subsequent launches that it hasn't been touched.

**Prefer the least invasive hook possible.** The ideal anchor is a single spot where we can insert a function call to `globalThis.__CLAUDE_NET_MIRROR_TICK__()` and have that function (injected into global scope elsewhere) do the FIFO read and submit. If the anchor budget doesn't allow a function call, fall back to inlining the FIFO read directly — more brittle but possible. Document the choice.

**Don't ship this phase to everyone by default.** It is strictly `injection: "patch"` opt-in. Users pick in their settings.

## Testing Strategy

**What to Test:**

- Patch application on synthetic minified JS fixture: assert byte-for-byte equivalence, no size change, match count as expected.
- Patch application on a real Claude Code binary (current release): assert `--version` still works, conversation works, mirror inject via FIFO works.
- Rollback path: simulate a binary where the anchor is missing; assert the launcher falls back to M2 tmux injection cleanly.
- FIFO framing: send invalid framing; assert the patched reader skips it without crashing.
- End-to-end: hub + mirror-agent + real patched claude + web watcher → inject reaches the REPL within 200ms without any tmux.
- Concurrent injects: two back-to-back prompts — assert ordering is preserved.

**How to Test:**

- `bun test tests/patcher/m4-patch.test.ts` — synthetic.
- `bun test tests/integration/mirror-patch.test.ts` — integration with stub.
- Manual: real claude, real hub, real watcher — verify inject works with no tmux.
- Manual: downgrade/upgrade claude to bracketing versions; verify patch applies or falls back cleanly.

**Success Criteria:**

- [ ] Patch applies cleanly to the currently-shipping Claude Code with the expected match count.
- [ ] Inject latency (watcher → REPL) p99 < 200ms on LAN, < 20ms on loopback.
- [ ] Fallback to M2 tmux works when the anchor is missing.
- [ ] No file-size drift in the patched binary.
- [ ] Version compatibility matrix has at least three verified versions.
- [ ] All tests green; Biome green.

## Dependencies

**External:** none new at runtime. The patcher already uses Python stdlib.

**Internal:** Phases M1 + M2 (and M3 strongly recommended).

## Risks and Mitigations

- **Risk:** Anchor breaks on the next Claude Code release.
  - **Mitigation:** Living anchor doc with recovery procedure; rollback to M2 is automatic. This is the price of binary patching and must be accepted to do the phase at all.
- **Risk:** Same-length budget is too tight to insert a function call.
  - **Mitigation:** Two-level patch — one anchor loads a prelude script into global scope (enough bytes), the other is a tiny `;__n()` nop-or-call insertion at the idle tick. If neither budget works, abort.
- **Risk:** FIFO write blocks when claude isn't reading.
  - **Mitigation:** Non-blocking open on both ends; writes that would block are queued in mirror-agent and flushed on next read.
- **Risk:** A malicious local process races to write to the FIFO.
  - **Mitigation:** FIFO is 0600 and created in a per-user path. Same trust level as the mirror-agent itself.
- **Risk:** Users enable `injection: "patch"` and a release lands that breaks it — their injection silently stops working.
  - **Mitigation:** `mirror_status` clearly reports the active injection mode and any fallback. Launcher logs the fallback prominently on stderr at startup.

## Next Steps

After completing this phase (or deciding to abort it):
1. If shipped: run the full testing strategy, verify success criteria, commit on `feat/mirror-m4-patched-inject`. Release behind a config flag; track release-compat issues in GitHub.
2. If aborted: document the anchor search results in `src/patch-anchors/repl-idle.md` and close the phase. M2 tmux remains the injection path.
3. Mirror-session feature is complete after M3 (and optionally M4). Update `README.md`'s feature list and `docs/CLAUDE_NET_SPEC.md` to reflect the final surface.
