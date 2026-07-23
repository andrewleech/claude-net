# Ticket: P3 — Async WebSocket client library (mpyws)

- Phase: P3
- Owner-model (impl / test / review): sonnet / haiku / opus
- Depends on: P1, P2
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: 2026-07-23 @ pre-commit
- Revalidated:

## Goal

A reusable, tested RFC6455 client for MicroPython asyncio: handshake,
client-side masking, 7/16/64-bit lengths, fragmentation reassembly,
transparent control PING→PONG, clean close handshake, text+binary, over
plain TCP or TLS (P1 pattern). This is the first real library in the stack;
the plugin (P7) and any future MicroPython WS consumer sit on it.

## Preconditions

- P1 exit criteria met: async register+ping green against the real hub over
  TLS from a single asyncio loop; buffered-record semantics documented; RSS
  ≤ 4 MB.
- P2 exit criteria met: `picolet-runtime-linux-x64-mcp` builds ≤ 1 MiB with
  the size gate enforced; real-hub TLS smoke green; SBOM updated; Q2/Q3
  DECIDED.

## Work items

1. Extract/rewrite spike `ws.py` into a proper package with a documented
   API: `connect(url, *, ssl_ctx/cadata, headers) -> WSClient`,
   `await recv() -> str|bytes`, `await send(str|bytes)`,
   `await close(code, reason)`, `.closed`, idle/traffic timestamps exposed
   for caller-side watchdogs (watchdog policy itself stays in the app
   layer).
2. URL parsing (ws/wss, host/port/path), https→wss style scheme mapping.
3. Sec-WebSocket-Key generation (os.urandom + binascii); Accept
   verification iff Q3 enabled hashlib, else skipped with a comment stating
   why it is non-load-bearing for a client.
4. Close/error taxonomy: distinguish clean close, abortive close, protocol
   error; all surface as typed exceptions the caller can drive reconnect
   from.
5. Fragmentation: reassembly of fragmented text/binary; control frames
   interleaved mid-fragment handled.
6. Package docs + usage example (the mock-hub echo client).

## Interfaces / contracts

Public API surface P6 (mpyfastmcp) and P7 (plugin) build on:

- `connect(url, *, ssl_ctx/cadata, headers) -> WSClient`
- `await WSClient.recv() -> str|bytes`
- `await WSClient.send(str|bytes)`
- `await WSClient.close(code, reason)`
- `WSClient.closed`
- Idle/traffic timestamp attributes for caller-side watchdog logic (P7's
  31 s no-traffic watchdog resets on data and control PING; mpyws exposes
  the timestamps, the watchdog policy itself is not part of this library).
- Typed exception hierarchy distinguishing clean close, abortive close, and
  protocol error, so callers can drive reconnect decisions on the exception
  type rather than parsing strings.

## Tests

CPython pytest harness driving the MicroPython binary as a subprocess:

- Unit: frame encode/decode vectors (masking, all three length forms, RSV
  bits rejected, opcode validation).
- Integration: mock server (extend `mock_hub.py`) exercising fragmentation,
  interleaved control frames, ping flood, oversized frame, abrupt FIN,
  mid-frame disconnect, slow-loris partial header.
- Adversarial: a subset of Autobahn-testsuite cases (fuzzingserver in
  docker, ephemeral-container pattern) — at minimum the framing (1.x),
  ping/pong (2.x), fragmentation (5.x) and close (7.x) groups; record pass
  matrix in the phase report.
- TLS: same suite over the P1 TLS path against a CPython TLS echo server.

## Exit criteria

All tests green on the `mcp` binary; Autobahn subset pass matrix recorded
with no non-strict failures in the covered groups; API doc reviewed; RSS of
an idle connected client ≤ 3.5 MB.

## Open questions consumed

- Q1 — TLS packaging [DECIDED 2026-07-23]: dedicated `mcp` variant (cli
  baseline + SSL/mbedtls, 878 KB proven), not a re-enabled shared cli
  variant. P3 targets this variant's binary (built in P2), and its TLS test
  suite runs over the P1 TLS path on that binary.
- Q3 — hashlib/SHA1 for Sec-WebSocket-Accept verification [OPEN — owner
  P2]: not yet decided. Work item 3 branches on the outcome: if P2 enables
  hashlib within the 1 MiB ceiling, mpyws verifies the Accept header;
  otherwise it skips verification with a comment recording that this is
  non-load-bearing for a client. Ticket revalidation at P3 entry must check
  whether P2 has closed Q3 in `DECISIONS.md` and update work item 3
  accordingly before this ticket feeds a workflow.
- Q4 — Where the reusable libs live [DECIDED 2026-07-23]: option (a), the
  claude-net-mpy worktree, shipped via the app romfs. mpyws lands under the
  `src/plugin-mpy/lib/` tree established in P0 (exact subpath per P0 work
  item 6); no picolet manifest/freeze change.
- Q7 — Library names [DECIDED 2026-07-23]: this library is `mpyws`.

## Risks

- Async TLS handshake under poll loop failing or needing C changes
  (register: P1). If P1 exits via a C-level workaround rather than a clean
  poll-integrated stream API, mpyws's TLS read/write path (and its
  "TLS: same suite over the P1 TLS path" test item) is reshaped, not just
  blocked. Revalidate against P1's actual exit shape before this ticket
  feeds a workflow.
- mbedtls buffered application data not surfaced by poll → read hang
  (register: P1). Directly relevant to mpyws's TLS-mode `recv()`: a WS
  frame boundary can sit entirely inside one already-buffered TLS record,
  so `recv()` must not rely on fd-level poll readiness alone to know more
  data is available.
- RSS budget is tight: P1 measured 3.2 MB RSS for an idle connected TLS
  client at the transport layer alone, against P3's own ≤ 3.5 MB idle-RSS
  exit criterion for a fully connected `WSClient`. The remaining ~300 KB
  must absorb frame-buffer state, the close/error exception taxonomy, and
  Python-level object overhead.
- Autobahn-testsuite coverage is a stated subset (1.x, 2.x, 5.x, 7.x only)
  — reserved-bits (3.x) and UTF-8-validation (6.x) style groups, if present
  in the fuzzingserver's default set, are not exercised. This is a residual
  conformance gap carried forward, not closed by this ticket's exit
  criteria.
