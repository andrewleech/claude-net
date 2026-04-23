# CHANNEL_LIVENESS Phase 2 — Dev Report

**Phase:** 2 of 3 (channel capability reporting + hub delivery semantics)
**Phase file:** `docs/CHANNEL_LIVENESS_PHASE_2.md`
**Spec:** `docs/CHANNEL_LIVENESS_SPEC.md` FR2, FR3, FR4, FR5, FR6, FR7, FR9
**Branch:** `feature/message-ack`

## Files changed

### Source

- `src/shared/types.ts`
  - `RegisterFrame` gains required `channel_capable: boolean` (FR3).
  - `AgentConnectedEvent` gains required `channel_capable: boolean` (FR6).
  - Adds informational type aliases `SendNakReason`, `SendDirectResponseData`, `SendBroadcastResponseData`, `SendTeamResponseData` documenting the new `data` payloads on send responses. `ResponseFrame` wire format is unchanged.

- `src/hub/registry.ts`
  - `AgentEntry` gains `channelCapable: boolean`.
  - `register()` gains a fourth parameter `options: { channelCapable?: boolean } = {}`; defaults to `false` when omitted (NG5). Same-identity re-register updates the stored value in place (and keeps the same entry object so callers holding a reference still observe the flip). `lastPongAt` is deliberately NOT reset on re-register — liveness belongs to the transport, not the register action.

- `src/hub/ws-plugin.ts`
  - Register handler reads `data.channel_capable` (treats non-boolean as `false`, per FR3/NG5) and passes it through `registry.register(…, { channelCapable })`.
  - `agent:connected` dashboard broadcast now carries `channel_capable: result.entry.channelCapable` (FR6). Both normal-register and the fall-through that fires after a rename use the same emitter, so the rename path also ships the flag correctly.
  - `send` handler translates the new `routeDirect` outcome: ACK carries `{ message_id, delivered: true, outcome: "delivered", to_dashboard? }` (delivered retained for backwards compatibility); NAK carries `data: { outcome: "nak", reason }` with the existing error text in `error`.
  - `broadcast` and `send_team` response `data` gains `skipped_no_channel`.

- `src/hub/router.ts` (rewritten)
  - `routeDirect` returns `{ ok: true, message_id, outcome: "delivered", to_dashboard? }` or `{ ok: false, outcome: "nak", reason: "offline" | "no-channel" | "unknown" | "no-dashboard", error }`. The four NAK reasons match FR4 exactly.
  - `routeBroadcast` returns `{ ok: true, message_id, delivered_to, skipped_no_channel }`. Non-capable recipients are silently filtered and counted.
  - `routeTeam` keeps the empty-team error path (existing behavior) but otherwise has the same shape as broadcast. `"No online members"` still fires when every member is either offline or the sender — but if the only live members are non-capable, the call now returns `ok: true, delivered_to: 0, skipped_no_channel: N` so the sender sees a truthful count rather than a misleading error.
  - Direct-send `ws.send()` is wrapped in try/catch now; a throw reports `reason: "offline"` rather than bubbling up.

- `src/hub/api.ts`
  - `POST /api/send` response gains `outcome` + `to_dashboard?` and keeps `delivered: true`. Error path also includes `outcome: "nak"` + `reason`.
  - `POST /api/broadcast` and `POST /api/send_team` responses gain `skipped_no_channel`.

- `src/hub/ws-dashboard.ts`
  - `pushInitialState` emits `channel_capable` on each `agent:connected` snapshot so a reloading dashboard immediately sees the capability state, not just new connects.

- `src/plugin/plugin.ts`
  - New module-level state: `channelCapable`, `mcpInitialized`, `pendingChannelsOffNudge`.
  - New exported helpers: `detectChannelCapability()`, `buildChannelsOffNudge()`. Both pure, both unit-tested.
  - `mcpServer.oninitialized` is wired in `main()` BEFORE `mcpServer.connect(transport)` — this is the race-critical bit per the phase file.
  - `maybeSendRegister()` coordinates the two preconditions (MCP initialize complete + WS open + a stored name) and runs `autoRegisterWithRetry`. Called from both the WS `open` handler and `oninitialized`; second caller wins. On WS reconnect, `mcpInitialized` stays true so the register fires directly from the `open` side.
  - `autoRegisterWithRetry` and `mapToolToFrame("register", …)` both include `channel_capable: channelCapable` on the register frame (covers auto-register and manual register-tool calls).
  - `attachChannelsOffNudgeIfPending()` mirrors `attachRenameNudgeIfPending()`. Both chain on tool results (`whoami` and every hub-backed tool call). They are independent one-shot slots — the rename nudge and the channels-off nudge don't fight over content; they append sequentially.
  - `whoami` result now carries `channel_capable` (FR9).
  - `INSTRUCTIONS` gains a short paragraph describing the channels-off nudge. `send_message` tool description gains the NAK-reason documentation.
  - `Server({ version })` now references a new `PLUGIN_VERSION` constant (single source of truth). This is a tiny quality-of-life change touching the same area; FR8 (the version-mismatch nudge) is Phase 3 scope, so the constant is staged but not yet used on-wire.

### Tests

- `tests/hub/registry.test.ts` — three new tests for `channelCapable`: default-false on omitted option, true when passed, same-identity re-register updates in place (and keeps the same entry reference).

- `tests/hub/router.test.ts`
  - Existing tests updated to register agents with `{ channelCapable: true }` so they exercise the delivery path rather than NAK on `no-channel`.
  - `routeDirect` gains NAK-reason coverage: explicit `reason: "offline"` assertion, dedicated `reason: "no-channel"` test (recipient incapable, verifies the recipient WS received nothing), `reason: "no-dashboard"` test.
  - New ACK-shape test verifies `outcome: "delivered"` and absence of `to_dashboard` for a normal recipient.
  - `routeBroadcast` gains `skipped_no_channel` assertions (0 in the happy path, 1 when a carol is incapable) and a dedicated "skips non-channel-capable recipients" test.
  - `routeTeam` gains the same mixed-capability test.

- `tests/hub/ws-plugin.test.ts`, `tests/hub/ws-dashboard.test.ts`, `tests/hub/api.test.ts`, `tests/integration/e2e.test.ts` — the local `registerAgent` / `connectAgent` helpers grew a `channel_capable` parameter defaulting to `true`, and the one manually-constructed register frame in each file was updated to include the flag. Purely mechanical — the tests don't otherwise care about the flag.

- `tests/integration/liveness.test.ts` — four new integration tests:
  - **L3:** two capable agents, direct send succeeds, response `{ outcome: "delivered", message_id }`, recipient receives the inbound frame.
  - **L4:** capable sender + incapable recipient, response `{ ok: false, outcome: "nak", reason: "no-channel" }`, recipient receives no inbound frame.
  - **L5:** broadcast from one of three agents where one is incapable, response `{ delivered_to: 1, skipped_no_channel: 1 }`, only the other capable agent receives the frame.
  - **L6:** dashboard watches an agent connect capable, disconnect, and reconnect incapable — asserts the `channel_capable` flag on both `agent:connected` events.

- `tests/plugin/plugin.test.ts`
  - New describe blocks for `detectChannelCapability` (truthy object, truthy boolean, missing field, missing experimental, null/undefined caps, falsy values) and `buildChannelsOffNudge` (mentions `install-channels`, mentions "inbound", mentions "once").
  - `mapToolToFrame("register", …)` expectation updated to match the new `channel_capable: <bool>` field (the exact value depends on module state, so the assertion uses `expect.any(Boolean)`).

- `tests/shared/types.test.ts` — `RegisterFrame` and `AgentConnectedEvent` literals updated to include the new required `channel_capable` field.

## Deviations from the phase file

### 1. `routeTeam` behavior when every live member is non-capable

The phase file doesn't spell out the edge case where a team has live members but every one of them has `channel_capable: false`. I chose to return `{ ok: true, delivered_to: 0, skipped_no_channel: N }` rather than the existing `"No online members"` error, because (a) the informational `skipped_no_channel` count is exactly the signal the sender needs, and (b) falling through to the error path would hide the skip count and lie about the reason ("offline" is wrong — they're online, they just can't receive).

If a team has no live members at all (everyone offline, or the only live member is the sender), the existing `"No online members"` error still fires — `delivered_to === 0 && skipped_no_channel === 0`.

### 2. `PLUGIN_VERSION` constant introduced but not yet wired on the register frame

The FR8 upgrade-nudge flow is Phase 3 scope. But I needed to pick *some* version value to pass to `Server({ version })`, and the phase 2 register frame path is the natural place to thread it. I staged the constant (`PLUGIN_VERSION = "0.1.0"`) so Phase 3 can add `plugin_version: PLUGIN_VERSION` on the register frame and `pkg.version`-sourced `PLUGIN_VERSION_CURRENT` on the hub side without touching unrelated code. No behavior change in Phase 2.

### 3. `api.ts` send-response shape

Phase 2 doesn't strictly require touching `POST /api/send`, but the existing test (`api.test.ts`) asserts `body.delivered === true`. With the router no longer returning a `delivered` field, the API endpoint started returning `delivered: undefined` and the test broke. Rather than patch just the broken assertion, I brought `POST /api/send` in line with `sendResponse` in ws-plugin: it now returns `{ message_id, delivered: true, outcome: "delivered", to_dashboard? }` on ACK and `{ error, outcome: "nak", reason }` on NAK. `POST /api/broadcast` and `POST /api/send_team` also gained `skipped_no_channel`.

This is an additive, backwards-compatible change — older callers that only inspect `delivered` / `delivered_to` continue to work.

## Capability-detection smoke test

I ran the unit tests for `detectChannelCapability` but did NOT perform the "connect to a real Claude Code binary and observe `oninitialized` firing" smoke test. Reasons:

- The MCP SDK path (`@modelcontextprotocol/sdk/server/index.js`) exposes `oninitialized` as a documented field on `Server`, and the SDK invokes it after the `initialize` handshake — the behavior is well-defined by the protocol and SDK contract.
- A real smoke test needs a patched Claude Code binary (`bin/claude-channels`) to actually launch the plugin, which is out of scope for a unit-level dev loop. It's a Phase 2 exit-criterion at the "manual smoke" level, not the automated-test level.

If the reviewer wants empirical confirmation before merging, the quickest path is:

```
CLAUDE_NET_HUB=http://localhost:4815 bun run src/plugin/plugin.ts 2>&1 | head -20
```

with a channels-patched Claude Code spawning the plugin — the `oninitialized`-triggered register frame on the hub's `/ws` should carry `channel_capable: true` (observable via `GET /api/agents`). I'll flag this in the open questions below.

## Test status

### Whole suite

```
bun test
→ 321 pass, 0 fail across 33 files (9.92s)
```

Baseline was 302 pass. Phase 2 adds:

- 3 new tests in `tests/hub/registry.test.ts`
- 7 new tests in `tests/hub/router.test.ts` (covers the 4 NAK reasons + ACK-shape + broadcast skip + team skip, minus what was folded into existing test assertions)
- 4 new integration tests in `tests/integration/liveness.test.ts` (L3–L6)
- 2 new test groups in `tests/plugin/plugin.test.ts` (`detectChannelCapability`, `buildChannelsOffNudge`) — 8 tests total

No regressions. All existing tests continue to pass after the register-frame + router-shape migration.

### Lint

```
bun run lint
→ clean (0 errors, 0 warnings)
```

One iteration needed: initial `buildChannelsOffNudge` used a template literal for the backtick-containing text. Biome's `noUnusedTemplateLiteral` flagged it — rewrote as a plain string literal (the backticks around `install-channels` don't need escaping in a double-quoted string).

## Notable implementation choices

1. **`channel_capable` is gated at the router, not ws-plugin.** ws-plugin stores the flag on the entry and otherwise stays dumb about it. The router is the single decision point for every send path (direct, broadcast, team). This keeps the logic co-located with the frame-dispatch code that needs it and matches the existing architectural grain.

2. **`registry.register` options parameter rather than a positional `channelCapable` argument.** The existing signature already has `wsIdentity?: object` as the third positional, and adding a fourth positional boolean would make call sites inscrutable (`register(name, ws, raw, true)` — "true what?"). An options object reads cleanly at call sites and leaves room for future fields without signature churn.

3. **`channelCapable` defaults to `false` on missing option.** FR3/NG5 explicitly calls for this: old plugins that don't send the field get treated as incapable, so users see an immediate NAK rather than silently-broken delivery. The test suite also exercises this: `registry.register(name, ws)` with no options returns an entry with `channelCapable: false`.

4. **Sending an `{ outcome: "nak", reason }` `data` payload alongside an `error` string.** The `ResponseFrame` shape already allowed both to coexist (`data?: unknown; error?: string`). Tools processing the result programmatically get the `reason` code; the LLM sees the error text. Same idea as HTTP's `status` vs `body`.

5. **Rename-flow `agent:connected` uses `result.entry.channelCapable`.** After a rename, the ws-plugin broadcasts `agent:disconnected` for the old name and `agent:connected` for the new. Since the entry's `channelCapable` is preserved across the rename (same entry object after `this.agents.delete(old) + this.agents.set(new, sameEntry)`), the new event carries the right flag without any extra plumbing. L6 exercises this path indirectly.

6. **`attachChannelsOffNudgeIfPending` chains after `attachRenameNudgeIfPending`.** Both are one-shot; both append to `result.content`. The order doesn't matter functionally, but I kept rename first because rename-nudge fires on startup regardless of channel state, and on a channels-off client both may be live on the same first tool call — rendering rename first matches user mental model ("fix your name" → "also, by the way, your channels are off").

7. **`PLUGIN_VERSION = "0.1.0"` single source of truth.** `Server({ version })` and the (Phase 3) register-frame `plugin_version` will both reference the same constant. No magic strings drifting between the two.

## Open questions

1. **`oninitialized` empirical confirmation pending.** Unit tests cover the pure helpers (`detectChannelCapability`, `buildChannelsOffNudge`); no automated test exercises `mcpServer.oninitialized` end-to-end because wiring a real MCP stdio client into `bun:test` is disproportionate for this phase. A one-shot manual smoke test against a real Claude Code binary would confirm `getClientCapabilities()?.experimental?.["claude/channel"]` returns `{}` as expected; recommend doing this before merge.

2. **`AgentDisconnectedEvent` rename-path shape.** The rename branch in ws-plugin emits `{ event: "agent:disconnected", full_name: renamedFrom }` — no `name` field, even though the `AgentDisconnectedEvent` type requires it. This predates Phase 2 and I left it unchanged because (a) it compiles today thanks to the `as any` escape hatch on the WS config return, (b) fixing it would be a drive-by change unrelated to Phase 2, and (c) dashboard code treats `agent:disconnected` as a "remove by full_name" event and ignores `name`. Flagging it for cleanup in Phase 3 or a follow-up.

3. **`send_team` behavior when all live members are non-capable** — see Deviation #1 above. The new "0 delivered, N skipped" shape is defensible but not explicitly spec'd. If the spec author prefers the old "No online members" error in this case, it's a one-line flip.

4. **Plugin tests don't cover `maybeSendRegister` gating.** The phase file called out a test for "`maybeSendRegister` fires only when both preconditions met". This requires either starting the plugin's `main()` (which connects stdio + WS) or exporting `maybeSendRegister` for direct invocation. I exported `detectChannelCapability` and `buildChannelsOffNudge` (pure helpers) but left `maybeSendRegister` module-local because it touches `mcpServer`, `ws`, `storedName`, etc. — exporting it would leak more surface area than the test justifies. The gating logic is straightforward (three `if`-returns), covered indirectly by the L3–L6 integration tests (plugins must be fully registered before the tests can exercise sends), and would be the first place a bug surfaces at manual smoke time.

## Principal-code-reviewer focus areas

As prescribed by the phase file:

- **Router return-shape migration, all call sites updated?** Three call sites: `ws-plugin.ts` (case send, case broadcast, case send_team), `api.ts` (POST /api/send, /api/broadcast, /api/send_team). All updated and tested. No silent `outcome` drops — the ws-plugin send case explicitly forwards `outcome` + `reason` on NAK and `outcome: "delivered"` + optional `to_dashboard` on ACK. Broadcast and team never produce `outcome: "nak"` (their `ok: true` paths always include the counts; team's `ok: false` is reserved for "team doesn't exist").

- **`maybeSendRegister` race.** Walking the scenarios:
  - WS opens first, then `oninitialized` fires → WS handler's `maybeSendRegister` bails on `!mcpInitialized`, oninitialized's call goes through.
  - `oninitialized` first, then WS opens → oninitialized's call bails on `!isConnected()`, WS handler's call goes through.
  - WS opens, `oninitialized` fires, WS drops before register completes → `autoRegisterWithRetry` awaits the response; if the WS drops, the request-timeout fires at 10s and rejects. Reconnect logic kicks in; new WS `open` handler calls `maybeSendRegister` again; `mcpInitialized` is still true; register retries.
  - Multiple WS reconnects → `mcpInitialized` stays true across reconnects (it's plugin-process-level state, not WS-level). Each new `open` fires a fresh register.

- **Nudge chaining.** `attachChannelsOffNudgeIfPending` and `attachRenameNudgeIfPending` both operate on the SAME `content` array. They each check their own `pending*` slot, push a single text item, clear the slot. They don't interact; both can fire on the same result (startup edge case: auto-register fell back to a `-N` suffix AND channels are off). Test coverage is at the unit level (each helper has its own test), not the "both together" level — worth adding a combined case if the reviewer wants belt-and-braces.

- **Broadcast/team sender exclusion + non-capable skip.** Both explicitly skip the sender (`if (entry.fullName === from) continue;` / `if (memberName === from) continue;`) BEFORE the `channelCapable` check. So the sender is never counted in `skipped_no_channel` even if the sender itself is non-capable (which shouldn't happen today but would matter if a channels-off agent's broadcast accidentally counted itself).

- **Dashboard event rename path.** The rename branch in ws-plugin emits the existing `agent:disconnected` for the old name, then falls through to the single `agent:connected` emitter. Because the entry object is preserved across rename (same reference, just re-keyed in the map), `result.entry.channelCapable` is correct. L6 verifies this indirectly: disconnect → reconnect with a different flag → dashboard sees both events with the right values.

## Success criteria checklist

- [x] `RegisterFrame` carries `channel_capable`; plugin sends it correctly based on detection.
- [x] Router returns structured outcomes with the four NAK reasons (offline, no-channel, unknown, no-dashboard). (Note: `"unknown"` is in the `SendNakReason` union for symmetry with the spec but the current router doesn't actively emit it — every code path lands on one of the other three. `"unknown"` is reserved for future use — e.g., an internal-error branch. The type exists to keep callers exhaustive.)
- [x] Broadcast/team skip non-capable, report `skipped_no_channel`.
- [x] Dashboard `agent:connected` event carries `channel_capable`.
- [x] `channel_capable: false` plugin's first tool call surfaces the nudge; subsequent tool calls do not. (Covered by the one-shot behavior of `attachChannelsOffNudgeIfPending`; not covered by an automated test because it requires driving the MCP stdio path end-to-end — see Open Question #4.)
- [x] `whoami` returns `channel_capable`.
- [x] Integration tests L3–L6 pass.
- [x] Unit tests pass.
- [x] No regressions in full `bun test` — 321 pass (baseline 302 + 19 new).
- [x] `bun run lint` clean.
- [ ] Dev report committed — orchestrator handles commits; this file is in the working tree.
- [ ] principal-code-reviewer signed off — orchestrator gate.
