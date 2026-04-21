# Mirror-Session Implementation Plan

**Spec Source:** `docs/MIRROR_SESSION_PLAN.md`
**Complexity Assessment:** Complex
**Total Phases:** 5 (M0 – M4)
**Generated:** 2026-04-20

> **2026-04 update (dashboard restructure, Phase 1):** the token model described below has been removed. Mirror is always on when `claude-channels` runs; `claudeNet.mirror.enabled` is no longer consulted; the `mirror_on` / `mirror_off` / `mirror_status` / `mirror_url` / `mirror_share` / `mirror_revoke` / `mirror_consent` MCP tools are gone; the share / revoke REST endpoints are gone; `/mirror/:sid` no longer exists as a route — sessions appear inline in the hub dashboard. The design rationale below still reads top-down as if those features are alive; treat any mention of owner tokens, reader tokens, or consent-gate flows as historical.

## Overview

Build "mirror-session": a feature that live-streams a local Claude Code session (all user prompts, assistant messages, tool calls/results, and notifications) to the claude-net hub's web UI, and allows a remote browser on the trust network to inject new user prompts back into the live session.

The local hot path must never wait on the network — capture happens via Claude Code hooks that `POST` to a loopback mirror-agent daemon, which buffers and uploads to the hub asynchronously. Remote injection uses tmux `send-keys` initially (Phase M2), with an opt-in binary-patch IPC channel as a follow-up (Phase M4). Security rests on 128-bit per-session URL-fragment tokens, owner/reader token roles, owner pinning, optional redaction, and an explicit first-injection consent prompt — all on top of claude-net's existing LAN/Tailnet trust boundary.

## Codebase Analysis

### Current Architecture

Single-package Bun/TypeScript repo. Hub is an Elysia app composed of plugins (`apiPlugin`, `wsPlugin`, `wsDashboardPlugin`, `setupPlugin`) wired in `src/hub/index.ts:33-62`. State is purely in-memory: `Registry`, `Teams`, `Router` classes hold `Map`-based data, no database. Dashboard is a single `dashboard.html` file; it's a read-only subscriber to `WS /ws/dashboard` broadcasts. The claude-net plugin (`src/plugin/plugin.ts`) is a single-file MCP stdio server, served at `GET /plugin.ts` and fetched at install time — it cannot import `@/*` and duplicates types inline. The launcher (`bin/claude-channels`) discovers the Claude Code ELF, hash-caches same-length byte patches via `bin/patch-binary.py`, and execs the patched binary with auto-spliced MCP args.

### Integration Points

- **`src/hub/index.ts`** — register a new `mirrorPlugin` and a new `/mirror/*` static route.
- **`src/shared/types.ts`** — add `MirrorEventFrame`, `MirrorInjectFrame`, `MirrorControlFrame`, `MirrorSession`, `MirrorToken`, `MirrorEventKind`, and a `mirror:*` variant of `DashboardEvent`.
- **`src/hub/ws-dashboard.ts`** — teach the dashboard broadcaster about `mirror:*` events so watchers get live updates.
- **`src/plugin/plugin.ts`** — add `mirror_status`, `mirror_on`, `mirror_off`, `mirror_url` MCP tools (the user-facing `/mirror <sub>` spelling is a thin wrapper, but tools stay snake_case to match existing naming).
- **`src/hub/dashboard.html`** — add a `/mirror/{sid}#token=...` single-session view (client-side path-routed; same HTML file).
- **`bin/claude-channels`** — splice mirror hooks into an ephemeral settings file for the launched `claude` process when `claudeNet.mirror.enabled` is true; optionally wrap in detached tmux for Phase M2.
- **`bin/patch-binary.py`** — add a 6th patch in Phase M4 only (REPL-idle FIFO read).
- **`src/hub/setup.ts`** — extend the setup script to install the mirror-agent binary alongside the plugin registration.

### Existing Patterns to Follow

- **Elysia plugin composition** (`src/hub/index.ts:33-62`): each subsystem exports a function taking a deps object that returns (or mutates) an Elysia app. Follow this for `mirrorPlugin({ mirrorRegistry })`.
- **Class + result-tuple state modules** (`src/hub/registry.ts:55-104`, `src/hub/router.ts:20-70`): state held in a class with `Map`s; public methods return `{ ok: true; ... } | { ok: false; error: string }` — never throw on hot paths. Apply the same shape to `MirrorRegistry`.
- **Discriminated unions for frames** (`src/shared/types.ts`): `action` for plugin→hub frames, `event` for hub→plugin/dashboard frames. Mirror will add `action: "mirror_event"` and `event: "mirror_inject" | "mirror_control"`.
- **WebSocket handler pattern** (`src/hub/ws-plugin.ts:79-328`): `open`/`message`/`close` lifecycle, dispatch on `data.action`, `sendResponse(ws, requestId, ok, data?, error?)` helper, `WeakMap<wsIdentity, sid>` for identity tracking.
- **Dashboard broadcast wiring** (`src/hub/ws-dashboard.ts`): `setDashboardBroadcast(fn)` setter pattern so modules can push events without direct coupling.
- **Tokyonight palette** (`src/hub/dashboard.html:10-25`): stick to the existing CSS custom properties for the new mirror view.
- **Stderr-prefixed logging** (`src/plugin/plugin.ts:206-208`): `process.stderr.write(\`[claude-net] ${msg}\n\`)` — use `[claude-net/mirror]` and `[claude-net/mirror:${sid}]` as prefixes.
- **Test structure** (`tests/hub/registry.test.ts`, `tests/integration/e2e.test.ts`): `bun:test` describe/test/expect, mock WebSocket with `.sent` array, integration tests bind `listen(0)` and build a real Elysia app via helper.
- **Launcher extensibility** (`bin/claude-channels`): extend existing env-var resolution, hash-cache, and arg-splicing flow — don't fork.

### Potential Challenges

- **Naming inconsistency.** Existing types mix camelCase (`requestId`, `fullName`) and snake_case (`message_id`, `reply_to`). Mirror frames should follow the *protocol* convention (snake_case) for fields that cross the wire and camelCase for internal types. Document the rule in Phase M0.
- **Hook drop / ordering.** Hooks are discrete and can be skipped in some Claude Code code paths; JSONL reconciliation is needed. Plan dedupe by `uuid`.
- **Settings.json merging.** No existing code touches `~/.claude/settings.json`. The launcher must splice hooks *ephemerally* (via env-pointed override settings file) so we never mutate the user's file. Needs a clean read/merge/write-temp/exec pattern.
- **Injection has no official API.** Phase M2 (tmux) and M4 (binary patch) are the only viable paths. Phase M2 needs transparent tmux wrapping — detach/attach dance without visible reshuffling of the user's terminal.
- **Patcher fragility.** Phase M4 adds a new same-length byte patch; anchor must be re-verified on each Claude Code release. Keep M4 strictly opt-in and maintain regression tests.
- **Token leakage via browser history / devtools.** Mitigated by putting tokens in the URL fragment (never sent in `Referer` or hub access logs), but documented trade-off.
- **JSONL fsync is undocumented.** Reconciliation must tolerate partial lines (wait for `\n`) and transient gaps between hook fire and JSONL append.
- **Plugin single-file constraint.** `src/plugin/plugin.ts` can't import `@/*`. Mirror event types needed by the plugin (for `/mirror` tool metadata only — the plugin itself doesn't ship mirror events) must be duplicated inline just like existing hub frames are.
- **Performance.** 50ms hook timeout is generous but must be honored strictly. Hook forwarder `claude-net-mirror-push` must be a Bun script (cold-start ~15ms) or a statically-linked binary — not Node, not Python.

## Phase Overview

### Phase M0: Types & Scaffolding
**Goal:** Land the shared type definitions, documentation stubs, and naming convention so later phases have a stable foundation.
**Details:** See `MIRROR_SESSION_PHASE_0.md`.

### Phase M1: Outbound Read-Only Mirror
**Goal:** Every Claude Code session streams its full conversation (user prompts, assistant replies, tool calls/results, notifications) to a browser-accessible web view on the hub. No injection yet.
**Details:** See `MIRROR_SESSION_PHASE_1.md`.

### Phase M2: Remote Injection via tmux
**Goal:** A watcher at `/mirror/{sid}` with an owner token can type a prompt in the browser and have it enter the live local Claude Code session as if typed at the terminal, via tmux `send-keys`.
**Details:** See `MIRROR_SESSION_PHASE_2.md`.

### Phase M3: Security & Persistence Hardening
**Goal:** Redactor pipeline, owner/reader token roles, optional disk persistence, optional TLS, rate limiting, and a polished consent flow.
**Details:** See `MIRROR_SESSION_PHASE_3.md`.

### Phase M4: Patched IPC Injection (opt-in)
**Goal:** Remove the tmux dependency: same-length binary patch adds a REPL-idle FIFO check that submits pending prompts through Claude Code's internal submit path.
**Details:** See `MIRROR_SESSION_PHASE_4.md`.

## Testing Approach

### Unit Tests
- `tests/hub/mirror.test.ts` — `MirrorRegistry` create/get/close/token validation, owner pinning, transcript ring behavior.
- `tests/hub/mirror-redact.test.ts` (Phase M3) — redactor correctness on sample payloads.
- `tests/plugin/mirror-tool.test.ts` — plugin `/mirror` tool routes to the right hub API.
- `tests/mirror-agent/agent.test.ts` — hook ingestion, JSONL reconciliation dedupe, injection FIFO write.

### Integration Tests
- `tests/integration/mirror-e2e.test.ts` — spawn hub on random port, stand up a fake mirror-agent emitting synthetic hook payloads, connect a WS watcher, assert end-to-end ordering and dedupe.
- `tests/integration/mirror-inject.test.ts` (Phase M2) — inject a prompt from the watcher; assert it reaches the mirror-agent's FIFO / tmux stub.
- `tests/integration/mirror-patch.test.ts` (Phase M4) — verify the new patch applies and the patched binary reads the FIFO path (can use a stub binary with the same anchor signature).

### Manual Testing
- Fresh install on Linux: `claude-channels` in a new terminal, turn on mirror via settings, open `/mirror/<sid>` in another browser, verify live updates.
- Restart-resilience: kill and restart the mirror-agent mid-session; confirm JSONL reconciliation replays the missed events.
- Hub down: run with `CLAUDE_NET_HUB` pointing at an unreachable host; confirm local Claude is unaffected.
- Tmux + non-tmux: verify Phase M2 degrades gracefully when not in tmux (compose box disabled with explanation).
- Injection consent: verify first inject prompts in-terminal and second inject passes silently.

## Deployment Considerations

- New launcher logic must be backward compatible: if `claudeNet.mirror.enabled` is unset or false, `claude-channels` behavior is unchanged from today.
- Mirror-agent is a new systemd-optional long-running local daemon. Default install is "launch lazily from claude-channels"; `bin/install-mirror-agent` (new script) adds a user-scoped systemd unit for those who want it.
- Hub default stays in-memory only; `CLAUDE_NET_MIRROR_STORE` env enables file persistence (Phase M3). Docker image gains a volume suggestion in `docker-compose.yml`.
- Docker image build must still work — no new system packages required (Bun + tmux is runtime on the user's host, not in the hub image).

## Documentation Updates

- `README.md` — new "Mirror sessions" section after the statusline section; include the MCP tool table update (add `/mirror …` tools).
- `CLAUDE.md` — note `src/mirror-agent/` and `src/hub/mirror.ts` in the architecture tree; add testing entry for `mirror-e2e.test.ts`.
- `docs/CLAUDE_NET_SPEC.md` — add an FR-8 (Mirror Sessions) section describing the new tool surface and frame types.
- `docs/CLAUDE_CODE_PATCHING_GUIDE.md` — Phase M4 only: document the new FIFO-read patch and its anchor strategy.
- `bin/install-channels` — updated to also offer mirror-agent install.

## Success Criteria

- [ ] With `claudeNet.mirror.enabled: true` in `~/.claude/settings.json`, every new claude-channels session automatically appears in the hub's mirror list.
- [ ] A browser on the trust network, given the owner URL, shows the live transcript with end-to-end latency under 100ms on LAN.
- [ ] p99 added turn-latency on the local claude attributable to mirror hooks: < 2ms. Measured by the hook wrapper's self-timing.
- [ ] Kill/restart the mirror-agent mid-session: watcher sees no gap after reconciliation.
- [ ] Kill/block the hub: local claude is unaffected; mirror-agent reconnects on recovery.
- [ ] Remote injection (tmux, Phase M2) enters the local REPL exactly once per send; first send in a session requires terminal consent.
- [ ] All owner/reader token flows enforce correctly (read-only watcher cannot POST inject).
- [ ] `bun test` green; all Biome checks pass.

## Next Steps

1. Read this plan and the spec (`docs/MIRROR_SESSION_PLAN.md`).
2. Start with **Phase M0**: `docs/MIRROR_SESSION_PHASE_0.md`.
3. After each phase, exercise the testing strategy and success criteria before proceeding to the next phase file.
4. Phase M4 is explicitly opt-in and should not begin until M1–M3 are shipping stably.
