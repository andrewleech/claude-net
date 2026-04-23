# MESSAGE_ACK Specification

**Feature:** End-to-end acknowledgement and recovery for claude-net messages
**Source brainstorm:** `docs/MESSAGE_ACK_BRAINSTORM.md`
**Status:** Ready for implementation planning
**Target codebase:** `/home/anl/claude-net` (TypeScript/Bun, existing plugin + hub)
**Baseline:** `feature/message-ack` branched from `squash-plan` — the squashed PR-#1 (mirror-session / web TUI) is present in-tree. This spec assumes post-PR-#1 shapes: `Registry.register()` returns `renamedFrom`; dashboard is no longer a virtual agent in `registry.list()`; plugin auto-registers with `-N` suffix retry on collision. See FR2, FR7, FR9, FR12 for interaction points.

## Overview

Replace claude-net's fire-and-forget direct-message delivery with end-to-end, agent-seen acknowledgement. The sender's `send_message` tool blocks until the recipient's Claude agent confirms receipt (ack), explicitly rejects (nak), or the hub times out waiting. Timed-out direct messages are promoted to a bounded per-recipient retention ring; the recipient's plugin automatically fetches held messages on reconnect and exposes `fetch_missed` for explicit pulls. Broadcast and team sends remain fire-and-forget at the sender but also land in retention for offline-catch-up. A registration-recovery mechanism lets the plugin silently re-register when the hub rejects a frame for lack of registration.

This closes two silent-failure modes that motivated the change:
1. Sender's MCP plugin WebSocket is stale but the plugin thinks it's connected → today the send "succeeds" and disappears; under this design, the ack times out and the sender learns about it.
2. Recipient's channel notification fails to surface to Claude (wedged MCP transport, stale registration, channel-disabled binary) → today the recipient silently never sees the message; under this design, timeout → retention → auto-redeliver on reconnect (or manual `fetch_missed`).

## Goals and Non-Goals

### Goals

- G1. Sender's `send_message` returns a result that accurately reflects whether the recipient's LLM saw the message (ack), explicitly rejected it (nak), or failed to respond in time (timeout).
- G2. Timed-out direct messages survive the timeout and are recoverable by the recipient on reconnect or explicit fetch.
- G3. Broadcast and team messages have a best-effort catch-up path for recipients that missed them (retention + `fetch_missed`) without blocking the sender.
- G4. Transient hub-registry inconsistencies (plugin's registration silently dropped) are self-healing without user-visible errors.
- G5. Dashboard observability for the new lifecycle: ack/nak/timeout/retained are visible events.

### Non-Goals

- NG1. Not a durable message queue. Retention is bounded (5 messages × 6h TTL per recipient) and messages that exceed bounds are dropped silently.
- NG2. No at-least-once / exactly-once delivery guarantees. A cooperating recipient agent is required for acks; a non-cooperating or forgetful agent degrades to timeout behavior.
- NG3. No heartbeats or proactive liveness. The ack timeout is the only liveness signal.
- NG4. No capability negotiation for backwards compatibility with old plugins. Old plugins will appear broken (all sends to them time out) until reinstalled.
- NG5. No retroactive ack notifications to disconnected senders. If the sender's WS closes before ack/nak/timeout, the hub stops tracking the sender's notification side (no response will ever be sent). The recipient-side retention path still fires on timeout — see FR10.

## Functional Requirements

### FR1. Direct-message blocking ack

- `send_message(to, content, reply_to?, timeout_ms?)` blocks at the hub until one of: ack received, nak received, or `timeout_ms` elapses. `timeout_ms` is clamped to `[1000, 300000]` (default 60000 if omitted). The effective value is echoed in `data.effective_timeout_ms` on acked/naked responses.
- Response shape to the sender's plugin (and thus tool result):
  - **Acked:** `{ ok: true, data: { outcome: "acked", message_id, elapsed_ms, effective_timeout_ms } }`
  - **Naked:** `{ ok: true, data: { outcome: "naked", message_id, accepted: false, reason, elapsed_ms, effective_timeout_ms } }`
  - **Timed out:** `{ ok: false, error: "No acknowledgement within Xs. Message held as ID <id> and will be redelivered when <recipient> reconnects." }`
- Recipient-offline at send time continues to return the existing error shape unchanged; no retention involvement.
- `outcome: "naked"` and MCP success status together signal to the sender's LLM: "the message was delivered and the recipient said no; do not retry, reconsider."

### FR2. Dashboard auto-ack

- When the recipient resolves to `dashboard@hub` or `dashboard` (by value, as `router.routeDirect` already checks), the hub's send path branches to a dashboard-auto-ack flow: calls `routeToDashboard(frame)`; if it returns true (at least one dashboard client received the frame), synthesizes `outcome: "acked", elapsed_ms: <~0>, effective_timeout_ms` and returns to the sender synchronously. Dashboard emits `message:acked` with `acker: "hub-auto"`.
- When no dashboard clients are connected, the existing `"Dashboard is not connected."` error returns unchanged; no retention involvement, no ack wait.
- **Note (post-PR-#1):** the dashboard is no longer listed as a virtual agent in `registry.list()` output (removed in PR #1's registry changes). MESSAGE_ACK routing does not depend on `list()` — the check is against the recipient name string directly — so this is non-breaking.

### FR3. Ack tool (recipient side)

- New MCP tool `ack(message_id, accepted?, reason?)`:
  - `message_id` required.
  - `accepted` defaults to `true`.
  - `reason` free-text string, optional, max 500 chars. Required only when `accepted: false` (plugin should enforce).
- Implicit ack (narrow scope): a plugin frame with `action: "send"` (direct send, NOT `send_team` or `broadcast`) carrying `reply_to=<id>` implicitly acks `<id>` if and only if the direct message's resolved recipient equals the original sender of `<id>` (i.e., the person you are replying to directly is the same person who sent you the message being acked). Replies via team or broadcast do NOT implicitly ack — the recipient must call `ack` explicitly in those cases. The plugin does NOT need to send a separate ack frame when the narrow condition is met; the hub detects and resolves.
- Calling `ack` for an unknown or already-resolved message_id succeeds silently at the plugin level (no LLM-visible error) but the hub returns `{ ok: true, data: { unmatched: true } }` — informational.

### FR4. Ack-timeout retention promotion (direct messages)

- When the hub's ack-wait timer fires for a direct message, the hub:
  1. If the sender's WS is still connected, resolves the sender's pending request with the timeout error. If the sender has disconnected (per FR10 hybrid), skips this step silently.
  2. Appends the message to the recipient's retention ring.
  3. Emits `message:timed_out` and `message:retained` dashboard events (both events fire regardless of sender liveness — dashboard observability is independent of sender-notification liveness).
  4. Discards the pending-ack tracker.
- A direct message that is acked or naked within the window is NOT added to retention.
- Race between ack arrival and timer fire: timer-fire and ack-frame handling both compete to remove the tracker. The hub MUST treat `tracker lookup + removal` as a single atomic step (e.g., `map.delete()` returns whether a key was present; only the winner proceeds with its resolution path). The loser (whether timer or ack) observes the tracker already gone and is a no-op.

### FR5. Broadcast / team retention on send

- On broadcast or team send, for each online recipient that is written to, the hub also appends the message to that recipient's retention ring (with `kind: "broadcast"` or `kind: "team"`, so auto-redeliver can skip them).
- Recipients that are offline at send time are NOT retained for. The sender has no mechanism to queue broadcasts for agents that might join later.
- No ack tracking; broadcast/team sends return immediately with existing `{ delivered_to: N, message_id }` shape.

### FR6. Retention ring

- Keyed by recipient `fullName` (`session:user@host`).
- Unified ring: holds direct-timeout-promoted entries, broadcast entries, and team entries.
- Capacity: 5 entries per recipient. FIFO eviction on overflow (oldest evicted silently).
- TTL: 6 hours. Entries older than TTL are evicted lazily on ring access and by a periodic sweep (every 5 min).
- Each entry records: `{ message_id, kind: "direct" | "broadcast" | "team", from, content, type, reply_to?, team?, timestamp, expires_at }`.
- **Lifetime is independent of the registry.** Retention rings are NOT discarded when a registry entry is evicted or when the disconnect-timeout fires. Only TTL expiry and FIFO overflow reduce ring contents; only explicit consumption (auto-redeliver or `fetch_missed`) empties entries. A ring that stays empty for >6h effectively disappears via TTL+sweep. An entry for a `fullName` that never reconnects lingers until its TTL expires.
- Ring survives: re-registration under the same `fullName`, WS reconnects under the same `fullName`, registry-entry eviction, hub internal sweeps (only expired entries are removed).
- Rationale: coupling ring lifetime to registry lifetime creates inverted behavior (teamed agents get shorter retention than solo agents because the registry evicts them at 2h while the ring would otherwise last 6h). Decoupling keeps the semantics uniform.

### FR7. Auto-redeliver on connect

- Auto-redeliver fires ONLY when the `register` call represents a fresh connection OR a rename. Specifically, the hub fires auto-redeliver when `Registry.register()` returns `restored: true` (agent was previously in `disconnected` state), when `renamedFrom` is set (PR-#1 rename path — see FR12), or when no prior entry existed for the `fullName` (first connection / post-eviction reconnect). Re-register calls that return `restored: false` + no `renamedFrom` with an existing same-identity entry (the silent FR9 recovery path, or a same-session repeat register) do NOT trigger auto-redeliver — this avoids redelivering the same entries multiple times during a wobbly connection.
- When auto-redeliver fires, the hub:
  1. Looks up the retention ring for that `fullName` (after any rename-migration per FR12).
  2. For each entry with `kind: "direct"`, pushes an `InboundMessageFrame` with `no_ack: true` (see FR11/shared types) to the plugin's WS, then removes the entry from the ring.
  3. Leaves `kind: "broadcast"` and `kind: "team"` entries in the ring for `fetch_missed` to claim.
- Auto-redelivered messages do NOT re-trigger sender-side ack waits (the original sender's pending-ack was already resolved with timeout when the entry was retained). The recipient's ack tool on auto-redelivered messages is a no-op at the hub (tracked via the `unmatched: true` path in FR3), though the `no_ack: true` flag tells the plugin instructions to skip acking these.
- Concurrency: auto-redeliver iterates atomically — `for each direct entry: remove from ring; ws.send(...)`. If a new direct retention promotion races with auto-redeliver, it lands after the iteration completes (new entries appended to the ring end; iteration is over a snapshot of indices taken at start).
- Dashboard event: `message:redelivered` is NOT emitted (Q9 choice to keep dashboard events minimal). A new `message:routed` is not emitted either; redelivery is recipient-internal plumbing.

### FR8. `fetch_missed` tool (recipient side)

- New MCP tool `fetch_missed()`, no arguments.
- Hub returns the current retention ring contents for the caller, then clears the ring. Shape: `{ messages: [{ message_id, from, kind, content, type, reply_to?, team?, timestamp }, ...] }`. All entries in the response are stamped with `no_ack: true` semantics when surfaced to the LLM (see FR11 / plugin instructions).
- Plugin behavior on `fetch_missed` result: emit each entry as an MCP `notifications/claude/channel`, same format as live `InboundMessageFrame` delivery but with `no_ack: true` in the frame meta, so the LLM sees them inline and skips ack (senders are long gone).
- **Plugin auto-fetches on fresh connect only, strictly after auto-redeliver completes.** The ordering is: (1) plugin sends `register`; (2) hub responds with `registered` + synchronously pushes auto-redelivered direct InboundMessageFrames before the `register` response's `{ ok: true }` returns (or interleaved — plugin buffers them); (3) only AFTER the plugin has observed the `register` success response does it send `fetch_missed`. This prevents fetching entries that auto-redeliver is about to push. Plugin does NOT auto-fetch on the silent FR9 re-register path (which is not a fresh connect — the WS is the same and no retention accumulated during the gap).
- Plugin also exposes `fetch_missed` as an LLM-callable tool for the "I think I missed something while connected" case (channel-surface failures on a healthy WS).
- Calling `fetch_missed` when the ring is empty returns `{ messages: [] }` — the LLM's tool result shows "nothing missed" and the agent moves on.

### FR9. `registration_expired` reactive recovery

- When the hub receives a requestId-bearing frame from a WS with no registered agent mapping (`wsToAgent` miss), it responds with `{ event: "response", requestId, ok: false, error: "Not registered", registration_expired: true }`.
- The plugin's frame handler intercepts `registration_expired: true` BEFORE resolving the caller:
  1. Holds the original pending request (does not resolve yet).
  2. Sends a `register` frame with the plugin's stored name.
  3. On register success: re-sends the original frame with a fresh requestId. Resolves the original pending request with the retry's result.
  4. On register failure (name conflict): resolves the original pending request with the register error. Emits the existing "name taken, ask user" system notification.
- The LLM observes either the successful retry result or a meaningful register error — never the raw `registration_expired` signal.
- The retry happens exactly once; if the retry also returns `registration_expired`, the plugin resolves the pending request with an error and does not loop.
- If the retry returns a different error (e.g., recipient went offline between attempts, `Agent 'X' is not online.`), the plugin resolves the original pending request with that error verbatim — no special handling, no additional retry. The LLM sees the actual error.
- The silent re-register triggered by this path does NOT fire auto-redeliver (per FR7 gating on `restored: true`) and does NOT trigger `fetch_missed` auto-call.
- **Interaction with PR-#1 fork-session suffix logic:** the plugin's existing `autoRegisterWithRetry` retries the base name then `base-2`…`base-9` on collision. The FR9 silent re-register uses `storedName` verbatim (the already-chosen name, possibly suffixed) — it does NOT re-run the full suffix retry. If that specific stored name is itself taken during FR9 recovery (e.g., a racing session grabbed it), the retry fails and the LLM sees the register error. Do NOT extend FR9 to retry with new suffixes; the user or full reconnect cycle should handle that.

### FR10. Sender disconnect during ack wait (hybrid behavior)

- When a sender WS closes while the hub holds pending-ack trackers owned by that WS, the hub **detaches the sender-notification side but keeps the tracker alive for recipient-facing semantics**:
  1. Marks each pending-ack tracker owned by the disconnected WS as `sender_detached: true`. Clears the stored `sender_ws_identity` / `sender_request_id` (no notification target remains).
  2. Does NOT clear the timer. Timer continues ticking.
  3. On timer fire: proceeds with retention promotion (FR4 steps 2–4) exactly as if the sender were still connected, but skips step 1 (no sender to notify).
  4. On ack arrival from recipient while `sender_detached: true`: tracker is resolved-and-removed (ack path "wins" the race per FR4), but no sender notification is sent. Dashboard `message:acked` event still fires.
- Rationale: the sender's session may have evaporated, but the recipient's perspective must remain consistent — the message was delivered and deserves a retention fallback on timeout regardless of sender liveness. This matches the stated reliability goal (recipient-seen delivery) rather than sender-satisfaction.
- A sender that reconnects during the ack window does NOT re-attach to a detached tracker. The reconnected sender's `send_message` call has already been rejected client-side when the WS closed (plugin's request rejection on close); there is no original requestId to re-notify. Retention-side behavior is unchanged.
- Recipient that acks a detached-and-retained message (one that timed out and is now in the ring): hub returns `{ ok: true, data: { unmatched: true } }` silently; the retention entry is already consumed or pending consumption via fetch/redeliver.

### FR11. Ping, system, and auto-redelivered / fetched messages: the `no_ack` flag

- `InboundMessageFrame` gains an optional `no_ack?: boolean` field. When `true`, the plugin surfaces it through the channel notification's `meta` and the plugin instructions tell the LLM: "do not call `ack` for messages marked `no_ack: true`."
- Frames flagged `no_ack: true`:
  - Hub `ping` echoes (existing `from: "hub@claude-net"`).
  - System notifications emitted by `emitSystemNotification` (e.g., "name taken, pick a name").
  - Auto-redelivered direct entries (FR7).
  - Entries surfaced via `fetch_missed` (FR8).
- The hub never registers a pending-ack tracker for `no_ack: true` frames; they are fire-and-forget by design.
- If the LLM nevertheless calls `ack(message_id)` for a `no_ack` frame, the hub returns `unmatched: true` — safe but wasted round-trip. The instructions are explicit enough that a cooperating agent avoids this.

### FR12. Retention and pending-acks survive rename

PR #1 (squashed onto `squash-plan` as of this spec revision) adds a rename path: when `Registry.register()` is called with an existing `wsIdentity` but a different `fullName`, the old entry is dropped, its team memberships are inherited, and `renamedFrom: <old_fullName>` is returned.

MESSAGE_ACK must preserve its state across rename:

- **Retention ring:** on any successful register where `renamedFrom` is set, the hub moves the retention ring entry for `renamedFrom` to the new `fullName`. If both keys have entries (shouldn't happen in practice; the old key owns the history, the new key is fresh), the old key's entries win and any existing new-key entries are discarded (the new name is the same session continuing).
- **Pending-ack trackers:** iterate the pending-ack map; any tracker whose `recipient_full_name === renamedFrom` is updated to the new `fullName`. Any tracker whose `sender_full_name === renamedFrom` is updated to the new `fullName`. The reverse `ws_identity → message_ids` index is unaffected (WS identity didn't change during rename).
- **Dashboard events:** PR #1 already broadcasts `agent:disconnected` for `renamedFrom` and `agent:connected` for the new name; MESSAGE_ACK emits no additional rename events. In-flight `message:acked` / `message:timed_out` / `message:retained` events after rename reference the new `fullName` (consistent with the tracker migration above).
- **Auto-redeliver after rename:** FR7 fires on rename (see FR7 gating). Since the ring was just migrated in-place, the direct entries pushed on auto-redeliver are the same ones that would have reached the old name.
- **`fetch_missed` after rename:** returns the migrated ring contents for the new `fullName`, then clears.

Rationale: rename represents continuity of session identity (same WS, same user intent, new label); retention and in-flight ack semantics should follow that continuity transparently.

### FR13. Dashboard events

New events in `DashboardEvent`:
- `message:acked`: `{ event: "message:acked", message_id, from, to, accepted: bool, reason?, elapsed_ms, acker: "agent" | "hub-auto" | "hub-implicit-reply", timestamp }`.
  - Fires for both ack and nak (distinguished by `accepted` field).
  - `acker: "agent"` — explicit `ack` tool call from the recipient agent.
  - `acker: "hub-auto"` — synthesized by the hub for dashboard recipients (FR2).
  - `acker: "hub-implicit-reply"` — synthesized from a `reply_to`-bearing direct send (FR3 implicit ack).
- `message:timed_out`: `{ event: "message:timed_out", message_id, from, to, timeout_ms, timestamp }`.
- `message:retained`: `{ event: "message:retained", message_id, recipient, kind: "direct" | "broadcast" | "team", timestamp }`.

Modified event:
- `message:routed` gains an optional `pending_ack: boolean` field — true when the hub has a pending-ack tracker open for this message at routing time (only for direct sends to non-dashboard recipients). Existing dashboard clients ignoring the field continue to work.

No new dashboard events for redelivery or `fetch_missed` (FR7, FR8) — these are recipient-internal plumbing.

## Architecture

### Hub state additions

In `src/hub/`, add a new module (proposed name: `pending-acks.ts`) managing:
```
// Pending direct-message ack trackers
PendingAck = {
  message_id: string
  sender_full_name: string
  sender_ws_identity: object | null   // ws.raw reference, null after FR10 detach
  sender_request_id: string | null    // null after FR10 detach
  recipient_full_name: string
  content: string
  type: "message" | "reply"
  reply_to?: string
  timestamp: string
  deadline: number             // Date.now() + effective_timeout_ms
  effective_timeout_ms: number
  timer: Timer
  sender_detached: boolean     // true after sender WS close per FR10
}

Map<message_id, PendingAck>

// Also: reverse index for sender-disconnect cleanup
Map<ws_identity, Set<message_id>>
```

In a sibling module (proposed: `retention.ts`), a per-recipient ring:
```
RetentionEntry = {
  message_id: string
  kind: "direct" | "broadcast" | "team"
  from: string
  to: string                   // original `to` (for team: "team:<name>"; for broadcast: "broadcast")
  content: string
  type: "message" | "reply"
  reply_to?: string
  team?: string
  timestamp: string
  expires_at: number           // Date.now() + 6h
}

Map<recipient_full_name, RetentionEntry[]>  // ring, newest at tail
```

Periodic sweep: `setInterval(sweepExpired, 5 * 60_000)` started at hub boot, cleared on shutdown.

### Hub message flow changes

Modifications to `src/hub/router.ts` and `src/hub/ws-plugin.ts`:

1. **Direct send path** (`ws-plugin.ts` `case "send":`):
   - Before: synchronously calls `router.routeDirect`, responds to sender immediately.
   - After: clamp `data.timeout_ms` to [1000, 300000] (default 60000 if unset); call it `effective_timeout_ms`. If recipient resolves to `dashboard@hub`/`dashboard`, delegate to dashboard auto-ack path (sync; emits `message:acked` with `acker: "hub-auto"`). Otherwise, call `router.routeDirect` to deliver the frame, then register a `PendingAck` with `setTimeout(effective_timeout_ms)`. Do NOT send the sender's response yet. Emit `message:routed` with `pending_ack: true`.
   - On ack frame arrival: **atomic tracker lookup-and-remove** (`map.delete` returns true iff winner). Winner resolves pending request with `outcome: "acked"` (if sender not detached). Clears timer. Emits `message:acked` (`acker: "agent"`).
   - On nak frame arrival: same atomic remove; winner resolves with `outcome: "naked"`. Clears timer. Emits `message:acked` (`acker: "agent"`, `accepted: false`).
   - On timer fire: atomic tracker lookup-and-remove. Winner appends to recipient's retention ring; resolves sender with timeout error (skipped if `sender_detached: true`); emits `message:timed_out` + `message:retained`.
   - On sender WS close: look up reverse index, for each tracker owned by this WS set `sender_detached: true`, clear `sender_ws_identity` and `sender_request_id`. Do NOT clear timer. Do NOT remove tracker. (See FR10 hybrid.)
   - Implicit ack: when handling a `send` frame (direct, NOT `send_team` or `broadcast`) with `reply_to=X`, after routing, check if `X` is a pending_ack whose `sender_full_name` matches the current frame's resolved recipient `fullName`. If so, atomic-remove the tracker and resolve it as acked (emits `message:acked` with `acker: "hub-implicit-reply"`). The current `send` frame itself still routes normally with its own new `message_id` and may start its own pending-ack tracker (new send, new tracker).

2. **Broadcast send path**: after the existing loop, for each recipient that received the frame, append a retention entry with `kind: "broadcast"`. No behavioral change to sender response.

3. **Team send path**: same as broadcast, with `kind: "team"` and `team: <name>` on the entry.

4. **New frame action `ack`**: plugin sends `{ action: "ack", message_id, accepted, reason?, requestId }`. Hub performs atomic tracker lookup-and-remove:
   - If tracker found and sender attached: resolve sender pending request with acked/naked outcome, emit `message:acked`, respond `{ ok: true, data: { matched: true } }`.
   - If tracker found and sender detached (FR10): emit `message:acked` (still useful observability), respond `{ ok: true, data: { matched: true, sender_gone: true } }`. No notification to sender.
   - If tracker not found (unknown id, or already resolved by timer/another ack): respond `{ ok: true, data: { unmatched: true } }`. This is the non-error case for ack-on-no_ack-frame, ack-after-timeout, duplicate acks, acks on retained messages, etc.

5. **New frame action `fetch_missed`**: plugin sends `{ action: "fetch_missed", requestId }`. Hub retrieves recipient's ring, clears it (by clearing `kind: "broadcast"`/`"team"`/leftover direct entries — which should be rare since auto-redeliver removes `direct` on connect). Responds with `{ ok: true, data: { messages: [...] } }`.

6. **Register path changes**: on successful registration, check the registry result's `restored: true` flag OR "no prior entry existed" condition (FR7 gating). If so, trigger auto-redeliver: iterate ring, send `kind: "direct"` entries as `InboundMessageFrame` with `no_ack: true`, remove direct entries from ring. If `restored: false` AND an existing same-identity entry was updated (the FR9 silent recovery path), skip auto-redeliver.

7. **Unregistered-frame handling**: when `requireRegistered` returns null, the error response now includes `registration_expired: true`.

### Plugin changes (`src/plugin/plugin.ts`)

**Single-file constraint reminder:** `plugin.ts` is served verbatim by the hub at `GET /plugin.ts` and cannot import from `src/shared/`. All type additions in `src/shared/types.ts` (`AckFrame`, `FetchMissedFrame`, `registration_expired` on `ResponseFrame`, `no_ack` on `InboundMessageFrame`, `timeout_ms` on `SendFrame`) MUST be duplicated inline in the plugin's type-alias block (currently plugin.ts:22-59). This duplication is intentional; the hub and plugin must stay in sync but cannot share source. Implementation plan should treat "update plugin inline types" as an explicit subtask alongside any `src/shared/types.ts` change.

**Plugin-side request timeout for `send` frames:** the plugin's `REQUEST_TIMEOUT_MS = 10_000` (plugin.ts:63) currently rejects any hub round-trip after 10 seconds. This is too short for the new `send` flow, which may legitimately block up to 300 seconds (hub-side clamp). The plugin must either:
- (a) Exempt `send` frames from the 10s timeout and let the hub-side clamp govern (preferred — the hub's clamp is authoritative). Replace `REQUEST_TIMEOUT_MS` with a per-frame policy: `send` → no plugin-side timeout (rely on hub), all other frames → keep 10s default.
- (b) Extend the plugin-side timeout to match the hub's max (300s) for `send` frames specifically, passing the effective `timeout_ms` through so the plugin clamps just after the hub.
Either works; (a) is simpler. Spec allows (a).

New state:
```
const pendingRequests: Map<requestId, ...>   // existing
// No new persistent state; registration_expired retries are request-scoped.
```

Modified handlers:
- `request()`: accepts an optional `timeoutMs` parameter (default 10s). For `send` frames, pass `Infinity` (or simply skip setting the rejection timer).
- `handleHubFrame` `case "response"`: if response has `ok: false` and `registration_expired: true`, start the recovery flow (FR9) instead of rejecting immediately.
- `handleHubFrame` `case "message"`: propagate `no_ack: true` (when present) into the channel notification `meta` as the string `"true"`.
- `ws.on("close")`: iterate `pendingRequests`; for every pending `send` frame, reject with an error like `"Hub disconnected before acknowledgement. Message delivery is uncertain."` Without this, `send` frames hang indefinitely on hub restart / WS drop since they have no plugin-side timeout.
- `shutdown()`: already rejects all `pendingRequests` — no change needed, just ensure the new no-timeout behavior doesn't bypass this path.

New tool definitions:
- `ack` — see FR3.
- `fetch_missed` — see FR8. Tool returns summary to LLM ("fetched N missed messages and surfaced them as channel notifications"); actual message content arrives as channel notifications, not tool result text, so the LLM reads them inline.

Modified tool definitions:
- `send_message` — adds optional `timeout_ms` parameter.

Modified instructions (INSTRUCTIONS constant) — see "Plugin Instructions" section below.

### Shared types (`src/shared/types.ts`)

New plugin→hub frames:
```typescript
export interface AckFrame {
  action: "ack";
  message_id: string;
  accepted?: boolean;
  reason?: string;
  requestId?: string;
}

export interface FetchMissedFrame {
  action: "fetch_missed";
  requestId?: string;
}
```
Added to `PluginFrame` union.

Modified `SendFrame`:
```typescript
export interface SendFrame {
  action: "send";
  to: string;
  content: string;
  type: MessageType;
  reply_to?: string;
  timeout_ms?: number;
  requestId?: string;
}
```

Modified `ResponseFrame`:
```typescript
export interface ResponseFrame {
  event: "response";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  registration_expired?: boolean;  // NEW
}
```

Modified `InboundMessageFrame`:
```typescript
export interface InboundMessageFrame {
  event: "message";
  message_id: string;
  from: string;
  to: string;
  type: MessageType;
  content: string;
  reply_to?: string;
  team?: string;
  timestamp: string;
  no_ack?: boolean;  // NEW — true for ping echoes, system notifications, auto-redelivered entries, fetch_missed results
}
```

The plugin's `createChannelNotification` helper propagates `no_ack: true` into the MCP notification `meta` (as the string `"true"` — meta values are strings). Plugin instructions reference this field.

New dashboard events:
```typescript
export interface MessageAckedEvent {
  event: "message:acked";
  message_id: string;
  from: string;
  to: string;
  accepted: boolean;
  reason?: string;
  elapsed_ms: number;
  timestamp: string;
}

export interface MessageTimedOutEvent {
  event: "message:timed_out";
  message_id: string;
  from: string;
  to: string;
  timeout_ms: number;
  timestamp: string;
}

export interface MessageRetainedEvent {
  event: "message:retained";
  message_id: string;
  recipient: string;
  kind: "direct" | "broadcast" | "team";
  timestamp: string;
}
```
Added to `DashboardEvent` union.

Modified `MessageRoutedEvent`:
```typescript
export interface MessageRoutedEvent {
  // existing fields...
  pending_ack?: boolean;  // NEW
}
```

## Plugin Instructions (new `INSTRUCTIONS` text)

The existing `INSTRUCTIONS` constant in `src/plugin/plugin.ts` needs to be rewritten. Proposed text for the new sections (other sections retained as-is, with the "MESSAGES ARE EPHEMERAL" block removed):

```
MESSAGE ACKNOWLEDGEMENT (required):

Every inbound <channel> tag from claude-net carries a message_id. You MUST
acknowledge each one by calling ack(message_id) before your turn ends,
UNLESS you respond with send_message(..., reply_to=message_id), which
counts as an implicit ack — no separate ack call needed in that case.

The sender is waiting for your ack (their send_message tool is blocked).
If you don't ack within ~60 seconds the sender's tool call fails with a
timeout error and their downstream logic may stall. Ack promptly.

Rejection (NAK):
If you received a message that you cannot or will not handle for
STRUCTURAL reasons (wrong recipient, references a reply_to id you don't
know, malformed content, content is for a different agent's role), call
ack(message_id, accepted=false, reason="<short explanation>"). The sender
sees this as a distinct "naked" outcome and will not retry the send.

NAK is NOT for judgment calls — if you CAN handle the message but are
choosing not to, that's an ack + a polite reply, not a nak. Reserve nak
for cases where handling is structurally impossible.

Broadcast and team messages do not require acks; they are fire-and-forget
on the sender side. You can still respond to them, but you don't need to
ack them.

Some <channel> tags are flagged "no_ack" in their meta (e.g., hub pings,
system notifications, auto-redelivered messages surfaced on reconnect,
messages from fetch_missed). Do NOT call ack for these — they have no
sender waiting. If you see meta.no_ack, just read the content and respond
as appropriate (usually no response is needed).

CATCHING UP ON MISSED MESSAGES:

On reconnect the plugin automatically fetches messages held for you by
the hub (from broadcast/team sends while you were offline, or direct
sends whose ack timed out). They arrive as normal <channel> tags with
timestamps showing when they were originally sent.

If you suspect you missed a message while connected (you got a response
referencing a message_id you don't recognize, or a collaborator says
"did you get X?"), call fetch_missed to pull anything the hub is still
holding for you.

Messages retrieved via fetch_missed or auto-fetch do NOT need to be
acked — the original sender has long since moved on.
```

Additional tool-description updates:
- `send_message` description: append "Blocks until the recipient acks, naks, or the ack times out (default 60s, configurable via timeout_ms up to 300s). On timeout the message is held on the hub for the recipient to catch up on reconnect or via fetch_missed."
- The existing "MESSAGES ARE EPHEMERAL — NO QUEUE" block is replaced entirely; new semantics are NOT ephemeral for direct.

## Error Handling

- **Sender receives timeout:** tool returns MCP error. LLM reads the error message, which includes the `message_id` and notes the hub is holding the message. LLM's correct next action: inform the user, optionally retry via explicit instruction, or switch to a different recipient.
- **Sender receives nak:** tool returns success with `outcome: "naked"`. LLM reads `reason`, adjusts approach. Should NOT blindly retry.
- **Recipient plugin fails to emit MCP notification** (e.g., transport crashed): the plugin cannot detect this from its own side. Sender's ack timeout fires. Message lands in retention. Recipient's plugin recovers; next `fetch_missed` (auto or manual) surfaces the held message.
- **Ack for unknown message_id:** hub responds `{ ok: true, data: { unmatched: true } }`. Plugin surfaces this as a normal tool result; LLM treats "unmatched" as informational — the ack was safe to call but didn't correspond to an active tracker.
- **`send_message` while not registered:** currently returns a not-registered error. Under FR9, the plugin catches this via `registration_expired` and retries silently. LLM only sees the final result.
- **Hub clamps excessive `timeout_ms`:** values >300_000 are clamped. The hub echoes the effective value in the acked/naked response `data.effective_timeout_ms` so the sender can detect clamping. On timeout, the error message uses the clamped value ("No acknowledgement within 300s. ..."). Sub-1s values are clamped up to 1000ms (prevent pathological fast-fail).
- **Retention ring overflow:** silent FIFO eviction. No error, no dashboard event (can be added later if observability needs it).

## Performance Requirements

- Pending-ack map size: bounded by `(online_agents × concurrent_sends_per_agent)`. For typical use (small handful of agents, single-digit in-flight sends) this is trivial.
- Retention ring total memory: `(registered_full_names × 5 entries × ~1KB typical)`. At 100 registered identities, ~500KB. Not a concern.
- Ack timer fires per in-flight direct send. Each timer is cleared on ack/nak or fires once on timeout. Standard `setTimeout`/`clearTimeout` behavior.
- Periodic sweep: every 5 min, iterates retention map to evict expired entries. O(total entries). At hub-scale above, <1ms.
- Sender latency on success path: ack arrives in recipient's next turn, typically 1–10s; success case completes in that window.
- Sender latency on failure path: up to `timeout_ms` (default 60s, max 300s). Sender's Claude is blocked on the tool call for this duration.

## Security Considerations

No changes to trust model. The ack frame is agent-authored like all other plugin frames; a malicious or buggy agent can spoof an ack for a `message_id` it never received if it knows the ID. The ID is a server-generated UUID not shared outside the sender/recipient pair, so this requires insider knowledge. Accepted — matches existing trust model.

NAK `reason` is free-text up to 500 chars. Plugin truncates if exceeded. Sender's LLM is the audience; no SQL/XSS surface.

## Testing Strategy

### Unit tests

New tests in `tests/hub/` for the new modules:
- `tests/hub/pending-acks.test.ts`: register/resolve/timeout/cancel-on-disconnect flows.
- `tests/hub/retention.test.ts`: append/fifo-evict-on-cap/ttl-expire/clear-on-fetch/direct-vs-broadcast-kinds.
- Extend `tests/hub/router.test.ts`: dashboard auto-ack, implicit ack via reply_to, retention promotion on timeout.
- Extend `tests/hub/registry.test.ts`: auto-redeliver on successful register (integration concern — may live in integration tests instead).

New tests in `tests/plugin/`:
- `plugin.test.ts` extensions for `registration_expired` retry flow and `fetch_missed` auto-call on register.

Extend `tests/shared/types.test.ts` for new frame discriminated-union coverage.

### Integration tests

New `tests/integration/ack.test.ts` covering:
- I1. Send → recipient acks → sender sees `outcome: "acked"`.
- I2. Send → recipient naks → sender sees `outcome: "naked", reason`.
- I3. Send → recipient never acks → sender sees timeout error after `timeout_ms`.
- I4. Send → timeout → recipient reconnects → recipient sees auto-redelivered message as a channel notification.
- I5. Broadcast → recipient goes offline → reconnects → calls `fetch_missed` → gets held broadcast.
- I6. Sender disconnects during ack wait → pending tracker cleaned up → recipient's later ack is unmatched.
- I7. Plugin receives `registration_expired` → silently re-registers → original frame retried → LLM sees successful result.
- I8. Reply-to implicit ack: sender sends → recipient calls `send_message(reply_to=id)` → sender's pending ack resolves as acked.
- I9. `send_message(to="dashboard", ...)` with dashboard connected → immediate `outcome: "acked"`; with no dashboard connected → existing error.
- I10. Retention cap: send 6 messages to offline recipient via broadcast (or 6 direct timeouts) → reconnect → only last 5 arrive.
- I11. Retention TTL: send, wait >6h (fake time), recipient reconnects → nothing redelivered.
- I12. `timeout_ms` override honored; clamp at 300s (and at 1s on the low end).
- I13. Concurrent direct sends from same sender to same recipient: 3 messages in flight; recipient acks them out of order (middle first, then oldest, then newest). Each pending-ack resolves independently; no cross-tracker confusion.
- I14. Ack-vs-timeout race: fire timer and submit ack frame in the same tick → exactly one path executes the resolution; the loser is a no-op; no duplicate dashboard events emitted.
- I15. Sender disconnect mid-wait (hybrid): sender sends → hub holds tracker → sender WS closes → timer fires → retention ring receives the entry (not skipped) → recipient reconnects → auto-redeliver pushes it.
- I16. Sender disconnect then reconnect within ack window: original tracker stays detached; reconnected plugin does NOT see the original response; if timer fires during reconnection window, retention promotion still happens.
- I17. Team-reply does NOT implicit-ack: A direct-sends to B; B replies via `send_team` with `reply_to=X` → B's explicit `ack(X)` is still required; sender times out or gets explicit ack, NOT implicit.
- I18. `no_ack` propagation: ping echo, system notification, auto-redelivered entry, fetch_missed entry — all surface with `meta.no_ack: "true"`; plugin does NOT register a tracker; explicit LLM ack returns `unmatched`.
- I19. FR9 retry with fresh error: unregistered WS → hub responds with `registration_expired` → plugin re-registers → retries send → recipient is offline → plugin resolves LLM with `"Agent 'X' is not online."`, no loop.
- I20. FR9 does NOT trigger auto-redeliver / fetch_missed — only a fresh `restored: true`-or-new register does.
- I21. Rename preserves retention and pending-acks: register A with name X, send timed-out direct to X → ring has entry; rename to Y (same WS, different name) → ring entry appears under Y; sender gets timeout error referencing X's message_id; recipient's auto-redeliver on rename pushes the retained entry under Y.
- I22. Rename during in-flight ack: A sends to X, pending-ack active; X renames to Y; X's `ack(message_id)` resolves sender's wait as acked. Dashboard `message:acked` shows the new name Y as the `to` (or `from` if the role reversed).

### Manual / dashboard tests

- Dashboard shows `pending_ack` indicator on routed messages.
- Dashboard shows `message:acked` / `message:timed_out` / `message:retained` events in the live log.
- Reinstalling a client's plugin after hub upgrade works via the existing `/setup` flow.

## Deployment / Migration

- The hub and plugin ship together. Bumping the hub deploys the new plugin at `/plugin.ts`. Clients must re-run `GET /setup` to pull the fresh plugin.
- Stale cached plugins connecting to a new hub: they won't send `ack` frames, so every send to them will time out. Symptom is obvious. Mitigation: `install-channels` installer should either cache-bust or log a version line the user can eyeball.
- No data migration: the hub has no persistent storage; all in-memory state is rebuilt on restart.
- During the hub restart, in-flight pending acks are lost (hub process exits, senders' WS connections close, plugin-side `pendingRequests` map rejects on disconnect). All retention rings are also lost since they live in hub memory.

## Known behavioral edge cases (documented, not defects)

- **Plugin restart mid-ack-wait (recipient side):** the recipient's plugin crashes/restarts while its LLM was mid-ack. The new plugin process has no in-memory knowledge of the prior message. If the LLM re-runs and calls `ack(message_id)` for a message it saw pre-crash, the hub responds `unmatched: true` (either the tracker already timed out, or a new tracker exists for a different message). The LLM surfaces this as informational only. The pre-crash message, if it timed out, landed in the recipient's retention ring and will be auto-redelivered on the plugin's successful re-register (assuming `restored: true`).
- **Plugin restart mid-ack-wait (sender side):** sender's plugin crashes after sending. Plugin's `pendingRequests` map dies with the process. Hub detects sender WS close → FR10 hybrid kicks in (tracker detached, timer continues, retention promotion still fires). When the sender's Claude Code restarts (new session, new plugin, possibly new `fullName`), it has no memory of the pending `send_message` call.
- **Hub restart during ack-wait:** all pending-ack trackers evaporate; plugin-side `pendingRequests` for `send` frames will never resolve. Until auto-reconnect kicks in on the client plugin, the sender's tool call hangs. Because per the spec (Plugin changes) `send` frames have no plugin-side timeout, the hang is bounded only by the client's WS reconnect. On reconnect, the plugin fires `register` again; the original `send` request remains orphaned in the plugin's `pendingRequests` map. Workaround: plugin should walk and reject all `action: "send"` pending requests in its `close` handler with a `"Hub disconnected"` error. Spec calls this out as required behavior; existing close handling is silent, needs updating.
- **Concurrent sends out of order:** nothing special required — each send gets its own tracker and timer; the hub map is keyed by `message_id`. Out-of-order acks resolve the right ones. See integration test I13.
- **Implicit-ack boundary:** only direct `send` with matching recipient triggers implicit ack. All other shapes (team, broadcast, send to a different recipient) leave the tracker untouched. See integration test I17.
- **Dashboard auto-ack visibility:** the `message:acked` event for a dashboard recipient fires with `acker: "hub-auto"` and minimal `elapsed_ms`. Dashboard UIs that highlight slow acks should filter by `acker` to avoid skewing latency histograms.

## Dependencies

No new dependencies. All additions use existing runtime capabilities (`setTimeout`, `Map`, `crypto.randomUUID`, Elysia ws plugin, MCP SDK).

## Open Questions (deferred, not blocking implementation)

- OQ1. Should the hub emit a "buffer overflow" dashboard event when FIFO eviction drops an entry? Currently silent (FR6 end). Add later if observability gap becomes annoying.
- OQ2. Should `fetch_missed` be rate-limited? An agent auto-calling it on every register is fine; an LLM that decides to spam it would generate load. Trivial for now; add if needed.
- OQ3. Ack latency metric exposure: `elapsed_ms` on ack/nak/timeout is captured in dashboard events but not exposed via `/api`. Worth a `/api/ack-stats` endpoint later for debugging.
- OQ4. Implicit-ack via `reply_to` relies on the current message's sender matching the pending-ack's recipient. If a cross-agent relay pattern ever emerges (agent A sends reply-to to X but X's sender is agent B, not A), implicit ack won't fire. Acceptable — the scenario is contrived.

## Next Steps

1. Architecture/purpose consistency review of this spec.
2. Run `/idea-plan-execute:02-plan-spec docs/MESSAGE_ACK_SPEC.md` to produce phased implementation plan.
3. Execute phases.

---
*Generated with /idea-plan-execute:01-explore-spec on 2026-04-22 from docs/MESSAGE_ACK_BRAINSTORM.md*
