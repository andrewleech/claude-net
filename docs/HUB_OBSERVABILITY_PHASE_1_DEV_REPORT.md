# Hub Observability — Phase 1 Dev Report

Feature: Hub Observability
Phase: 1 (EventLog module + emit wiring + REST API)
Branch: `feature/hub-observability`
Status: Complete (build + all tests + lint green)

## Scope

Phase 1 implements the ring-buffer event log, emit calls in the hub's
WebSocket integration layer and the ping tick, and two query endpoints
under `/api/events*`. MCP tool and dashboard changes are out of scope
(Phase 2).

## Files changed

### New

- `src/hub/event-log.ts` — `EventLog` class. Bounded ring buffer with
  `push`, `query({event?, since?, limit?, agent?})`, `summary(since?)`,
  `oldestTs()`, and `capacity`/`size` accessors. Uses a pre-allocated
  `Array<HubEvent | null>` with head pointer and saturating count; all
  operations are O(capacity) at worst, O(1) for push. `query` returns a
  fresh array in chronological order; `limit` keeps the most recent
  matches when results overflow. Event name matching requires a dot
  boundary (`agent` matches `agent.registered` but not `agentic.x`).
- `tests/hub/event-log.test.ts` — 18 unit tests covering push, FIFO
  eviction after wrap, capacity validation, all query filters
  (exact / prefix / since / limit / agent / combined), prefix boundary
  safety, summary windowing, and `oldestTs` behavior.
- `tests/integration/event-log.test.ts` — 13 integration tests spinning
  up a real hub via `createHub`. Covers:
  - `GET /api/events` capacity reporting
  - `agent.registered` shape + fields (`fullName`, `channelCapable`,
    `pluginVersion`, `restored`)
  - `agent.upgraded` on version mismatch
  - `message.sent` delivered path (with `elapsedMs`) and NAK path
    (`outcome: "nak"`, `reason: "offline"`, `messageId: null`)
  - `message.broadcast` and `message.team` payloads
  - `agent.disconnected` with `reason: "close"` after WS close
  - `limit` and `since` query parameters
  - `GET /api/events/summary` default window + explicit `since`
  - Ping tick: forces a stale agent by rewinding `lastPongAt`, then
    verifies `agent.evicted` (with `lastPongAt`, `silentForMs`) and
    `ping.tick` (with `agentCount`, `evictedCount`) land in the log.

### Modified

- `src/hub/index.ts`
  - `CreateHubOptions.eventLogCapacity?: number` (defaults to 10_000).
  - Instantiates one `EventLog` per hub and threads it into `apiPlugin`
    and `wsPlugin`.
  - Ping tick emits `agent.evicted` BEFORE `raw.close()` for each
    stale entry so the event carries the eviction-specific fields; the
    subsequent close-handler `agent.disconnected { reason: "close" }`
    is retained unchanged as specified by the phase instructions. A
    single `ping.tick` summary is emitted per interval with
    `agentCount` and `evictedCount`.
  - `Hub` interface and module-entry re-exports gain `eventLog`.
- `src/hub/ws-plugin.ts`
  - New optional `eventLog?: EventLog` parameter on `wsPlugin` (kept
    optional so existing unit tests that instantiate `wsPlugin`
    directly still compile). A private `emit()` helper no-ops when the
    log is absent.
  - Emits:
    - `agent.registered` on every successful register (includes
      `restored`, `renamedFrom?`).
    - `agent.upgraded` when the plugin's reported version differs
      from `PLUGIN_VERSION_CURRENT` (`reportedVersion` can be `null`).
    - `message.sent` for both delivered and NAK outcomes; NAK carries
      `reason`, both carry `elapsedMs` (measured around `routeDirect`).
      `messageId` is `null` for NAKs (there is no message id in that
      branch of `routeDirect`).
    - `message.broadcast` and `message.team` with `deliveredTo` and
      `skippedNoChannel`.
    - `agent.disconnected { reason: "close" }` in the close handler.
- `src/hub/api.ts`
  - `ApiDeps.eventLog?: EventLog`.
  - `GET /api/events` — query params `event`, `since`, `limit`,
    `agent`. `limit` is clamped to `[1, 1000]` with default `100`.
    Returns `{ events, count, oldest_ts, capacity }`.
  - `GET /api/events/summary` — query param `since` (default: one hour
    ago). Returns `{ counts, window_ms, total }` where `window_ms` is
    `now - since`.
  - Both endpoints return well-formed empty responses when `eventLog`
    is absent (matches the optional-dep pattern used for
    `hostRegistry`).

## Build and test

```
bun run lint   # clean
bun test       # 369 pass, 0 fail, 1041 expects, 36 files
```

Existing tests untouched; the optional `eventLog` parameter on
`wsPlugin` + `apiPlugin` keeps older fixtures (`tests/hub/ws-plugin.test.ts`,
`tests/hub/api.test.ts`) working without modification.

## Design notes and deviations

- **Optional `eventLog` in the wire functions.** The plan specified
  threading the log through `createHub`. Keeping the wsPlugin and
  apiPlugin parameters optional avoids churning the existing test
  fixtures that build those modules directly; `createHub` always
  constructs and passes one, so production behavior is unconditional.
  The two REST endpoints return an empty buffer shape (capacity 0)
  when the dep is absent, which is correct for those fixtures.
- **`messageId: null` for NAK sends.** `routeDirect` only mints a
  `message_id` on the success branch. The plan's table shows
  `messageId` as a key field on `message.sent`; surfacing `null`
  explicitly makes the NAK vs delivered distinction trivial for
  callers without requiring optional-field checks. An alternative
  would be to omit the field on NAK — rejected because it complicates
  downstream filtering.
- **`elapsedMs` on `message.sent`.** Plan table includes this field;
  measured with `Date.now()` deltas around `routeDirect`. Not measured
  for broadcast/team since the plan doesn't ask for it there and the
  number would be dominated by loop overhead rather than any single
  delivery.
- **Prefix matching boundary.** `query({event: "agent"})` intentionally
  does NOT match an event literally named `agent` followed by non-dot
  characters (e.g. `agentic.*`). This prevents accidental category
  bleed if a future event name shares a string prefix. Exact-name
  queries still work (`event: "agent.registered"`).
- **Eviction emission ordering.** The plan asks `agent.evicted` to fire
  BEFORE `raw.close()` so the distinct-reason event beats the generic
  close-handler `agent.disconnected` into the log. Implemented that
  way; both events end up in the log when a stale agent is closed.
- **No mirror emissions.** Per plan non-goals — mirror subsystem has
  its own transport and is excluded.

## Follow-ups (Phase 2)

- `hub_events` MCP tool on the plugin + `query_events` frame handler
  in ws-plugin.
- Dashboard UI: surface system events (evictions, upgrades, ping tick
  summaries) either as a new tab or color-coded in the existing log.
- `nudge.fired` event — emitted by the plugin, relayed to the hub,
  then pushed to the EventLog. Requires a new frame action so left for
  Phase 2 alongside the MCP tool work.

## Open questions

None blocking Phase 1. Phase 2 will need to decide whether the
`hub_events` tool returns raw events or a pre-formatted text summary
for the LLM — the plan leans toward raw JSON but the surface area is
worth confirming before implementation.
