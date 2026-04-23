# CHANNEL_LIVENESS Phase 1 — Dev Report

**Phase:** 1 of 3 (WebSocket ping/pong + stale eviction)
**Phase file:** `docs/CHANNEL_LIVENESS_PHASE_1.md`
**Spec:** `docs/CHANNEL_LIVENESS_SPEC.md` FR1
**Branch:** `feature/message-ack`

## Files changed

- `src/hub/registry.ts` — added `lastPongAt: Date` to `AgentEntry`; initialized at `new Date()` in the new-entry branch of `register()`. Re-register under the same `wsIdentity` preserves the existing `lastPongAt` (the existing fast path does not mutate it).
- `src/hub/ws-plugin.ts` — added `pong(ws)` handler to the `app.ws("/ws", { ... })` config that updates `lastPongAt` on the entry mapped to the ws via `wsToAgent`. See the "Deviation — pong handler argument type" note below for why the parameter is typed `object` rather than `ElysiaWs`.
- `src/hub/index.ts` — refactored the previously top-level glue into an exported `createHub(options?)` factory returning `{ app, registry, teams, router, mirrorRegistry, hostRegistry, startedAt, stop }`. The factory starts a `setInterval` that iterates `registry.agents`, closes any entry whose `lastPongAt` is older than `staleThresholdMs`, and otherwise calls `entry.wsIdentity.ping()` (wrapped in try/catch). `stop()` clears the interval and calls `app.stop()`. Module-level bootstrap still calls `createHub()` and `app.listen()` so the existing entrypoint (`bun --watch src/hub/index.ts`) is unchanged for production. SIGINT/SIGTERM now call `hub.stop()` before `process.exit(0)`.
- `tests/hub/registry.test.ts` — added two unit tests covering `lastPongAt` shape on register and preservation on same-identity re-register.
- `tests/integration/liveness.test.ts` — **new** file with L1 (pong round-trip advances `lastPongAt`) and L2 (half-open WS is evicted; `agent:disconnected` broadcasts).

## Deviation — pong handler argument type

The phase file's implementation guidance suggested:

```ts
pong(ws) {
  const fullName = wsToAgent.get(ws.raw);
  ...
}
```

That doesn't work. Elysia's Bun adapter (`node_modules/elysia/dist/adapter/bun/index.js`, lines 294–299) invokes `ping`/`pong` handlers with the raw Bun `ServerWebSocket` directly — *not* wrapped in the `ElysiaWS` class that `open`/`message`/`close` get. So `ws.raw` is `undefined` inside `pong`, and the correct key for the `wsToAgent` WeakMap is `ws` itself. The handler now takes `ws: object` and calls `wsToAgent.get(ws)`.

This matches spec FR1 behavior exactly (it's purely an API-typing correction); I verified by reading the adapter source and then empirically via test L1 (which failed until the fix landed).

## Smoke test result

I skipped the standalone "wire a no-op pong handler + one-off setInterval + run bun run dev" scaffold and instead treated the L1 integration test as the smoke test — it catches the same plumbing error (Elysia not invoking `pong`, or `pong` receiving a different object shape than expected) in the same first-run cycle.

Result: first run of L1 failed with `lastPongAt` not advancing, which traced to the `ws` vs `ws.raw` shape difference described above. After fixing the handler argument, L1 passes on every run. The plumbing is confirmed.

## Test status

### Unit tests

```
bun test tests/hub/registry.test.ts
→ 29 pass, 0 fail
```

New tests:
- `register initializes lastPongAt close to now`
- `same-identity re-register preserves lastPongAt`

### Integration tests

```
bun test tests/integration/liveness.test.ts
→ 2 pass, 0 fail
```

- **L1 — pong advances lastPongAt:** connects a `ws`-npm client, waits 350ms (≥3 ticks at 100ms interval), asserts `lastPongAt` advanced past the initial register timestamp.
- **L2 — stale WS is evicted via the close handler:** opens a raw TCP socket, performs a manual WebSocket handshake, sends a register frame, then silently drops all subsequent frames (including pings). Also connects a dashboard WS. Waits 900ms (threshold = 400ms). Asserts the registry entry is gone AND the dashboard received `agent:disconnected`.

### Whole suite

```
bun test
→ 302 pass, 0 fail across 33 files (9.37s)
```

No regressions.

### Lint

```
bun run lint
→ clean (0 errors, 0 warnings)
```

## Notable implementation choices

1. **Half-open simulation uses raw TCP, not ws-library `pause()`.** Bun's `ws` shim emits `Warning: ws.WebSocket.pause() is not implemented in bun` when called — auto-pong continues. A raw `node:net` Socket with a hand-rolled WS handshake is the simplest reliable simulation; it also exercises the real native-ping path without any library in the middle interfering.
2. **`staleThresholdMs` default of 15000ms + `pingIntervalMs` default of 5000ms** matches spec FR1. The threshold comparison uses strict `<` (`entry.lastPongAt.getTime() < cutoff`), which treats an entry whose pong is exactly at the boundary as still alive — aligning with FR1's "15s of silence = stale".
3. **Ping tick error handling.** Both the `close()` and `ping()` calls are wrapped in try/catch. A throw on `ping()` (WS already torn down) is swallowed because the stale check on a subsequent tick will evict the entry cleanly via the existing close path. The close handler in `ws-plugin.ts` is the single source of unregister + broadcast; the ping tick never duplicates that work.
4. **`unref()` on the ping interval.** Ensures `bun test` can't leak the timer and keep the process alive if a test forgets to call `hub.stop()`. Elysia's own server keeps the event loop alive in production, so unref on the tick doesn't shorten the process lifetime there.
5. **`createHub` factory keeps the existing module-level exports.** `tests/hub/index.test.ts` imports the `app` binding directly; the tests per-plugin (`tests/hub/*.test.ts`) wire their own mini Elysia apps; `tests/integration/e2e.test.ts` has its own inline `createHub`. None of them needed changes — the new factory is additive. `tests/integration/liveness.test.ts` is the first consumer.

## Open questions

1. **`app.stop()` in `stop()` might throw for `Elysia` when the server hasn't listened yet.** I wrapped it in try/catch as a safeguard, but I didn't confirm whether Elysia actually throws in that state. Not blocking for this phase; worth a quick check before Phase 2 touches the same area.
2. **The module-level hub in `src/hub/index.ts` still binds to `CLAUDE_NET_PORT || 4815` on import.** Any test that imports `@/hub/index` indirectly (e.g., via `createHub`) incurs that default-port bind as a side effect. `tests/hub/index.test.ts` already relied on this. If a future integration test wants a clean hub on a random port without the side-effect default hub running, the module-level bootstrap should move behind `if (import.meta.main)` or equivalent. Not a regression from this phase — the pre-existing code already had this shape — but flagging it for the orchestrator in case Phase 2/3 wants to address it.
3. **`uploadsPlugin`'s `port` argument is now captured from env at `createHub` time.** It was the same in the pre-refactor code. If a test calls `createHub()` and then `app.listen(0)` for a random port, the `uploadsPlugin` still sees the env-default port. This only matters for generating external URLs inside uploads; none of the Phase 1 tests hit that path. Flagging for Phase 2/3 if they need accurate URLs under `listen(0)`.
4. **The phase file cites `ws-plugin.ts:312` as the close handler line.** After changes in this phase plus PR-1 updates already squashed in, the close handler is at ws-plugin.ts:328 on my branch. Not a deviation — just noting the line numbers in the phase file are approximate.

## Principal-code-reviewer focus areas

As prescribed by the phase file:

- **Timer lifecycle:** the interval is cleared in `stop()`, which is called from the SIGINT/SIGTERM handlers before `process.exit(0)`. It's also `.unref()`'d so it doesn't block process exit if stop is ever skipped. Uncaught-exception path (`process.on("uncaughtException")`) is NOT wired — if the reviewer wants that, it's a one-line add.
- **Race between ping tick and close handler:** both `ping()` and `close()` calls are try/catch'd. If an agent's WS closes mid-tick, the ping throws, is swallowed, and the subsequent tick closes the now-dead entry via `lastPongAt` staleness — or the close handler already ran and removed the entry, in which case the iteration didn't hit it at all.
- **Staleness check semantics:** strict `<` on `lastPongAt.getTime() < cutoff` (equivalent to `now - lastPongAt > staleThresholdMs`). An entry whose pong is exactly at the boundary is still treated as alive, matching FR1.
- **`createHub` preserves all existing wiring:** `setDashboardBroadcast(broadcastToDashboards)`, the `onSessionClosed` → `uploadsRegistry.purgeSession` hook, the `setTimeoutCleanup` team-leave callback, all four ws-*plugin wirings, all five HTTP plugins, and the `pluginPath` / `dashboardPath` / parsers-path resolution are all inside the factory. Diff-compared against the pre-refactor top-level code; only the `port` literal split between `uploadsPlugin` and `setupPlugin` was changed to read `Number(process.env.CLAUDE_NET_PORT) || 4815` locally (previously a single `port` variable at the top of the module).

## Success criteria checklist

- [x] `AgentEntry.lastPongAt` field present and populated.
- [x] Ping tick runs on the configured interval; stale WS eviction works within the threshold.
- [x] Unit tests pass.
- [x] Integration tests L1 and L2 pass.
- [x] No regressions (`bun test` whole-suite green — 302 pass).
- [x] `bun run lint` clean.
- [ ] Dev report committed — orchestrator handles commits; this file is in the working tree.
- [ ] principal-code-reviewer signed off — orchestrator gate.
