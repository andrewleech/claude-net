# Ticket: P1 — Retire the async-TLS risk (spike)

- Phase: P1
- Owner-model (impl / test / review): opus (impl override) / haiku / opus
- Depends on: P0 (uses the spike's ad-hoc `picolet-mcp-tls` binary; runs parallel with P2)
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: 2026-07-23 @ pre-commit
- Revalidated:

## Goal

A wss connection whose TLS handshake and I/O run entirely under the
non-blocking asyncio poll loop, proven against the real hub. This is the top
remaining technical risk: the spike's TLS handshake used a blocking socket.
Under asyncio, mbedtls `wrap_socket` surfaces
MBEDTLS_ERR_SSL_WANT_READ/WRITE as OSError(EAGAIN) and the loop must poll the
fd through handshake progress. Everything above the WS client sits on this;
if it needs C-level changes (extmod/modtls_mbedtls.c poll semantics), better
to know before P3.

## Preconditions

None — P1 runs off the spike's ad-hoc TLS binary (`picolet-mcp-tls`, 878 KB)
and can proceed in parallel with P2.

## Work items

1. Non-blocking `tls.wrap_socket` handshake driver: set socket non-blocking
   before wrap, loop handshake on EAGAIN with poll-based fd readiness, under
   asyncio (extend `mp_wss.py`).
2. Integrate with asyncio streams (or a thin custom stream over poll) for
   post-handshake read/write, including EAGAIN on both directions.
3. Buffered-record wakeup test: mbedtls may hold decrypted application data
   in its internal buffer with nothing pending on the raw fd; a poll on the
   fd alone would hang. Verify MicroPython's tls object's MP_STREAM_POLL
   reports pending buffered data (send two JSON frames in one TLS record from
   a test server; second frame must be readable without new fd activity). If
   it does not, design the workaround (drain-after-read loop) and document
   it.
4. Concurrency proof: stdin readline + wss traffic interleaved in one loop
   (async port of `combined.py` over TLS), idle CPU ~0.
5. Real-hub proof: register + ping against
   `wss://telie.story-kettle.ts.net:4815/ws` from the asyncio loop, both
   CERT_NONE and CERT_REQUIRED(ISRG Root X1 DER).
6. Measure: RSS, handshake wall time, steady-state CPU. Write findings to
   `planning/YYYYMMDD_async-tls.md`.

## Interfaces / contracts

None — this is a spike phase. Its output feeds P3's async WebSocket client
design (the poll-driven handshake and buffered-record-read pattern it
establishes) but does not itself expose a public API.

## Tests

Scripted CPython harness driving the MicroPython binary: handshake under
load, mid-handshake server stall (EAGAIN path actually exercised), buffered-
record wakeup, server-initiated close during handshake, cert failure surfaces
as a catchable exception.

## Exit criteria

Async register+ping green against the real hub over TLS from a single
asyncio loop; buffered-record semantics documented; RSS ≤ 4 MB; findings note
written. If a MicroPython C fix is required, it is identified and either
landed (via picolet's mbm feature-branch flow) or worked around — escalate to
Andrew before P3 if C changes are needed.

## Open questions consumed

- Q1 (TLS packaging) — DECIDED: option (a), a dedicated `mcp` picolet variant
  (cli baseline + SSL/mbedtls), not re-enabling TLS in the shared `cli`
  variant. P1 itself runs against the spike's ad-hoc `picolet-mcp-tls`
  binary rather than the `mcp` variant (which P2 builds in parallel), so this
  decision constrains what P1's findings must remain valid against, not what
  P1 builds.
- Q2 (cert verification posture) — DECIDED: option (b), bundle ISRG Root X1
  as DER, CERT_REQUIRED, and SNI as the library default, with an explicit
  insecure-override env var (falls back to CERT_NONE over the tailnet). Work
  item 5 tests both CERT_NONE and CERT_REQUIRED(ISRG Root X1 DER) against the
  real hub, matching this decision.

## Risks

- Async TLS handshake under the poll loop fails or needs C changes —
  dedicated spike phase before any dependent build; escalation path to
  picolet's mbm feature-branch flow if an extmod fix is needed.
- mbedtls buffered application data not surfaced by poll, causing a read
  hang — mitigated by the explicit buffered-record wakeup test (work item 3):
  two frames in one TLS record, second frame must be readable without new fd
  activity.
