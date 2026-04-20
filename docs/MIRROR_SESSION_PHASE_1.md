# Mirror-Session — Phase M1: Outbound Read-Only Mirror

**Part of:** `MIRROR_SESSION_IMPLEMENTATION_PLAN.md`
**Phase:** 1 of 4
**Estimated Time:** 2–3 days

## Goal

Every Claude Code session launched via `claude-channels` (with `claudeNet.mirror.enabled: true`) automatically streams its entire conversation to a browser-accessible view at `http://<hub>:4815/mirror/{sid}#token=<owner-token>`. The view shows user prompts, assistant messages, tool calls and results, notifications, and compaction dividers, updating live. No injection yet — the compose box is hidden. Exit criteria: a developer on the trust network can silently watch an active local session from their phone.

## Prerequisites

- [ ] Phase M0 complete and merged.
- [ ] Spec read: `docs/MIRROR_SESSION_PLAN.md`.
- [ ] Main plan read: `docs/MIRROR_SESSION_IMPLEMENTATION_PLAN.md`.
- [ ] Familiarity with `src/hub/ws-plugin.ts`, `src/hub/ws-dashboard.ts`, `src/hub/registry.ts`, `src/plugin/plugin.ts`, `bin/claude-channels`.

## Codebase Patterns to Follow

**Elysia plugin composition** (`src/hub/index.ts:33-62`) — `mirrorPlugin({ mirrorRegistry })` follows the shape of `apiPlugin` and `setupPlugin`. Register it in `index.ts` alongside the others.

**Class + result-tuple state module** (`src/hub/registry.ts:55-104`) — `MirrorRegistry` mirrors the shape of `Registry`: internal `Map`s, public methods return `{ ok: true; ... } | { ok: false; error: string }`, never throw on hot paths.

**WebSocket handler pattern** (`src/hub/ws-plugin.ts:79-328`) — `open`/`message`/`close` lifecycle, JSON frame dispatch on `data.action`, `sendResponse(ws, requestId, ok, data?, error?)` helper, `WeakMap<wsIdentity, sid>` for identity tracking.

**Dashboard broadcast wiring** (`src/hub/ws-dashboard.ts`) — `setDashboardBroadcast(fn)` setter pattern. Extend to dispatch `mirror:*` events to watchers subscribed to a specific `sid`.

**Tokyonight palette** (`src/hub/dashboard.html:10-25`) — reuse CSS custom properties. No new framework; vanilla JS and DOM.

**Stderr-prefixed logging** — `[claude-net/mirror]` and `[claude-net/mirror:${sid}]`.

**Test style** (`tests/hub/registry.test.ts`, `tests/integration/e2e.test.ts`) — `bun:test`, mock WS with `.sent` array, integration tests use `listen(0)` + helper to assemble a real Elysia hub.

## Files to Create

- `src/hub/mirror.ts` — `MirrorRegistry` class (session lifecycle, token issuance, transcript ring, watcher set) and `mirrorPlugin` Elysia plugin (REST + WebSocket routes).
- `src/mirror-agent/agent.ts` — long-running local daemon. Loopback HTTP listener for hooks, hub WebSocket client, JSONL inotify/polling reconciliation, per-session state.
- `src/mirror-agent/hook-ingest.ts` — parse & normalize incoming hook payloads into `MirrorEventFrame`s.
- `src/mirror-agent/jsonl-tail.ts` — tail a JSONL file, yield deduped records keyed by `uuid`.
- `src/mirror-agent/hub-client.ts` — WebSocket client wrapping `ws` with the same reconnect/backoff strategy as `src/plugin/plugin.ts`.
- `bin/claude-net-mirror-push` — tiny Bun script (or single-file `#!/usr/bin/env bun`) that POSTs raw stdin JSON to the mirror-agent loopback. ≤ 30 lines.
- `bin/claude-net-mirror-agent` — entry script for the daemon (`#!/usr/bin/env bun` → `src/mirror-agent/agent.ts`).
- `tests/hub/mirror.test.ts` — unit tests for `MirrorRegistry`.
- `tests/mirror-agent/agent.test.ts` — unit tests for hook ingestion, JSONL dedupe.
- `tests/integration/mirror-e2e.test.ts` — end-to-end: hub + fake agent + WS watcher.

## Files to Modify

- `src/shared/types.ts` — refine mirror payload types based on real Claude Code hook schemas (see Implementation Guidance). Remove any `unknown` placeholders from M0.
- `src/hub/index.ts` — wire `mirrorPlugin` into the app composition.
- `src/hub/ws-dashboard.ts` — teach the broadcaster about `mirror:*` events and per-`sid` watcher subscription.
- `src/hub/dashboard.html` — add client-side path routing: if `pathname.startsWith('/mirror/')` render the mirror view; else render the existing dashboard. Add HTML/CSS/JS for the transcript view (user bubbles, assistant bubbles, collapsible tool-call cards, notification inline notes, compact dividers). Compose box hidden in M1.
- `src/hub/setup.ts` — extend the generated setup script to install `bin/claude-net-mirror-agent` and `bin/claude-net-mirror-push` to `~/.local/bin/` (alongside current plugin registration).
- `src/plugin/plugin.ts` — add MCP tools: `mirror_status` (always available), `mirror_on`, `mirror_off`, `mirror_url`. Tools call the hub's `/api/mirror/...` endpoints via the existing plugin HTTP helper or directly via `fetch`. Duplicate any shared types inline.
- `bin/claude-channels` — read `~/.claude/settings.json` for `claudeNet.mirror.enabled`; if true, generate an ephemeral `$XDG_RUNTIME_DIR/claude-channels/settings-<pid>.json` that merges user settings with the mirror hook block, point claude at it via an override mechanism (preferred: `CLAUDE_SETTINGS_FILE` env if supported, else symlink/exec workaround — confirm via a quick spike), and launch the mirror-agent if not already running.
- `bin/install-channels` — also copy `bin/claude-net-mirror-agent` and `bin/claude-net-mirror-push` into `~/.local/share/claude-channels/bin/` and symlink into `~/.local/bin/`.
- `CLAUDE.md` — remove `(planned)` markers from M0; add mirror architecture notes.
- `docs/CLAUDE_NET_SPEC.md` — flesh out FR-8 Mirror Sessions now that the M1 contract is concrete.
- `README.md` — add a short "Mirror sessions" section showing the settings toggle and URL-grabbing workflow.

## Key Requirements

1. **`MirrorRegistry`** holds sessions in memory: `Map<sid, MirrorSession>`. Each session has an `owner_agent`, `cwd`, `created_at`, `last_event_at`, a bounded transcript ring (default 2000 events), a watcher set (WebSocket identity), and an owner token (Phase M3 adds reader tokens).
2. **Hub REST** endpoints under `/api/mirror/*`:
   - `POST /api/mirror/session` — create session (by mirror-agent on first event); returns `{ sid, mirror_url, owner_token }`. Caller must identify as an existing claude-net agent via `X-Claude-Net-Agent: <full-name>` header — hub verifies against `Registry` and pins as owner.
   - `GET /api/mirror/sessions` — list (owner-gated by agent header + per-session token).
   - `GET /api/mirror/{sid}/transcript` — full snapshot (token-gated).
   - `POST /api/mirror/{sid}/close` — close session, retain transcript for retention window.
3. **Hub WebSocket**: `WS /ws/mirror/{sid}` — bidirectional. Subscribers receive the current transcript + live `MirrorEventFrame`s. For M1 the upstream direction is only `MirrorEventFrame` from the mirror-agent; the reverse (`MirrorInjectFrame`) lands in M2.
4. **Mirror-agent responsibilities:**
   - Loopback HTTP listener on `127.0.0.1:<auto-port>` (record the chosen port in `/tmp/claude-net/mirror-agent-<uid>.port`).
   - Accept POST `/hook` with a raw JSON hook payload. Normalize to `MirrorEventFrame`, add `uuid` if absent, forward to hub via per-`sid` WS.
   - Detect new sessions by `session_id` in hook payload; on first sighting, `POST /api/mirror/session` to the hub, record `sid → { token, mirrorUrl, ws }` mapping, then stream.
   - Start a `jsonl-tail` watcher per session on `transcript_path`; reconcile (dedupe by `uuid`) and emit any missed records.
   - Reconnect to hub on failure with exponential backoff (`1s → 30s max`, matching the plugin).
   - Buffer events during hub downtime (bounded queue, default 4096 events, drop oldest with warning).
5. **Hook wrapper** (`bin/claude-net-mirror-push`): reads stdin JSON, POSTs to `127.0.0.1:<port>/hook` with a hard 50ms connect+send timeout, always exits 0 (never fail the hook). Records its own wall-clock and logs only if > 5ms (local log at `/tmp/claude-net/mirror-hook.log`).
6. **Hooks installed** via launcher-managed ephemeral settings file:
   - `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `PreCompact`, `PostCompact`.
   - Each calls `claude-net-mirror-push` with `timeout_ms: 50`.
7. **Web view** (`/mirror/{sid}#token=...`): single-page, reads token from URL fragment, opens `WS /ws/mirror/{sid}?t=<token>`, renders transcript. Scroll-locks to bottom unless user scrolls up. Clear visual distinction between user / assistant / tool-call / notification / compact events. Compose box is present in the DOM but hidden with a `.compose-hidden` CSS class (M2 un-hides it).
8. **Plugin tools**:
   - `mirror_status` → `{ enabled: bool, sid?: string, mirror_url?: string, watcher_count?: number, last_event_age_ms?: number }`.
   - `mirror_on` → creates session if none exists for this claude process; prints URL + truncated owner token.
   - `mirror_url` → prints URL again.
   - `mirror_off` → closes session.
9. **Performance SLOs** (measurable): p99 hook-add latency < 2ms (loopback), p99 event delivery to watcher on LAN < 100ms, mirror-agent RSS < 60MB with one active session.

## Integration Points

- Mirror-agent reuses the same WebSocket client shape as `src/plugin/plugin.ts` (reconnect+backoff). Consider extracting the reconnecting-WS helper into `src/shared/ws-client.ts` — if so, make the extraction a minimal refactor in this phase and update both sites.
- Hub dashboard broadcaster (`setDashboardBroadcast`) is extended to dispatch `mirror:*` events to `WS /ws/mirror/{sid}` watchers only; no leak to general dashboard viewers.
- Claude-net `Registry` is the source of truth for the `owner_agent` identity pinned to each mirror session.
- `bin/claude-channels` should detect whether the mirror-agent is running (via `/tmp/claude-net/mirror-agent-<uid>.port` file + health probe) and start it if not, as a double-forked detached process.

## Implementation Guidance

**Solution Quality Standards:**
- Implement general solutions that work for all valid inputs, not just test cases.
- Use standard tools directly; avoid creating helper scripts as workarounds.
- If requirements are unclear or tests appear incorrect, note this for the implementer to raise with the user.

**Claude Code hook schemas** — before wiring `hook-ingest.ts`, confirm the exact hook payload shapes from the Claude Code docs. The spec summary gives the high level (`UserPromptSubmit` has `prompt`, `Stop` has `last_assistant_message` + `stop_reason`, etc.), but the exact JSON keys must be verified against the current Claude Code version used by `claude-channels`. A small spike (run claude with a logging hook that just `tee`s stdin) is cheaper than guessing.

**Ephemeral settings override** — `bin/claude-channels` should not mutate `~/.claude/settings.json`. Preferred path: write a merged settings file to `$XDG_RUNTIME_DIR/claude-channels/settings-<pid>.json` and point claude at it via whatever mechanism the current Claude Code release supports. If no env var works, a symlink swap is out (race-prone); a per-invocation `--settings <path>` flag is the target — confirm availability. Document the choice in `bin/claude-channels` comments.

**JSONL dedupe** — each JSONL record has `uuid` and `parentUuid`. Maintain a `Set<uuid>` per session; if a hook event is received with a `uuid` already in the set, skip. If the JSONL tail yields a `uuid` already emitted via hook, also skip. Skip `summary`, `file-history-snapshot`, and `result` JSONL records (not user-visible in the transcript).

**Mirror URL format** — `http://<hub>:<port>/mirror/<sid>#token=<owner-token>`. Hub honors the fragment client-side; the token is read by the mirror page JS and sent as `?t=<token>` on the WS upgrade URL (since browsers don't let you set headers on `WebSocket`).

**Error surfaces** — if the mirror-agent cannot reach the hub, `mirror_status` should reflect `{ enabled: true, connected: false, error: "…" }` and the web view title bar should show "stream paused — reconnecting". No user-facing crashes.

**Don't over-engineer M1.** Reader tokens, redactor, persistence, and TLS are Phase M3. Single owner token per session is fine here.

## Testing Strategy

**What to Test:**

- `MirrorRegistry` unit tests: create/get/close, token generation uniqueness, owner-agent pinning, transcript ring behavior (bounded), watcher add/remove.
- Mirror-agent hook ingestion: synthetic hook payloads for each kind → correct `MirrorEventFrame`.
- JSONL reconciliation: write a JSONL file with known records, assert `jsonl-tail.ts` yields them deduped against a pre-seeded `uuid` set.
- End-to-end: bring up hub on random port, stand up mirror-agent variant that reads synthetic hook payloads from a local queue, connect a WS watcher to `/ws/mirror/{sid}`, push hooks, assert transcript arrives in order with no duplicates.
- Plugin tool: `mirror_on` issues the correct REST call and parses the response.
- Launcher dry-run: `claude-channels` with `mirror.enabled` and a mock patched binary — assert the ephemeral settings file is generated with the expected hooks.

**How to Test:**

- `bun test tests/hub/mirror.test.ts` — unit.
- `bun test tests/mirror-agent/agent.test.ts` — unit.
- `bun test tests/integration/mirror-e2e.test.ts` — integration.
- Manual: local `claude-channels`, open `/mirror/<sid>` in Firefox and Chrome, verify live updates and layout.
- Manual: `pkill -9 claude-net-mirror-agent` mid-session → browser shows "stream paused", `pkill` → automatic reconnect, missed events replay.
- Manual: block hub via firewall → local claude unaffected; resumes after unblock.

**Success Criteria:**

- [ ] Unit and integration tests green.
- [ ] p99 added hook latency measured < 2ms via `mirror-hook.log` across a 50-turn manual session.
- [ ] Browser view stays in sync with no duplicates and no gaps across mirror-agent restart and hub outage scenarios.
- [ ] `mirror_on` / `mirror_off` / `mirror_status` work from within Claude Code.
- [ ] `bun run lint` green.

## Dependencies

**External:** none new at runtime. `ws` is already a project dep (used by plugin). Bun stdlib covers HTTP, FS, path, process. The hook wrapper avoids cold-start cost by being a Bun script (≤20ms) — no Node/Python.

**Internal:** M0 types (`src/shared/types.ts`).

## Risks and Mitigations

- **Risk:** Claude Code hooks don't fire in the paths we expect, causing missing events.
  - **Mitigation:** JSONL reconciliation is the safety net; test explicitly with a session that triggers edge cases (tool errors, interrupts, subagent calls).
- **Risk:** Ephemeral settings override mechanism doesn't exist in the claude CLI the user is running.
  - **Mitigation:** Early spike before writing the launcher changes. If no mechanism, fall back to documented "one-time edit of ~/.claude/settings.json" in M1 (with clear messaging) and deliver the ephemeral path in M3.
- **Risk:** Hook JSON is large (long prompts, tool outputs) → loopback POST gets slow.
  - **Mitigation:** Hook wrapper streams body; mirror-agent accepts up to 4MB per POST; if larger, truncate payload and flag `truncated: true` in the event. Worst case measured < 5ms on a 1MB payload over loopback — still within the 50ms budget.
- **Risk:** Two claude processes race to create the same `sid`.
  - **Mitigation:** Sessions keyed by `session_id` from Claude Code's own JSONL, which is unique. Race is a non-issue.
- **Risk:** Mirror-agent becomes a zombie after `claude` exits.
  - **Mitigation:** Agent keeps a parent-lifetime watchdog *per session* (removing the session when the last hook for a sid is > 10 min old and the JSONL stops growing), plus an overall idle shutdown when no sessions for 30 min (configurable).

## Next Steps

After completing this phase:
1. Run the testing strategy and verify all success criteria.
2. Commit on `feat/mirror-m1-readonly`. Squash-merge after review.
3. Proceed to `MIRROR_SESSION_PHASE_2.md`.
