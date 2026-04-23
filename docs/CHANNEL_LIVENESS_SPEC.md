# CHANNEL_LIVENESS Specification

**Feature:** Deterministic delivery ack/nak from the hub, based on WebSocket-level liveness and plugin-reported MCP channel capability. No LLM participation.
**Source:** conversation 2026-04-22, simpler-first-pass pivot from `MESSAGE_ACK_SPEC.md`.
**Status:** Ready for implementation planning.
**Baseline:** `feature/message-ack` branched from `squash-plan` — PR-#1 mirror-session work is present in-tree.
**Relationship to `MESSAGE_ACK_SPEC.md`:** that spec describes a full end-to-end agent-seen delivery system with retention, auto-redeliver, `ack`/`nak`/`fetch_missed` tools, and sender-blocking semantics. This spec is a minimal first pass that closes the most common silent-drop failure modes without any of that complexity. If we later decide to layer the full system, CHANNEL_LIVENESS gives it a better foundation (fewer spurious timeouts, clearer NAK signals for structural failures) — but the two specs are not dependent; v1 stands alone.

## Overview

Today, `send_message` returns `{ ok: true, delivered: true }` the moment the hub writes the frame to the recipient's WebSocket. That signal is too weak: the recipient's WS may be half-open (the hub's write succeeds into a TCP send buffer that will never be drained), or the recipient's Claude Code binary may not have channels patched in (the plugin emits MCP notifications that Claude Code silently discards).

This spec closes both failure modes with cheap, deterministic mechanisms:

1. **WebSocket-level liveness.** Hub sends native WS pings to each plugin every 5 seconds. Missed pongs (~15s threshold) evict the registry entry and close the WS. This collapses the half-open failure window from "indefinite" to ~15 seconds.
2. **MCP channel capability reporting.** Plugin inspects its MCP client's advertised capabilities after `initialize` and reports `channel_capable: boolean` to the hub on register. Hub refuses to promise delivery to non-capable recipients.

With these in place, the hub can answer "did this message actually get to a recipient that can receive it?" with confidence, purely from transport-layer evidence. No agent cooperation required.

## Goals and Non-Goals

### Goals

- G1. Reduce the half-open WebSocket window from indefinite to ~15s, so stale registrations are evicted quickly and senders see accurate `delivered: false` / `offline` errors.
- G2. Detect at plugin startup whether Claude Code supports `experimental["claude/channel"]`. Inform the LLM and the hub.
- G3. Give the sender's `send_message` tool a clearer failure signal when the recipient cannot actually receive: `recipient-offline`, `recipient-unknown`, or `recipient-no-channel`.
- G4. Avoid silent "success" for messages that will never be seen.

### Non-Goals

- NG1. No end-to-end agent-seen ack. If a recipient's channel-capable plugin receives the frame but Claude Code drops the specific notification at runtime (wedged transport, context-full, etc.), this spec will still report `delivered: true`. That case is what `MESSAGE_ACK_SPEC.md` addresses.
- NG2. No message retention, no auto-redeliver, no `fetch_missed`. If a recipient is offline at send time, the message is dropped; sender sees a NAK.
- NG3. No `ack` / `nak` MCP tools. The recipient's Claude is NOT in the loop.
- NG4. No per-call timeout policy on `send_message`. The tool remains synchronous and fast (hub responds in milliseconds).
- NG5. No capability negotiation for backwards compatibility — old plugins that don't advertise `channel_capable` are treated as `channel_capable: false` by the hub (see FR3), forcing a visible upgrade path.

## Functional Requirements

### FR1. Hub-side WebSocket ping

- Hub starts a periodic interval (at module load, cleared on shutdown) that runs every **5 seconds**.
- For each entry in `registry.agents`, the hub sends a native WebSocket ping frame (`ws.raw.ping()` on Bun's ServerWebSocket).
- The hub records a `lastPongAt: Date` per `AgentEntry`, set on initial `open`, and updated whenever the underlying WS's `pong` handler fires.
- If `Date.now() - lastPongAt > 15_000` (15s, i.e., roughly three missed pings, giving some slack for scheduler jitter and a slow-but-alive client), the hub closes the WS (`ws.raw.close()`). The existing `close` handler fires, which calls `registry.unregister` and broadcasts `agent:disconnected`. No new eviction path — reuse the existing one.
- Native pong handling: Elysia WS wrapper doesn't currently expose pong events, but the underlying Bun `ServerWebSocket` does via `{ pong(ws, data) }` in the `app.ws()` handler config. Wire the handler to update `lastPongAt` for the connection's registered agent.
- Plugin side: the `ws` npm library (plugin uses `import WebSocket from "ws"`) automatically responds to pings with pongs — no plugin change needed for the response half.
- Plugin side, additionally: plugin's own WS `ping` timeout via the npm library's built-in `pingInterval` is NOT used (no symmetric plugin-to-hub ping). The hub is the authoritative liveness-checker; plugin's existing `close` handler + reconnect logic handles the plugin-side detection when the hub closes the WS after missed pongs.

### FR2. Plugin MCP channel-capability detection

- After constructing the MCP server, the plugin sets `mcpServer.oninitialized = () => {...}` to run after the MCP handshake completes.
- In that callback, inspect `mcpServer.getClientCapabilities()?.experimental?.["claude/channel"]`. If present and truthy, set a module-level `channelCapable = true`; otherwise `false`.
- `channelCapable` is captured at startup and never re-evaluated (Claude Code does not dynamically add/remove capabilities on a live connection).
- Capability lookup happens on the MCP stdio side, which is independent of the hub WS. Timing: if `oninitialized` fires BEFORE `connectWebSocket` completes the `register`, the register frame includes the real value. If the WS connects first (rare but possible in cold start), the plugin defers sending `register` until `oninitialized` has fired, OR registers with `channel_capable: false` and then re-registers after. Simplest implementation: defer `register` until BOTH `oninitialized` has fired AND the WS has opened.
- If `channelCapable === false`, the plugin emits a one-shot system notification (using the existing `emitSystemNotification` helper) on the next MCP activity, with content like:
  > `claude-net: this Claude Code binary does not have experimental channels enabled. Inbound messages from other agents will not be received here. Run \`install-channels\` on this host to enable them. You can still send messages via claude-net tools.`
- Plugin state file (written by `writeSessionState` for the statusline) gains a `channel_capable: boolean` field.

### FR3. Plugin register frame carries `channel_capable`

- `RegisterFrame` gains a required `channel_capable: boolean` field.
- Hub stores it on the `AgentEntry`.
- Backwards compatibility: any register frame without `channel_capable` is treated as `false` (NG5). This means old plugins that haven't been updated are visibly broken at send time, not silently half-broken.
- On re-register under the same `wsIdentity` (existing registry behavior — plugin.ts:71–75 update path), the stored `channel_capable` is updated to the new frame's value. In practice it shouldn't change across a single process, but this keeps the state coherent if the plugin restart is silent.

### FR4. Hub delivery semantics

Modify `router.routeDirect`, `routeBroadcast`, `routeTeam` to return a more detailed outcome. The hub decides ACK/NAK synchronously based purely on registry state and transport writes:

- **Direct message:**
  - Recipient unknown (`resolve()` returns offline or not-found) → NAK, `reason: "offline"`, existing error text unchanged.
  - Recipient resolves, but `channel_capable === false` → NAK, `reason: "no-channel"`, error text: `"Recipient <fullName> does not have channels enabled and cannot receive messages. They need to run \`install-channels\` on their host."`
  - Recipient is `dashboard@hub` / `dashboard`, no dashboard clients → NAK, `reason: "no-dashboard"` (existing error, lifted into the new shape).
  - Recipient is `dashboard@hub` / `dashboard` with clients → ACK, `delivered: true`, `to_dashboard: true`.
  - Normal recipient, `channel_capable: true`, WS write succeeds → ACK, `delivered: true`.
  - WS write throws (very rare — usually means the WS just closed; the close handler will clean up) → NAK, `reason: "offline"`.
- **Broadcast:** iterate registered agents; skip any with `channel_capable: false` silently. Count recipients actually written to. Response `{ delivered_to: N, skipped_no_channel: M }` — the `skipped_no_channel` count is informational.
- **Team send:** same rule — skip team members with `channel_capable: false`. Response gains `skipped_no_channel`.

### FR5. Sender-visible `send_message` result shape

- **ACK (dashboard or normal recipient, channel-capable):**
  ```
  { ok: true, data: { outcome: "delivered", message_id, to: <resolved_full_name> } }
  ```
  Optional `to_dashboard: true` for dashboard recipients.
- **NAK (recipient unreachable or incapable):**
  ```
  isError: true,
  content: [{ type: "text", text: "<error_text>" }]
  ```
  The `data` (on errors that reach the plugin) includes `{ outcome: "nak", reason: "offline" | "no-channel" | "unknown" | "no-dashboard" }` so tools processing the result programmatically can distinguish — but for the LLM, the textual error is what matters.

Broadcast / team sends: response shape gains `skipped_no_channel: N`. Sender's LLM sees `"Broadcast sent to 3 agents (1 skipped: no channels enabled)."` or similar.

### FR6. Dashboard event additions

- `agent:connected` event gains `channel_capable: boolean` field. Dashboard can render a distinct indicator for non-capable agents.
- No new dashboard events (no ack/nak events — `message:routed` plus the existing error path already carry enough signal).

### FR7. Plugin instructions update

Minor additions to the `INSTRUCTIONS` constant in `src/plugin/plugin.ts`:

- New section explaining that if `channels not enabled`, inbound messages won't be seen and the plugin will emit a one-time system notification at startup.
- `send_message` description gains: "Returns an error with a specific reason if the recipient is offline, unknown, or does not have channels enabled."

No new tools. No ack/nak behavior changes on the LLM side.

### FR8. Plugin version reporting and upgrade nudge

The current plugin is served by the hub at `GET /plugin.ts`, so hub and plugin versions should match in practice — but a client machine may have a cached or manually installed older plugin. This FR closes that loop with a cheap nag.

- `RegisterFrame` gains a required `plugin_version: string` field. The plugin already declares a version to MCP (`new Server({ name: "claude-net", version: "0.1.0" }, ...)` on plugin.ts); pipe that same value through register.
- Hub has a `PLUGIN_VERSION_CURRENT` constant, sourced from `package.json` at build time (or hardcoded and kept in sync — pre-1.0 project, either works). On register, hub compares `data.plugin_version` against `PLUGIN_VERSION_CURRENT`:
  - Exact string match → no hint.
  - Mismatch (older, newer, or missing) → hub appends `upgrade_hint: string` to the register response `data`. Example text:
    > `claude-net: your plugin (version 0.1.0) is out of date. The hub is on 0.2.0. To upgrade, re-run the install script: \`curl -fsSL http://<hub_host>:<port>/setup | bash\`.`
    Hub constructs the URL from its own listen address.
- Plugin, on successful register, reads `data.upgrade_hint`. If present, stores it in `pendingUpgradeNudge: string | null`.
- Plugin uses the same "append to next tool result" pattern PR #1 introduced for the rename nudge (`attachRenameNudgeIfPending` in `plugin.ts`). Add a parallel `attachUpgradeNudgeIfPending` that appends `pendingUpgradeNudge` to the next tool result's `content` and then clears the slot. Chain both nudge-attachers if both are set.
- The nudge fires exactly once per plugin startup. If the LLM ignores it, it's gone until the next plugin restart.
- **Delivery reliability:** the nudge rides on tool-result text, not MCP channel notifications, so it surfaces even on `channel_capable: false` clients. This matters — a stale plugin on an unpatched binary has TWO problems, and only one of them (channels) blocks channel notifications; tool results still work.
- **Very old plugins (no `plugin_version` field at all):** hub treats missing as the sentinel `"unknown"`, emits an upgrade hint. Very-old plugins that predate this spec's register-response shape may ignore the `upgrade_hint` field entirely (their response schema is narrower); in that case the nudge is silently dropped. Acceptable — sender-side `no-channel` NAKs from FR4 already alert anyone trying to message that stale plugin.
- **New-plugin-on-old-Claude-Code distinction:** if `plugin_version` matches but `channel_capable: false`, FR2's system notification fires (telling the user to patch Claude Code via `install-channels`). The FR9 upgrade nudge does NOT fire in that case — different problem, different fix.
- **Minor scope guard:** no interactive upgrade, no auto-refetch of `/plugin.ts`. Just a text nag. The user runs the install script manually. v2 could add in-place upgrade behavior if it becomes worth the complexity.

### FR9. Plugin startup identity-flow clarification

The existing flow — whoami first, AskUserQuestion if not registered — is unchanged. One refinement:

- If `channel_capable === false`, the plugin's tool handlers for inbound-consuming flows (none exist today, but future tools might) should surface the capability failure prominently. For now, only `send_message`, `broadcast`, `send_team` are affected, and those still work (outbound).
- `whoami` result includes a new field `channel_capable: boolean` so the LLM can self-inspect via that tool.

## Architecture

### Plugin changes (`src/plugin/plugin.ts`)

- Add module-level `channelCapable: boolean = false`.
- Add module-level `pluginVersion: string = "0.1.0"` (or whatever matches the current `Server({ version })` declaration). Single source of truth; both the MCP server constructor and the register frame use it.
- Add module-level `pendingUpgradeNudge: string | null = null`.
- After a successful register response, read `data.upgrade_hint` and set `pendingUpgradeNudge = data.upgrade_hint ?? null`.
- Add `attachUpgradeNudgeIfPending(result)` helper mirroring the existing `attachRenameNudgeIfPending` pattern. Both nudges can chain — attach rename first, then upgrade, both clear after fire.
- Add `mcpInitialized: boolean = false` and `wsOpenPending: boolean = false` flags to coordinate deferred `register` send.
- In `main()`, set `mcpServer.oninitialized = () => { channelCapable = !!mcpServer.getClientCapabilities()?.experimental?.["claude/channel"]; mcpInitialized = true; maybeSendRegister(); }`.
- Rename `connectWebSocket`'s `open` handler's auto-register block to a named function `maybeSendRegister()` that runs only if `mcpInitialized && ws.readyState === OPEN`. Both the `open` handler and `oninitialized` call it; the second-to-fire wins.
- `register` frame construction includes `channel_capable: channelCapable`.
- `whoami` tool handler augments its result with `channel_capable: channelCapable`.
- If `channelCapable === false` after `oninitialized`, emit the system notification described in FR2.

### Hub changes

**`src/shared/types.ts`:**
- `RegisterFrame`: add `channel_capable: boolean` (required).
- `AgentConnectedEvent`: add `channel_capable: boolean`.
- `ResponseFrame.data` shapes (informational, documented): send responses now include `outcome: "delivered" | "nak"` and `reason?: "offline" | "no-channel" | "unknown" | "no-dashboard"`. The existing `message_id` / `delivered` fields remain for compatibility.

**`src/hub/registry.ts`:**
- `AgentEntry` interface gains `channelCapable: boolean` and `lastPongAt: Date`.
- `register()` accepts these new fields via an additional parameter object (or extend the signature; since `register` is called from exactly one place — `ws-plugin.ts` `case "register"` — just extending the signature is fine).
- On re-register with same `wsIdentity`, update `channelCapable` and `lastPongAt`.

**`src/hub/ws-plugin.ts`:**
- `register` handler passes `data.channel_capable ?? false` to `registry.register`.
- `register` handler compares `data.plugin_version` against `PLUGIN_VERSION_CURRENT`; if mismatch or missing, constructs an `upgrade_hint` string (using the hub's listen URL from its startup config) and includes it in the register response `data`.
- New hub module `src/hub/version.ts` exports `PLUGIN_VERSION_CURRENT` sourced from `package.json` (e.g., `import pkg from "../../package.json" with { type: "json" }; export const PLUGIN_VERSION_CURRENT = pkg.version;`) and a helper `buildUpgradeHint(hubUrl, observedVersion): string`.
- `open` handler initializes `lastPongAt = new Date()`.
- Add a `pong` handler: `pong(ws) { const entry = resolveAgentByWs(ws.raw); if (entry) entry.lastPongAt = new Date(); }`. (Bun's ServerWebSocket supports pong handlers via `WebSocketHandler.pong`.)
- The `case "send"` handler uses `router.routeDirect`'s new richer response to emit an error with a specific `reason` field when NAK'd.

**`src/hub/router.ts`:**
- `routeDirect` signature changes return shape:
  ```
  | { ok: true; message_id: string; outcome: "delivered"; to_dashboard?: boolean }
  | { ok: false; outcome: "nak"; reason: "offline" | "no-channel" | "unknown" | "no-dashboard"; error: string }
  ```
- Implements the FR4 decision logic.
- `routeBroadcast` / `routeTeam` gain `skipped_no_channel: number` in the response; filter `channel_capable === false` members silently.

**`src/hub/index.ts`:**
- Add a `setInterval(pingAllAgents, 5_000)` at startup, clear on SIGINT/shutdown. `pingAllAgents` iterates `registry.agents`, calls `entry.ws.raw.ping()` (or closes the WS if `lastPongAt` is stale).
- Also need to compare `lastPongAt` against `now - 15_000` on each tick and close any stale WS. Closing triggers the existing `close` handler which unregisters.

## Protocol / Type Changes

```typescript
// src/shared/types.ts — additions only

export interface RegisterFrame {
  action: "register";
  name: string;
  channel_capable: boolean;  // NEW (required)
  plugin_version: string;    // NEW (required) — plugin's self-reported version
  requestId?: string;
}

// Register response data:
export type RegisterResponseData = {
  name: string;
  full_name: string;
  upgrade_hint?: string;  // NEW — set when plugin_version != hub's PLUGIN_VERSION_CURRENT
};

export interface AgentConnectedEvent {
  event: "agent:connected";
  name: string;
  full_name: string;
  channel_capable: boolean;  // NEW
}

// Informational — documents the new shapes returned by send actions.
// The existing ResponseFrame structure carries these as `data`:
export type SendDirectResponseData =
  | { outcome: "delivered"; message_id: string; to_dashboard?: boolean; delivered?: true }  // delivered kept for compat
  | { outcome: "nak"; reason: "offline" | "no-channel" | "unknown" | "no-dashboard" };

export type SendBroadcastResponseData = {
  message_id: string;
  delivered_to: number;
  skipped_no_channel: number;  // NEW
};

export type SendTeamResponseData = {
  message_id: string;
  delivered_to: number;
  skipped_no_channel: number;  // NEW
};
```

## Error Handling

- **Sender gets NAK (offline / no-channel / unknown / no-dashboard):** MCP error with specific text. LLM reads it, adjusts behavior. The `data.reason` field is programmatically accessible.
- **Hub ping send fails (WS already broken):** the `ws.raw.ping()` call throws or errors. The hub's existing `close` path will fire shortly; explicit handling beyond "try/catch and ignore" is not needed. Worst case the next ping tick catches it.
- **Plugin's MCP stdio closes while WS is open:** stdio close means Claude Code died or restarted. The plugin process ends (SIGPIPE on next write) and its own shutdown sequence runs. Hub sees WS close via the normal path.
- **Plugin's WS closes while MCP stdio is open:** plugin's existing reconnect logic kicks in. `channelCapable` is already set from `oninitialized`, carries through reconnect automatically. Re-register frame carries the same flag.

## Performance

- Ping tick: every 5s, O(online_agents). At typical scale (<20 agents) this is microseconds per tick — native WS ping frames are ~6 bytes and the iteration is a small hash-map walk.
- Ping frames: native WS ping is ~6 bytes. Negligible network load.
- No per-message state change on the hub beyond what exists today. No pending-ack map, no retention. Send path is unchanged in shape.

## Security

No changes to trust model. `channel_capable` is self-reported by the plugin — a malicious plugin could lie, but the consequences are self-damaging (messages it claims to receive won't land) and don't affect other agents. No privilege escalation surface.

## Testing Strategy

### Unit tests

- `tests/hub/registry.test.ts` extensions:
  - register with `channel_capable: true` and `false` → stored correctly.
  - re-register same wsIdentity with changed `channel_capable` → updated.
- `tests/hub/router.test.ts` extensions:
  - direct send to `channel_capable: false` → NAK with `reason: "no-channel"`.
  - broadcast with one capable and one incapable recipient → `delivered_to: 1, skipped_no_channel: 1`.
  - team send with mixed capability → same shape.
  - dashboard recipient, no dashboard clients → NAK `reason: "no-dashboard"`.
  - dashboard recipient, clients connected → ACK with `to_dashboard: true`.
- `tests/plugin/plugin.test.ts` extensions:
  - `oninitialized` callback populates `channelCapable` based on declared capabilities.
  - `register` frame includes `channel_capable: true` when capability present, `false` when absent.
  - `whoami` result includes `channel_capable`.

### Integration tests

- `tests/integration/liveness.test.ts` (new):
  - **L1.** Hub ping tick: start hub with `pingIntervalMs: 100` (test override), connect a plugin, verify the plugin's ws library sees a ping and auto-responds; verify `lastPongAt` advances.
  - **L2.** Stale WS eviction: connect a plugin, then forcibly stop its pong response (half-open simulation — pause the plugin's event loop or drop the socket to NAT-level). After threshold passes, verify registry entry is gone and `agent:disconnected` fires.
  - **L3.** Channel capability true: start plugin with mock client advertising `experimental.claude/channel`; verify register frame and hub-stored entry have `channel_capable: true`; direct send succeeds.
  - **L4.** Channel capability false: start plugin with mock client NOT advertising channel; verify plugin emits the one-shot system notification; verify register frame has `channel_capable: false`; verify direct send from another agent targeting this plugin gets NAK `reason: "no-channel"`.
  - **L5.** Broadcast with mixed capability: three recipients, one non-capable → `delivered_to: 2, skipped_no_channel: 1`.
  - **L6.** End-to-end happy path: two capable plugins, A sends to B, B's channel notification surfaces (visible via mock MCP client's received notifications).
- **L7.** Version match: plugin registers with `plugin_version` equal to `PLUGIN_VERSION_CURRENT` → register response has no `upgrade_hint` → plugin's `pendingUpgradeNudge` is null → subsequent tool results do not carry upgrade text.
- **L8.** Version mismatch: plugin registers with an older `plugin_version` → hub response includes `upgrade_hint` referencing the hub URL and versions → plugin's next tool result has the hint appended → subsequent tool results do not repeat the hint (fires once).
- **L9.** Missing version field: plugin sends a register frame without `plugin_version` (simulated old plugin) → hub still emits `upgrade_hint` with observed version as `"unknown"`.

### Manual / dashboard tests

- Dashboard shows channel-capable vs. not distinguishable on agent list.
- Unpatched Claude Code binary connecting: confirm the system notification appears in Claude's transcript on first tool call.

## Deployment / Migration

- Hub and plugin ship together (same /plugin.ts served from hub).
- Old plugins (pre-FR3) that don't send `channel_capable` will have it defaulted to `false` server-side → all sends to them NAK. User sees the errors immediately. FR8 additionally tries to surface an upgrade hint on the old plugin itself, so the user of THAT Claude session also sees guidance, not just agents targeting it.
- No data migration — no persistent state added.
- Recommend adding a `version` field to the hub's GET /setup banner so users can self-verify their plugin is current.

## Dependencies

No new dependencies. Uses existing:
- Bun's native `ServerWebSocket.ping()` (via Elysia's `ws.raw`).
- The `ws` npm library's automatic ping response.
- MCP SDK's `Server.getClientCapabilities()` and `oninitialized` callback.

## Future Work

This spec is deliberately minimal. The following are explicit future-work items, corresponding to `MESSAGE_ACK_SPEC.md`:

- End-to-end agent-seen ack (plugin `ack` tool, sender blocking tool call, implicit ack via `reply_to`).
- Message retention + auto-redeliver + `fetch_missed` for catch-up on reconnect.
- `registration_expired` reactive recovery for hub-registry inconsistencies.
- Retention-follows-rename (FR12 in v2 spec).
- Richer dashboard lifecycle events (message:acked, message:timed_out, message:retained).

If/when we proceed with v2, this spec's mechanisms remain:
- `channel_capable` continues to gate delivery — v2 would skip starting an ack-wait tracker for incapable recipients.
- WS ping stays as the first-line liveness signal; v2's ack-timeout becomes the second line for runtime-drop cases.

## Next Steps

1. Review this spec.
2. `/idea-plan-execute:02-plan-spec docs/CHANNEL_LIVENESS_SPEC.md` to produce a phased implementation plan.
3. Execute phases on the `feature/message-ack` branch (rename the branch later if the scope stays at v1).

---
*Drafted 2026-04-23 as a v1 simplification of MESSAGE_ACK_SPEC.md.*
