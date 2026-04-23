# CHANNEL_LIVENESS — Phase 1: WebSocket ping/pong and stale eviction

**Part of:** `CHANNEL_LIVENESS_PLAN.md`
**Phase:** 1 of 3
**Estimated Time:** 1.5–2 hours (dev) + test + review gate
**Branch:** `feature/message-ack`

## Goal

Hub pings every registered plugin WebSocket every 5 seconds and closes any connection whose last pong is older than 15 seconds. Closure routes through the existing `close` handler, which unregisters the agent via `registry.unregister` and broadcasts `agent:disconnected`. This collapses the half-open WS failure window from "indefinite" to roughly 15s without any application-level heartbeat protocol.

## Prerequisites

- [ ] On branch `feature/message-ack` (branched from `squash-plan`).
- [ ] Read `docs/CHANNEL_LIVENESS_SPEC.md` — especially FR1.
- [ ] Read `docs/CHANNEL_LIVENESS_PLAN.md` — Codebase Analysis section.

## Authoritative spec reference

FR1 in `docs/CHANNEL_LIVENESS_SPEC.md`. In case of any ambiguity between this phase file and the spec, the spec wins.

## Files to modify

- `src/hub/registry.ts` — extend `AgentEntry` with `lastPongAt: Date`; set on register.
- `src/hub/ws-plugin.ts` — add `pong(ws, data)` handler on the `app.ws("/ws")` config that updates `lastPongAt` on the entry for the pong-sending agent.
- `src/hub/index.ts` — after `app.listen(port)`, start a `setInterval` that pings all registered agents and closes stale ones. Track the interval so SIGINT/SIGTERM handlers can clear it.

## Files to create

None.

## Test files to create

- `tests/integration/liveness.test.ts` — new file; this phase lands tests L1 and L2 only. Phases 2 and 3 extend it.

## Key requirements

1. `AgentEntry.lastPongAt: Date` is initialized at register time (treat register as "alive now"). Mutated by the pong handler; otherwise read-only.
2. Hub ping tick runs every 5s (default). Configurable at hub construction: e.g., `createHub({ pingIntervalMs = 5000, staleThresholdMs = 15000 })` or equivalent. The existing hub bootstrap in `src/hub/index.ts` may not use a `createHub` factory today — if it doesn't, introduce one (simple function that wires the Elysia app, registry, teams, etc., and accepts the timing options). Production entrypoint uses defaults; tests inject short values.
3. On each tick, for every entry in `registry.agents`:
   - Call `entry.ws.raw.ping()`. If it throws (WS already in bad state), swallow — the stale-check on the same tick will close it.
   - If `Date.now() - entry.lastPongAt.getTime() > staleThresholdMs`, call `entry.ws.raw.close()`. The existing `close` handler in `ws-plugin.ts:312` already calls `registry.unregister` and broadcasts `agent:disconnected` — do NOT duplicate that logic.
4. Process shutdown (SIGINT / SIGTERM / `app.stop()` if Elysia exposes it) must `clearInterval` the ping timer.
5. The pong handler updates `lastPongAt` for the entry whose `wsIdentity === ws.raw`. If the WS is not yet registered, pong is silently ignored.

## Integration points

- **WeakMap `wsToAgent`** in `ws-plugin.ts:23` maps `ws.raw` → `fullName`. The pong handler uses this to find the agent quickly.
- **Bun ServerWebSocket** — `ws.raw.ping()` sends a native ping; `pong(ws, data)` handler in `app.ws()` config fires on incoming pong. Verify behavior with a smoke test at the start of dev work: wire a no-op `pong` handler, log on receipt, observe that Bun's `ws.raw.ping()` → plugin's auto-response pong triggers it.
- **`ws` npm library on plugin side** auto-responds to server pings (default behavior when no user-registered `"ping"` event handler overrides). Plugin does NOT need changes in this phase.

## Implementation guidance

Recommended sequence:

1. **Smoke test first (10 min):** wire an empty `pong(ws) { console.log("pong received"); }` handler in the existing `app.ws()` config and a one-off `setInterval(() => ws.raw.ping(), 1000)` (any connected agent). Run `bun run dev`, connect from a plugin in another terminal, observe the log. Confirms the plumbing works. Remove the scaffold before moving on.

2. **Registry changes:**
   - Extend `AgentEntry` interface to include `lastPongAt: Date`.
   - In `register()` (success path, line 92 area) initialize `lastPongAt: new Date()`.
   - On re-register same-identity update (lines 71–75) do NOT reset `lastPongAt` — the existing connection is live and we have no reason to believe otherwise.

3. **ws-plugin pong handler:**
   ```
   pong(ws) {
     const fullName = wsToAgent.get(ws.raw);
     if (!fullName) return;
     const entry = registry.getByFullName(fullName);
     if (entry) entry.lastPongAt = new Date();
   }
   ```
   Add to the `app.ws("/ws", { ... })` handler object in `ws-plugin.ts`. Do not change any other handlers.

4. **`createHub` factory + ping tick:** if `src/hub/index.ts` is currently top-level glue, refactor into a `createHub(options?)` function that returns `{ app, registry, stop }`. Production entrypoint (`main()` or equivalent) calls `createHub()` and `app.listen(port)`. Tests call `createHub({ pingIntervalMs: 100, staleThresholdMs: 300 })`.
   - The ping tick iterates `registry.agents`, calls `entry.ws.raw.ping()` (in try/catch), then checks staleness and closes if needed.
   - `stop()` from the factory clears the interval and calls `app.stop()` if available, or tracks a cleanup list.
   - Wire the existing SIGINT/SIGTERM handlers (currently at bottom of index.ts if present — inspect) to call `stop()`.

5. **Tests for the factory:** ensure the existing test helpers in `tests/integration/e2e.test.ts` still work. If they construct the hub inline, update them to use `createHub` (keep the behavior identical).

## Testing strategy

### Integration tests (`tests/integration/liveness.test.ts`)

**L1 — Ping/pong round-trip:**
- Create hub with `pingIntervalMs: 100, staleThresholdMs: 500`.
- Connect a plugin-like WS client (use the existing `tests/integration/e2e.test.ts` helpers if they exist; otherwise native `WebSocket` with register frame).
- Wait 250ms (two ticks). Verify `lastPongAt` on the registered entry has advanced past the initial register time.
- Use Bun's ability to inspect internal state or expose a test-only getter on the hub/registry.

**L2 — Stale WS eviction:**
- Create hub with `pingIntervalMs: 100, staleThresholdMs: 300`.
- Connect a plugin-like WS client that registers.
- Simulate half-open: override the `ws` client's `"ping"` handler to NOT respond (stops auto-pong). A simple approach: use the `ws` npm library's raw socket and swallow incoming pings.
- Wait ~500ms. Assert the registry entry is gone (the close handler ran).
- Assert the dashboard broadcast received an `agent:disconnected` event.

### Unit tests (extend existing `tests/hub/registry.test.ts`)

- Register with an identity → entry has `lastPongAt` defined and close to `now`.
- Same-identity re-register → `lastPongAt` is preserved (not reset).

### Manual smoke test

- Run `bun run dev`, connect a real plugin via Claude Code, leave it idle for 30s, observe no spurious disconnects (default intervals).
- Forcibly break the WS at the TCP level (e.g., `sudo tc qdisc add dev lo root netem loss 100%`; revert after) and observe the stale eviction fires within ~15–20s.

## Dev report artifact

Save to `docs/CHANNEL_LIVENESS_PHASE_1_DEV_REPORT.md`. Include:

- List of files changed with one-line summary each.
- Any deviations from the phase file and why.
- Results of the smoke test (pong handler plumbing).
- Unit test + integration test status (`bun test tests/hub tests/integration`).
- `bun run lint` status.
- Any open questions the orchestrator needs to answer.

## Agent review gate

**Trigger `principal-code-reviewer`** after dev + tests pass. Focus reviewer on:

- Timer lifecycle: is the interval cleared in all shutdown paths (SIGINT, SIGTERM, uncaught exception)?
- Race between ping tick and `close` handler: if an agent closes mid-tick, does `entry.ws.raw.ping()` throw, and is that caught cleanly?
- Staleness check is correctly "greater than", not "greater or equal" (the semantics in the spec are "15s of silence = stale"; off-by-one is easy here).
- `createHub` factory (if introduced) preserves all existing wiring — no missed `setDashboardBroadcast`, no missed plugin registration.

## Success criteria

- [ ] `AgentEntry.lastPongAt` field present and populated.
- [ ] Ping tick runs on the configured interval; stale WS eviction works within the threshold.
- [ ] Unit tests pass.
- [ ] Integration tests L1 and L2 pass.
- [ ] No regressions (`bun test` whole-suite green).
- [ ] `bun run lint` clean.
- [ ] Dev report committed.
- [ ] principal-code-reviewer signed off.

## Dependencies

- Internal: none (zero dependency on other phases).
- External: none.

## Risks and mitigations

- **Risk:** Bun's `ws.raw.ping()` behavior across Elysia may differ from docs. **Mitigation:** smoke test at the start (step 1 of Implementation Guidance). Confirm empirically before building around it.
- **Risk:** Tests that rely on real timing become flaky. **Mitigation:** use generous thresholds in tests (100ms tick, 300ms stale = 3 ticks of slack), avoid tight polling loops — use `await new Promise(r => setTimeout(r, 500))` then assert, not busy-waits.
- **Risk:** The Elysia/Bun ws wrapper doesn't expose `pong` handler in the `app.ws()` config as expected. **Mitigation:** fallback plan is documented — treat pong as implicit liveness signal via incoming frame activity (update `lastPongAt` on any received frame, not just pongs). This is less precise but works. Decide at smoke-test time.

## Next steps

After this phase is merge-ready, proceed to `CHANNEL_LIVENESS_PHASE_2.md`.
