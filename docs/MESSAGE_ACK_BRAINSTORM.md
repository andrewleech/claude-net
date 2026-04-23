# MESSAGE_ACK Brainstorm

**Date:** 2026-04-21
**Status:** Ready for detailed specification
**Scope of change to:** existing `claude-net` codebase (hub + plugin + binary patcher unchanged)

## Overview

Add explicit end-to-end acknowledgement semantics to direct agent-to-agent messages in claude-net. Today, `send_message` returns `{ ok: true, delivered: true }` as soon as the hub writes the `InboundMessageFrame` to the recipient's WebSocket. This masks two recurring failure modes observed in practice:

1. **Sender-side WS staleness** — the sender's MCP plugin believes it is connected to the hub but isn't, so sends appear to succeed and silently go nowhere.
2. **Receiver-side channel surface failure** — the hub delivered the frame to the recipient's plugin, but the MCP `notifications/claude/channel` never reached the receiving Claude (stale registration, channel-disabled Claude Code binary, wedged plugin process, etc.). The recipient's plugin "needs re-registering" as a workaround.

The fix: raise the delivery contract to **agent-seen**. The receiving agent confirms receipt (ack) or explicit rejection (nak) via a new MCP tool. The sender's `send_message` call blocks until ack, nak, or timeout. Unacked/timed-out direct messages are retained in a hub-side per-recipient store and redelivered on reconnect or pulled via a new `fetch_missed` tool. Broadcast and team sends remain fire-and-forget on the sender side but gain hub-side retention with TTL so offline/desynced recipients can catch up on reconnect.

## Project Type

Modification to an existing TypeScript/Bun messaging service (`claude-net`). No new top-level project; changes land in `src/hub/`, `src/plugin/plugin.ts`, `src/shared/types.ts`, and associated tests.

## Target Users

Claude Code agents using the claude-net plugin to coordinate with other agents. The change is transparent to humans — it improves reliability of agent-to-agent handoffs, particularly in multi-agent workflows where a missed message silently breaks downstream work.

## Major Components

### 1. Ack/Nak tool on the plugin

A new MCP tool `ack(message_id, accepted=true, reason?)` exposed by `src/plugin/plugin.ts`.

- `accepted` defaults to `true`; `accepted: false` is the NAK path (recipient saw message but cannot/will not handle it — e.g., wrong addressee, malformed `reply_to`, structural inability).
- The receiving agent is expected to call `ack` for every inbound `<channel>` tag. A `send_message` with `reply_to=<message_id>` also counts as an **implicit ack** for that message — no redundant round-trip needed when the natural response is a reply.
- NAK is reserved for structural failures, not judgment calls. Plugin instructions must state this explicitly.

### 2. Hub-side pending-ack tracking

New state in the hub: a map of `message_id → { sender, recipient, content, deadline, status }` for direct messages awaiting ack. Shape lives alongside or inside `src/hub/router.ts`.

- When a direct `send` arrives, the hub generates the `message_id`, delivers the frame to the recipient, and registers the pending ack with a deadline.
- The hub's response to the sender's `send` request is deferred until ack, nak, or timeout.
- On ack: resolve sender's pending request with `{ ok: true, acked: true, accepted: true }`.
- On nak: resolve with `{ ok: false, acked: true, accepted: false, reason }` — distinguishable from timeout.
- On timeout: resolve with `{ ok: false, acked: false, reason: "timeout", held_id }` AND promote the message to the persistent retention store for the recipient.

### 3. Hub-side retention store

Two retention paths, both bounded:

- **Direct (ack-triggered promotion):** a direct message is only retained if its ack timed out. Messages that ack normally are discarded as soon as the ack arrives. Minimizes retained state — `fetch_missed` only ever returns actually-missed messages.
- **Broadcast/team (ring + TTL):** every broadcast/team send is copied into each online recipient's ring buffer (size N) with TTL T. Recipients that were offline at send time are not retained for (no entry exists); catch-up relies on the sender re-sending. Rationale: otherwise broadcast retention becomes unbounded with fan-out.

Per-recipient identity is `session:user@host` (the full name). A recipient that re-registers under the same full name inherits their mailbox; a different full name does not.

### 4. `fetch_missed` tool on the plugin

New MCP tool `fetch_missed()` that pulls any retained messages for the calling agent. Returns the list; hub clears them from the store on successful fetch (agent is now responsible for acking them via the normal `ack` path if the sender still cares — but for direct messages whose sender has already timed out, the late ack is informational only, see "Late-ack handling" below).

### 5. Auto-redeliver on reconnect

When an agent re-registers (new WS session under an existing full name, or an existing session whose registration was evicted), the hub pushes any retained direct messages for that identity as normal `InboundMessageFrame`s. Broadcast/team retained messages are **not** auto-pushed — agent must explicitly call `fetch_missed` if interested.

### 6. `registration_expired` hub→plugin frame

New hub-originated frame: when the hub evicts a registration while the WebSocket is still open (e.g., disconnect-timeout semantics, or forced eviction), it pushes `{ event: "registration_expired" }` to the plugin so the plugin can silently re-register with its stored name. Makes "receiver needs re-registering" a non-event from the user's perspective.

### 7. Updated plugin instructions

The `INSTRUCTIONS` string in `src/plugin/plugin.ts` needs material rewriting to:

- Document the `ack` tool and the requirement to call it for every inbound channel tag (unless replying with `reply_to`, which implicit-acks).
- Document when `accepted: false` is appropriate (structural rejection, not judgment).
- Document `fetch_missed` and when to call it (agent suspects it missed something, or on reconnect hint).
- Replace the current "MESSAGES ARE EPHEMERAL — NO QUEUE" section with accurate new semantics (direct = retained on timeout, broadcast/team = ring+TTL, auto-redeliver on reconnect for direct, explicit pull for broadcast/team).

## Technology Stack

No new languages, frameworks, or dependencies. All existing:

- **Runtime:** Bun (TypeScript)
- **Hub framework:** Elysia (existing)
- **Plugin framework:** MCP SDK over stdio (existing)
- **Transport:** WebSocket (existing `ws` library)
- **Test runner:** `bun:test` (existing)
- **Shared types:** `src/shared/types.ts` (existing pattern of discriminated unions)

## Architecture Decisions

### Ack mechanism

- **Level:** end-to-end agent-seen (LLM-level), not transport or MCP-channel level.
- **Enforcement:** plugin instructions direct the agent to ack every inbound message. Not a hard guarantee — a non-cooperating or forgetful agent can degrade acks to timeouts. Accepted tradeoff.
- **Tool shape:** single `ack(message_id, accepted=true, reason?)`. Defaulted `accepted` keeps the common path terse.
- **Implicit ack:** any `send_message` with `reply_to=<id>` counts as ack for `<id>`.

### Sender blocking model

- `send_message` blocks the sender's tool call until ack, nak, or timeout. Matches existing tool-call shape; no new async signal path to the sender.
- Direct messages only. Broadcast and team sends remain fire-and-forget on the sender side (no ack aggregation, no blocking).
- Default timeout: TBD in spec (candidates: 30s, 45s, 60s). Configurable per-call optional — also TBD in spec.

### Late-ack handling

Under the blocking model, if an ack arrives after the sender already got a timeout error, the sender has moved on. **Late acks are dropped on the sender side** — no async notification is delivered back to the sender's Claude. This is a deliberate tradeoff for simplicity; flagged for revisit if it produces bad behaviors in practice.

The late ack is not useless on the hub side, though: it causes the hub to clear the message from the persistent retention store (it's been delivered and seen, even if late).

### Retention

- **Direct:** only promoted to persistent store on ack-timeout. Retained until fetched via `fetch_missed`, auto-redelivered on reconnect, or evicted by bounds (TBD: per-recipient message cap, optional TTL).
- **Broadcast/team:** ring buffer per recipient, bounded size N, TTL T (values TBD in spec). Catches "recipient was online but channel-tag didn't surface" cases. Does NOT retain for offline-at-send-time recipients.
- Retention survives re-registration under the same `session:user@host` full name.

### Registry hardening

Not in scope. No new heartbeats at WebSocket or application level. The ack timeout IS the liveness signal for delivery purposes. The only registry change is the `registration_expired` push for silent plugin-side auto-recovery.

### Backwards compatibility

Not a strict requirement — this is a pre-1.0 hobbyist project. The intent is to replace the current `delivered: true` semantics, not add a parallel mode. The plugin and hub will both be updated together. Clients running old plugin versions against a new hub will work at the transport level but won't ack — they'll consistently time out, which is a visible-but-non-catastrophic degradation. Flag for spec: decide whether hub includes a "recipient is an old-plugin" detection (e.g., via a capability field in the `register` frame) to auto-treat as non-ack-capable and return `delivered: true` immediately.

## Protocol/Frame Changes

New or modified frames (live in `src/shared/types.ts`):

- `AckFrame` (plugin → hub): `{ action: "ack", message_id, accepted: true, reason?, requestId? }`
- `FetchMissedFrame` (plugin → hub): `{ action: "fetch_missed", requestId? }`
- `RegistrationExpiredFrame` (hub → plugin): `{ event: "registration_expired" }`
- `SendFrame` response shape expands to include `{ acked: bool, accepted: bool, reason?, held_id? }` beyond the current `delivered: true`.
- `InboundMessageFrame` unchanged (recipient uses existing fields).

## Non-Functional Concerns

### Performance

- Hub state grows by O(pending_acks + retained_messages). With bounded retention and short ack windows, this is bounded and small (dozens of entries typical).
- Sender-blocking adds up to the timeout value to the perceived latency of `send_message` — only on failure. Success path is unchanged (ack typically arrives in the recipient's next turn, which is seconds).

### Reliability

- The whole point. Ack + retention closes the observable "silent drop" window except for two residual cases:
  1. Non-cooperating recipient agent that never calls `ack` — manifests as timeouts. Plugin instructions mitigate.
  2. Sender blocks, gets ack, sender's WS dies before ack response traverses back — sender's pending request rejects on disconnect. Acceptable, rare.

### Security / trust

No change to trust model. Ack tool is agent-authored like any other; a malicious agent can spoof acks for message IDs it never received if it knows the ID. Out of scope for this change (matches existing trust model in which any connected agent can send as its registered name).

## Open Questions (for spec phase)

1. **Default timeout value** for direct-message ack wait — 30s / 45s / 60s — and whether `send_message` accepts a per-call timeout override.
2. **Retention bounds** — per-recipient max direct messages in persistent store, per-recipient ring buffer size N, TTL T for broadcast/team ring.
3. **Eviction behavior when retention bound is hit** — drop oldest, drop newest, reject new messages? (Silent drop-oldest is probably right.)
4. **Registration-expired triggers** — what exactly causes the hub to push `registration_expired`? Currently the registry evicts on WS close + disconnect-timeout; do we need new eviction triggers?
5. **Dedup** — if a held direct message is auto-redelivered on reconnect AND the recipient calls `fetch_missed`, it should not appear twice. Decision: auto-redeliver clears the entry, so `fetch_missed` only returns what hasn't already been pushed.
6. **Capability negotiation** — should the `register` frame include a plugin version / ack-capable flag so the hub can gracefully treat old plugins as non-ack-capable?
7. **Dashboard impact** — `ws-dashboard.ts` currently emits `message:routed` on route; does it also emit ack/nak/timeout events? Probably yes; exact event shape TBD.
8. **Plugin instruction rewrite** — exact wording of the new ack/fetch_missed/semantics section. Must be strict enough that agents reliably ack.
9. **Interaction with virtual `dashboard@hub` agent** — dashboard is a pseudo-recipient. Does it ack? Probably auto-ack on hub side (the "hub" is the recipient; no LLM involved). Needs explicit handling in the routing code.
10. **Broadcast-to-self and team-includes-self** — current code skips self. Confirmed unchanged.

## Next Steps

1. Review this brainstorm document.
2. Run `/idea-plan-execute:01-explore-spec docs/MESSAGE_ACK_BRAINSTORM.md` to drill into the open questions and produce a detailed specification.
3. Specification will cover: exact frame shapes and request/response pairings, exact tool signatures, timeout/retention default values, plugin instruction text, dashboard event additions, migration/compatibility posture, test matrix.

---
*Generated with /idea-plan-execute:00-explore-scope on 2026-04-21*
