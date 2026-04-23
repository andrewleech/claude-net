# CHANNEL_LIVENESS — Phase 2: Channel capability reporting and hub delivery semantics

**Part of:** `CHANNEL_LIVENESS_PLAN.md`
**Phase:** 2 of 3
**Estimated Time:** 2–3 hours (dev) + test + review gate
**Branch:** `feature/message-ack`

## Goal

Plugin detects whether Claude Code supports `experimental["claude/channel"]` via the MCP SDK, reports the result as `channel_capable: boolean` on register, and — if `false` — surfaces a one-shot notification to the LLM telling the user to install channels. Hub stores the flag per agent. Router's direct-send path returns structured ACK / NAK outcomes with specific reasons (`offline` / `no-channel` / `unknown` / `no-dashboard`). Broadcast and team sends skip non-capable recipients silently and report `skipped_no_channel`. Dashboard `agent:connected` event gains the flag.

## Prerequisites

- [ ] Phase 1 merged to `feature/message-ack` and green.
- [ ] Read `docs/CHANNEL_LIVENESS_SPEC.md` — FR2, FR3, FR4, FR5, FR6, FR7, FR9.
- [ ] Read `docs/CHANNEL_LIVENESS_PLAN.md`.

## Authoritative spec reference

FR2–FR7 and FR9 in `docs/CHANNEL_LIVENESS_SPEC.md`. Spec wins on any ambiguity.

## Files to modify

- `src/shared/types.ts` — `RegisterFrame` gains required `channel_capable: boolean`; `AgentConnectedEvent` gains `channel_capable: boolean`; add response-data type aliases for send outcomes (document-only, ResponseFrame structure unchanged).
- `src/hub/registry.ts` — `AgentEntry` gains `channelCapable: boolean`; `register()` accepts it; same-identity re-register updates it.
- `src/hub/ws-plugin.ts` — register handler passes `data.channel_capable ?? false` to `registry.register`; broadcast emits `channel_capable` in `agent:connected`; send handler surfaces the new router response shape.
- `src/hub/router.ts` — return shapes of `routeDirect`, `routeBroadcast`, `routeTeam` change per FR4; implement NAK-reason logic.
- `src/plugin/plugin.ts` — inline type duplication; capability detection via `mcpServer.oninitialized`; `channelCapable` module variable; `maybeSendRegister()` gating on both MCP-initialized + WS-open; `whoami` result includes `channel_capable`; one-shot "channels off" nudge; instructions update.

## Files to create

- None (tests extended in existing file).

## Test files to extend

- `tests/integration/liveness.test.ts` — add L3, L4, L5, L6.
- `tests/hub/registry.test.ts` — add channel_capable storage and update coverage.
- `tests/hub/router.test.ts` — add NAK-reason and broadcast/team skip coverage.
- `tests/plugin/plugin.test.ts` — add capability detection, deferred register, channels-off nudge.

## Key requirements

1. **Register frame extension:** `RegisterFrame` gains a REQUIRED `channel_capable: boolean`. Plugin always sends it (defaulting to `false` until `oninitialized` fires). Hub treats missing as `false` (NG5).

2. **Plugin capability detection:**
   - Set `mcpServer.oninitialized = () => { channelCapable = !!mcpServer.getClientCapabilities()?.experimental?.["claude/channel"]; mcpInitialized = true; maybeSendRegister(); }`.
   - Module-level `let channelCapable = false; let mcpInitialized = false;`.
   - `maybeSendRegister()` fires when both `mcpInitialized === true` AND `ws !== null && ws.readyState === OPEN`. Both the WS `open` handler and `oninitialized` call it; first caller where both conditions hold wins.

3. **"Channels off" LLM nudge (FR2):** if `channelCapable === false` after `oninitialized`, stash a one-shot message in `pendingChannelsOffNudge: string | null`. Use the existing PR-#1 nudge pattern — `attachChannelsOffNudgeIfPending(result)` appends to the next tool result's `content`. Chain with existing `attachRenameNudgeIfPending` in `handleToolCall`. Do NOT use `emitSystemNotification` (it rides MCP channels; if channels are off, the notification is dropped).

4. **Registry changes:** `AgentEntry.channelCapable: boolean`. `register()` takes it as a param or as a field on the options object. Same-identity re-register updates the stored value (unlikely to differ in practice, but keeps state coherent).

5. **Router delivery semantics (FR4):** New return shapes:
   ```
   routeDirect → { ok: true, message_id, outcome: "delivered", to_dashboard?: boolean }
              | { ok: false, outcome: "nak", reason: "offline" | "no-channel" | "unknown" | "no-dashboard", error }
   
   routeBroadcast → { ok: true, message_id, delivered_to: number, skipped_no_channel: number }
   
   routeTeam → { ok: true, message_id, delivered_to: number, skipped_no_channel: number }
            | { ok: false, error }   (team does not exist)
   ```
   - Direct: `channel_capable: false` recipient → NAK `reason: "no-channel"`.
   - Direct to dashboard, no clients → NAK `reason: "no-dashboard"`.
   - Direct to dashboard, clients connected → ACK `outcome: "delivered", to_dashboard: true`.
   - Broadcast/team: silently filter `channel_capable: false` members; count them in `skipped_no_channel`.

6. **ws-plugin send-handler response:** translate router outcome into the existing `sendResponse` call:
   - ACK: `sendResponse(ws, requestId, true, { message_id, delivered: true, outcome: "delivered", to_dashboard })` — keep `delivered: true` for backwards compat alongside new `outcome`.
   - NAK: `sendResponse(ws, requestId, false, { outcome: "nak", reason }, errorText)`.

7. **Dashboard `agent:connected` event:** add `channel_capable: boolean`. Fires from both fresh register and (per PR-#1) rename flow. Update both call sites.

8. **`whoami` result:** include `channel_capable: boolean` in the returned JSON payload (plugin-side, no hub round-trip).

9. **Plugin instructions update (FR7):** edit the `INSTRUCTIONS` constant in `plugin.ts`:
   - New short section: "If channels aren't enabled on your Claude Code binary, you will receive a one-time notice on your first tool call and will not be able to receive messages from other agents. You can still send. Ask the user to run `install-channels` on this host."
   - Update `send_message` tool description: append "Returns an error with a `reason` field (`offline` / `no-channel` / `unknown` / `no-dashboard`) if delivery cannot be confirmed."

## Integration points

- **`Server.oninitialized`** from `@modelcontextprotocol/sdk`. Assign directly after constructing the MCP server, before `mcpServer.connect(transport)`.
- **`Server.getClientCapabilities()`** — returns the client's declared capability object. `experimental["claude/channel"]` may be any truthy value (object, boolean, etc.) — treat any truthy as "supported".
- **`wsToAgent` WeakMap** (ws-plugin.ts:23) — no changes; register flow already uses it.
- **Dashboard broadcast function** — `dashboardBroadcastFn` in ws-plugin.ts; accepts `DashboardEvent`. Update the `agent:connected` emitter to include `channel_capable`.
- **Existing rename-related dashboard events** (ws-plugin.ts:138–148 per PR #1) — when a rename fires, the `agent:connected` emitted for the new name must carry `channel_capable` sourced from the entry. Verify.

## Implementation guidance

Recommended sequence:

1. **Types first:** update `src/shared/types.ts`, then mirror-update the inline types in `plugin.ts:22–59`. Include all new required fields as REQUIRED (not optional) — keeps the type errors honest when wiring the code.

2. **Registry:** extend `AgentEntry` and `register()` signature. Update all call sites (currently one, in ws-plugin.ts:118). Update unit tests.

3. **Plugin capability detection:** introduce `channelCapable`, `mcpInitialized`, `maybeSendRegister()`. The existing `connectWebSocket` `open` handler currently calls `request({ action: "register", name: storedName })` directly — replace with `maybeSendRegister()`. Set `mcpServer.oninitialized` in `main()` before `mcpServer.connect(transport)`.

4. **Plugin nudge for channels-off:** parallel to `attachRenameNudgeIfPending` — add `pendingChannelsOffNudge: string | null = null`, populate it inside `oninitialized` if `channelCapable === false`, add `attachChannelsOffNudgeIfPending(result)` helper, chain it in `handleToolCall` (and `whoami` handler).

5. **Router rewrite:** change return shapes. Start with `routeDirect` — the direct-send path is most impactful. Ensure dashboard branch handles `no-dashboard` distinctly. Then `routeBroadcast` (filter + count). Then `routeTeam` (filter + count; preserve existing empty-team error path).

6. **ws-plugin send-handler translation:** touch ONLY the send, broadcast, and send_team cases. Leave register / whoami / list_agents / list_teams / ping / join_team / leave_team alone.

7. **Dashboard event:** update `agent:connected` emitters to include `channel_capable`. Two call sites in ws-plugin.ts after PR #1 — normal register, and rename path.

8. **Instructions text:** small, targeted edits to the `INSTRUCTIONS` string literal.

9. **Tests:** add/extend unit tests per file, then the L3–L6 integration tests.

## Testing strategy

### Integration tests (`tests/integration/liveness.test.ts`)

**L3 — Capability true happy path:**
- Create hub with short intervals.
- Spawn two plugin-like WS clients; both register with `channel_capable: true`.
- Client A sends direct message to Client B's full name.
- Assert: response `{ outcome: "delivered", message_id }`, Client B receives the `InboundMessageFrame`.

**L4 — Capability false NAK:**
- Two clients; one registers with `channel_capable: true` (A), the other `false` (B).
- A sends to B.
- Assert: response `{ ok: false, outcome: "nak", reason: "no-channel" }` and the provided error string.
- Assert: B did NOT receive an InboundMessageFrame.

**L5 — Broadcast with mixed capability:**
- Three clients: two capable, one not.
- One of the capable clients broadcasts.
- Assert: response `{ delivered_to: 1, skipped_no_channel: 1 }` (sender excluded from its own broadcast per existing behavior; verify).
- Assert: only the other capable client received the frame.

**L6 — Dashboard event carries `channel_capable`:**
- Connect a dashboard WS client to `/ws/dashboard`.
- Connect a plugin-like WS client registering with `channel_capable: true`.
- Assert: dashboard receives an `agent:connected` event with `channel_capable: true`.
- Disconnect and reconnect with `channel_capable: false`.
- Assert: dashboard receives `agent:disconnected` for the old identity and `agent:connected` for the new, with `channel_capable: false`.

### Unit tests

- `tests/hub/registry.test.ts`: register stores `channelCapable`; same-identity re-register updates it.
- `tests/hub/router.test.ts`: cover all four NAK reasons; broadcast filter count; team filter count.
- `tests/plugin/plugin.test.ts`: after `mcpServer.oninitialized` fires with capability present, `channelCapable === true`; without capability, `channelCapable === false` and `pendingChannelsOffNudge` is populated; `maybeSendRegister` fires only when both preconditions met.

### Manual smoke

- With Claude Code channel-patched binary: plugin should register with `channel_capable: true`, no nudge appears.
- With an unpatched Claude Code (or a mocked non-capable client): plugin registers with `channel_capable: false`, first tool call surfaces the channels-off nudge, second tool call does not (one-shot).
- Send to a known-incapable session from another agent: expect `"no-channel"` reason in the error.

## Dev report artifact

Save to `docs/CHANNEL_LIVENESS_PHASE_2_DEV_REPORT.md`. Include:

- Files changed with summaries.
- Any deviations from the phase file + rationale.
- Results of capability detection smoke test (did `oninitialized` fire as expected? did `getClientCapabilities` return the expected shape?).
- Test suite status.
- Lint status.
- Open questions.

## Agent review gate

**Trigger `principal-code-reviewer`** after dev + tests pass. Focus:

- Router return-shape changes: are all call sites updated? Any dropped-into-the-void `outcome` values?
- `maybeSendRegister` race: what if the WS opens, MCP initializes, then WS drops before `maybeSendRegister` fires? Reconnect flow must still work.
- Nudge chaining: does `attachChannelsOffNudgeIfPending` + `attachRenameNudgeIfPending` correctly fire independently or fight over the result content?
- Broadcast/team skip logic: is the sender itself correctly excluded (existing behavior) AND non-capable members correctly skipped?
- Dashboard event: does rename flow emit both events with correct `channel_capable` values?

## Success criteria

- [ ] `RegisterFrame` carries `channel_capable`; plugin sends it correctly based on detection.
- [ ] Router returns structured outcomes with the four NAK reasons.
- [ ] Broadcast/team skip non-capable, report `skipped_no_channel`.
- [ ] Dashboard `agent:connected` event carries `channel_capable`.
- [ ] `channel_capable: false` plugin's first tool call surfaces the nudge; subsequent tool calls do not.
- [ ] `whoami` returns `channel_capable`.
- [ ] Integration tests L3–L6 pass.
- [ ] Unit tests pass.
- [ ] No regressions in full `bun test`.
- [ ] `bun run lint` clean.
- [ ] Dev report committed.
- [ ] principal-code-reviewer signed off.

## Dependencies

- Internal: Phase 1 (registry `AgentEntry` shape, same file).
- External: MCP SDK's `oninitialized` callback + `getClientCapabilities()` must behave as documented (verified indirectly by plan's Explore agent report; confirm empirically at first smoke test).

## Risks and mitigations

- **Risk:** `oninitialized` fires before the plugin's `main()` has a chance to attach the callback. **Mitigation:** set `mcpServer.oninitialized = ...` BEFORE `mcpServer.connect(transport)`.
- **Risk:** Claude Code version in use doesn't advertise `experimental.claude/channel` consistently. **Mitigation:** empirical check at smoke test with the current dev environment; document the exact capability shape observed in the dev report.
- **Risk:** Migrating the send-handler response shape silently breaks existing dashboard parsers. **Mitigation:** keep `delivered: true` alongside the new `outcome` field for the success case; existing dashboard code ignores unknown fields.
- **Risk:** Nudge text accidentally rendered in the tool result for channel-CAPABLE clients on some edge path. **Mitigation:** populate `pendingChannelsOffNudge` ONLY inside the `oninitialized` branch where `channelCapable === false`; no other code path sets it.

## Next steps

After this phase is merge-ready, proceed to `CHANNEL_LIVENESS_PHASE_3.md`.
