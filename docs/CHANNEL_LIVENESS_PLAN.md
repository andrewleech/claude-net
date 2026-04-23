# CHANNEL_LIVENESS Implementation Plan

**Spec Source:** `docs/CHANNEL_LIVENESS_SPEC.md`
**Complexity Assessment:** Moderate
**Estimated Phases:** 3
**Generated:** 2026-04-23
**Branch:** `feature/message-ack` (branched from `squash-plan`, which contains PR #1 mirror-session work)

## Orchestration model

This plan is structured for agent-driven execution. The top-level session acts as orchestrator; individual phases are executed end-to-end by subagents:

- **Phase execution:** spawn one `software:scrum-developer` agent per phase, pointing it at the phase file.
- **Post-dev tests:** spawn `software:scrum-sqe` to add meaningful unit tests after the developer completes core work (only if the developer did not already produce complete tests).
- **Independent validation:** spawn `software:scrum-tester` to confirm the phase satisfies spec requirements, builds clean, and tests pass.
- **Review gate** (for tricky phases only): spawn `principal-code-reviewer` before the orchestrator marks a phase merge-ready. Flagged per phase below.
- **Orchestrator responsibilities:** read each phase's dev report, decide branch/commit cadence (suggest one commit per phase, amended into logical chunks if helpful), resolve any questions the agents raise, and confirm all acceptance criteria are met before kicking off the next phase.

Each phase file is the **full contract** for the agent — no conversation-context handoff required. The phase file cites the spec for authoritative requirements rather than duplicating them.

## Overview

Replace silent-drop failure modes with deterministic hub-level ACK/NAK delivery signals, using two cheap mechanisms:

1. **WebSocket ping/pong** — hub pings every registered plugin every 5s; misses evict the registration.
2. **MCP channel capability reporting** — plugin reports `channel_capable` (from MCP `getClientCapabilities()`) on register; hub uses it to gate delivery.

Plus a version-nudge for out-of-date plugins.

No new LLM tools. No message retention. No sender-blocking waits. The full end-to-end ack system is deferred to a future `MESSAGE_ACK_SPEC.md` layering.

## Codebase Analysis

### Current architecture (post-PR-1)

- **Entry:** `src/hub/index.ts` wires Registry, Teams, Router, ws-plugin, ws-dashboard, mirror plugins, and HTTP plugins (api, uploads, host, mirror, setup). Starts Elysia on `app.listen(port)`.
- **Hub state:** `src/hub/registry.ts` — `Map<fullName, AgentEntry>` with `wsIdentity` for WS-change detection, `teams: Set<string>`, 2h `disconnectTimeout` for agents with team memberships. PR #1 added rename detection (`renamedFrom` return) and removed the dashboard-as-virtual-agent entry from `list()`.
- **Plugin transport:** `src/plugin/plugin.ts` single-file, served by hub at `GET /plugin.ts`. Uses MCP SDK stdio transport for Claude Code, `ws` npm library for hub connection. Types duplicated inline (lines 22–59).
- **MCP SDK capability access:** `mcpServer.oninitialized = () => { ... }` callback + `mcpServer.getClientCapabilities()?.experimental?.["claude/channel"]`.
- **Router:** `src/hub/router.ts` — `routeDirect`, `routeBroadcast`, `routeTeam`. Dashboard handled by name check against `DASHBOARD_AGENT_NAME` / `DASHBOARD_SHORT_NAME`.
- **ws-plugin dispatch:** `src/hub/ws-plugin.ts` switches on `data.action`. Holds a WeakMap `ws.raw → fullName` (`wsToAgent`, line 23). Close handler (line 312) calls `registry.unregister`.

### Integration points

- `src/shared/types.ts` — `RegisterFrame`, `AgentConnectedEvent`, and new send-response data shapes. Plugin duplicates inline (plugin.ts:22–59).
- `src/hub/registry.ts` — `AgentEntry` gains `channelCapable`, `lastPongAt`. `register()` signature extended.
- `src/hub/ws-plugin.ts` — register handler (line 115–142), send handler (144–174), open/close handlers (80, 312). Add `pong` handler.
- `src/hub/router.ts` — return shapes extended with `outcome` and `reason`.
- `src/hub/index.ts` — add `setInterval` ping tick after `app.listen()`, track for shutdown.
- `src/plugin/plugin.ts` — capability detection, deferred register, `pendingUpgradeNudge`, instructions update.
- `package.json` — version field (currently `"0.1.0"`); new `src/hub/version.ts` imports it via `resolveJsonModule: true` (tsconfig supports).

### Existing patterns to follow

**One-shot tool-result nudge (PR-#1 addition):** `src/plugin/plugin.ts:269, 619–630`. FR8's upgrade nudge parallels `attachRenameNudgeIfPending` exactly — separate `pendingUpgradeNudgeText: string | null`, separate `attachUpgradeNudgeIfPending()` helper, chained in `handleToolCall`.

**System-notification emission:** `emitSystemNotification` (plugin.ts:288–303). FR2's "channels not active" message rides on this. Fires an MCP `notifications/claude/channel` — works only when channels ARE active (paradox for the channels-off case). Workaround: if channels are off, surface via tool result instead — use the nudge pattern for this too.

**Integration-test hub startup:** `tests/integration/e2e.test.ts:35–138`. Helper `createHub()` calls `app.listen(0)`, reads `app.server?.port`. Mock WS clients use native `WebSocket` with event listeners.

**Bun ServerWebSocket ping/pong (Elysia passthrough):** `ws.raw.ping(data?)` sends a native WS ping frame. Config object for `app.ws()` accepts `pong(ws, data) { ... }` handler. The plugin's `ws` npm library auto-responds to server pings (built-in behavior; no explicit handler needed).

**Discriminated-union frame types:** `src/shared/types.ts` — all plugin→hub frames discriminated on `action`, hub→plugin on `event`. Keep new fields optional during migration where backwards compat matters (it doesn't for this spec per NG5).

### Potential challenges

- **WS pong handler plumbing through Elysia:** Elysia exposes `ws.raw` (underlying Bun `ServerWebSocket`). Adding a top-level `pong` handler in the `app.ws()` config should propagate. Verify in Phase 1; if the handler isn't invoked, fall back to a periodic `if (lastPongAt < threshold) close` sweep (the ping tick already does this — pong reception just advances `lastPongAt`; worst case missing pong handler = false positive eviction, caught by integration test).
- **Timing in tests:** 5s ping / 15s threshold is too slow for integration tests. The ping interval and stale threshold need to be configurable at hub-construction time (e.g., `createHub({ pingIntervalMs, staleThresholdMs })`) so tests can run with 100ms / 300ms values.
- **Capability detection race on cold start:** plugin needs both WS-open and `oninitialized`. Implementing a `maybeSendRegister()` helper that fires when both flags are set is the clean resolution (Phase 2 handles this).
- **`channel_capable: false` system notification cannot ride MCP channels** (the thing it's warning about is the thing it's using). Resolved by routing the message through the one-shot tool-result nudge pattern instead of `emitSystemNotification`.

## Phase Overview

### Phase 1: WebSocket ping/pong + stale eviction
**Goal:** Hub detects half-open plugin WS connections within ~15s and evicts them via the existing `close` path.
**Details:** See `CHANNEL_LIVENESS_PHASE_1.md`.
**Agent profile:** `scrum-developer` + `scrum-sqe` + `scrum-tester`, then **`principal-code-reviewer` review gate** (timer lifecycle and WS handler wiring deserve scrutiny).

### Phase 2: Channel capability reporting and hub delivery semantics
**Goal:** Plugin reports `channel_capable` at register; hub uses it to return structured ACK/NAK with specific `reason` on direct sends, and to filter broadcast/team. Dashboard event carries the flag.
**Details:** See `CHANNEL_LIVENESS_PHASE_2.md`.
**Agent profile:** `scrum-developer` + `scrum-sqe` + `scrum-tester`, then **`principal-code-reviewer` review gate** (touches the hottest code path, the send handler).

### Phase 3: Plugin version reporting and upgrade nudge
**Goal:** Plugin sends `plugin_version` on register; hub compares against `PLUGIN_VERSION_CURRENT` and returns `upgrade_hint` on mismatch; plugin surfaces it on next tool result.
**Details:** See `CHANNEL_LIVENESS_PHASE_3.md`.
**Agent profile:** `scrum-developer` + `scrum-sqe` + `scrum-tester`. No review gate — mechanical change parallel to existing rename-nudge pattern.

## Testing Approach

### Unit tests (per phase)

- Phase 1: `registry.test.ts` (lastPongAt shape, constructor args accept ping config).
- Phase 2: `registry.test.ts` (channel_capable shape), `router.test.ts` (NAK reasons, broadcast/team skip), `plugin.test.ts` (capability detection, deferred register, channels-off nudge).
- Phase 3: `plugin.test.ts` (pluginVersion, upgrade nudge attach), new `version.test.ts` (buildUpgradeHint).

### Integration tests

- Phase 1: `tests/integration/liveness.test.ts` (new) — L1, L2 from spec.
- Phase 2: `tests/integration/liveness.test.ts` (extend) — L3, L4, L5, L6.
- Phase 3: `tests/integration/liveness.test.ts` (extend) — L7, L8, L9.

Each phase's integration tests are additive; one file grows across phases.

### Manual testing

At end of Phase 2 and Phase 3, manual sanity check with real Claude Code session on dev host: verify dashboard `channel_capable` indicator, trigger a capability-off NAK by sending to a known non-channel-capable session, trigger a version mismatch by hand-editing the plugin's declared version.

## Deployment Considerations

- Breaking change for clients running old plugin binaries — they will be treated as `channel_capable: false` and receive no messages until they re-run the install. This is intended per NG5.
- Hub has no persistent state, so no data migration.
- Process shutdown handlers (SIGINT/SIGTERM) must clear the ping interval cleanly. Existing shutdown path in `src/hub/index.ts` handles graceful exit — extend to also call `clearInterval`.

## Documentation Updates

- `CLAUDE.md` — a brief paragraph noting channel_capable + WS ping in the "Architecture" section would be useful but is not blocking.
- `README.md` — touch only if the README documents message delivery semantics; the orchestrator can skip if not.
- No new user-facing docs required.

## Success Criteria

- [ ] Phase 1 merged: WS ping interval active, stale WS eviction <20s in practice, all tests green, principal-code-reviewer approved.
- [ ] Phase 2 merged: `send_message` to an offline/unknown/no-channel recipient returns a specific `reason`; broadcast/team skip non-capable members and report `skipped_no_channel`; dashboard `agent:connected` carries `channel_capable`; plugin emits visible warning when Claude Code binary lacks channels; tests green; principal-code-reviewer approved.
- [ ] Phase 3 merged: register mismatch surfaces the upgrade nudge on the next tool result, exactly once; tests green.
- [ ] Integration test file `tests/integration/liveness.test.ts` covers L1–L9 from the spec.
- [ ] No regressions in existing test suite (`bun test`).
- [ ] `bun run lint` clean, `bun run fmt` applied.

## Next Steps

1. Orchestrator reads this plan, confirms branch (`feature/message-ack`) is up to date.
2. Kick off Phase 1 via `Agent({ subagent_type: "software:scrum-developer", prompt: "Read docs/CHANNEL_LIVENESS_PHASE_1.md and execute end to end. Produce the dev report artifact referenced in the phase file." })`.
3. After dev report: spawn `scrum-sqe` (if tests aren't complete), then `scrum-tester`, then `principal-code-reviewer`.
4. Orchestrator reviews all four reports, resolves any issues, commits, and proceeds to Phase 2.
5. Repeat for Phase 3.
6. Final commit, push branch, open PR.

---
*Generated by /idea-plan-execute:02-plan-spec on 2026-04-23.*
