# Ticket: P4 — JSON-RPC 2.0 stdio peer library (mpyjsonrpc)

- Phase: P4
- Owner-model (impl / test / review): sonnet / haiku / opus
- Depends on: P0 (independent of P1-P3; runs on the prebuilt cli binary)
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: 2026-07-23 @ pre-commit
- Revalidated:

## Goal

A reusable async newline-delimited JSON-RPC 2.0 peer over stdio: serve
requests via method dispatch, emit server→client notifications, correlate
client→server requests if ever needed, a stderr logging helper, and an
EOF→shutdown hook. This is mpyfastmcp's transport core.

## Preconditions

- P0 scaffold committed: claude-net-mpy worktree exists with the planning
  folder, and the source layout under the worktree (`src/plugin-mpy/lib/`
  per Q4) is committed.
- The prebuilt `picolet-runtime-linux-x64-cli` binary (662 KB) is available
  for dev iteration; this phase does not need P1's TLS work, P2's `mcp`
  variant, or P3's WS client — it is independent of P1–P3 and runs in
  parallel with them.

## Work items

1. Async read loop on `asyncio.StreamReader(sys.stdin.buffer)`; strict
   line-delimited framing; oversized-line guard.
2. Dispatcher: method registry, positional/named params, JSON-RPC error
   objects (−32700 parse, −32600 invalid request, −32601 method not found,
   −32602 invalid params, −32603 internal), id echo rules (string/number/
   null), notification (no id) handling — no response emitted.
3. Outbound notification API (used later for `notifications/claude/channel`)
   and outbound request correlation with per-request timeout (mirrors the
   bun plugin's 10 s hub-request pattern for symmetry, even though MCP
   servers rarely call out).
4. Concurrency policy: handler execution model (sequential per-connection vs
   task-per-request) documented and tested; stdout writes serialized (single
   writer) so interleaved responses can't corrupt framing.
5. stderr `log()` helper with prefix; EOF (b'') → registered shutdown
   callback.

## Interfaces / contracts

The public surface P6 (mpyfastmcp) composes on top of:

- A peer object constructed over `sys.stdin.buffer` / `sys.stdout.buffer`
  that runs the async read loop.
- `register_method(name, handler)` (or decorator-equivalent) for the method
  registry: handler receives positional/named params, returns a result or
  raises a typed JSON-RPC error.
- `notify(method, params)` for outbound server→client notifications, with
  the method name supplied by the caller (P4 must not hard-code
  `notifications/claude/channel` — that belongs to P7).
- An outbound-request API with per-request timeout and id correlation, for
  symmetry with the bun plugin's pattern even though it is not exercised by
  the MCP direction in P4 itself.
- `log(msg)` writing to stderr with a prefix, guaranteed never to touch
  stdout.
- A shutdown-callback registration point fired on stdin EOF (`b''`).
- Serialized stdout writes: concurrent handlers/notifications must not
  interleave partial JSON lines.

## Tests

CPython pytest harness spawning the MicroPython binary as a subprocess
speaking real stdio:

- Happy-path request/response.
- Batch-of-lines burst (multiple requests arriving in one read).
- Malformed JSON → −32700.
- Unknown method → −32601.
- Wrong-type params → −32602.
- Notification handling (no id) → no response emitted.
- id-type preservation (string/number/null echoed exactly).
- Huge payload (≥ 256 KB result) — this is also the risk-register payload
  test for MicroPython's json module (risk register: "Large hub_events /
  tool payloads vs MicroPython json", P4/P7).
- EOF mid-stream → shutdown callback fires.
- stderr never pollutes stdout (log() output must not appear on the wire).
- Framing fuzz: random byte junk between valid lines never crashes the loop.

## Exit criteria

- Conformance suite (all tests above) green.
- Framing fuzz never crashes the loop.
- API documented (register_method / notify / outbound-request / log /
  shutdown-callback surface, per Interfaces / contracts above).

## Open questions consumed

- Q4 — Where the reusable libs live: DECIDED option (a) — this library
  lives in the claude-net-mpy worktree (`src/plugin-mpy/lib/mpyjsonrpc/`
  per the roadmap's recommended layout), shipped via the app romfs, not
  in picolet `packages/` or micropython-lib.
- Q7 — Library names: DECIDED — this library is named `mpyjsonrpc`.

## Risks

- Large hub_events / tool payloads vs MicroPython json (risk register,
  P4/P7): covered by the ≥ 256 KB payload test above; if MicroPython's
  json encoder/decoder proves too slow or memory-heavy at that size, this
  phase's exit criteria are not met until a workaround (streaming encode,
  chunked writes) is found and tested.
- Stdout interleaving: the single-writer serialization in work item 4 is
  the only thing preventing concurrent notification + response writes from
  corrupting line framing; if the concurrency model (task-per-request)
  allows two coroutines to write concurrently without going through the
  serialized writer, framing corrupts silently under load — the
  concurrency-policy test must specifically exercise a notification fired
  mid-request-handling, not just sequential cases.
- Oversized-line guard vs the 256 KB payload test: the guard must reject
  pathological unbounded lines while not tripping on the legitimate large
  payload case; these two require distinct, deliberately chosen thresholds.
