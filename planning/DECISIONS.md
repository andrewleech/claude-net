# Decisions: claude-net plugin on the picolet MicroPython runtime

This file records closed open-questions (Qk) from `planning/ROADMAP.md`'s
"Open questions" table. Each entry is dated at the point the decision became
binding and states the verbatim decision, the rationale, and the owner phase.
The roadmap's Open-questions table is updated in place to point `Status` at
this file once an entry lands here; this file is never rewritten to change a
past decision — a reversal is a new dated entry.

## Q1 — TLS packaging  [DECIDED 2026-07-23 (accepted by Andrew via 'proceed')]

**Decision:** Option (a): a dedicated `mcp` picolet variant (cli baseline +
SSL/mbedtls), not re-enabling TLS in the shared `cli` variant.

**Rationale:** 878 KB proven in the spike; keeps the lean `cli` variant
untouched (NFR-1).

**Owner phase:** P2 executes.

## Q2 — Cert verification posture  [DECIDED 2026-07-23 (accepted by Andrew via 'proceed')]

**Decision:** Option (b): bundle ISRG Root X1 as DER, CERT_REQUIRED, and SNI
as the library default, with an explicit insecure-override env var (falls
back to CERT_NONE over the tailnet).

**Rationale:** ~1 KB DER buys real verification; the hub cert is Let's
Encrypt via `tailscale cert`.

**Owner phase:** P2.

## Q3 — hashlib/SHA1 for Sec-WebSocket-Accept verification  [DECIDED 2026-07-23 (P2 measurement)]

**Decision:** Enable `hashlib.sha1` in the `mcp` variant (`MICROPY_PY_HASHLIB`
+ `MICROPY_PY_HASHLIB_SHA1`); keep MD5 and SHA256 off. Sec-WebSocket-Accept
verification stays in the WS client as a defensive check.

**Rationale:** Measured both configurations on the built `linux-x64/mcp`
binary: without hashlib, 899384 bytes; with `hashlib.sha1` enabled, 899384
bytes — identical size (85% of the 1 MiB / NFR-MCP-1 ceiling, ~145 KB
headroom). SHA1 is effectively free because mbedtls' SHA1 implementation is
already statically linked in for TLS; exposing it to `hashlib` costs no
measurable additional code. Since verification is free, there is no reason
to accept the (admittedly non-load-bearing) drop in defense-in-depth by
leaving it disabled.

**Owner phase:** P2.

## Q4 — Where the reusable libs live  [DECIDED 2026-07-23 (accepted by Andrew via 'proceed')]

**Decision:** Option (a): in the claude-net-mpy worktree, shipped via the app
romfs.

**Rationale:** No picolet manifest/freeze change; plugin and libs are
versioned together. Graduate to micropython-lib once the API is stable.

**Owner phase:** P0 (this decision) / P3–P6 (layout).

## Q5 — Schema-spec surface  [DECIDED 2026-07-23 (accepted by Andrew via 'proceed')]

**Decision:** Option (c): explicit spec objects are the ground truth
(required regardless — MicroPython retains no annotations, no parameter
names, no `inspect`), with build-time CPython codegen from real type hints
as an additive DX layer added later.

**Rationale:** Annotations are verified absent at runtime on the prebuilt
cli binary; the explicit-spec path is the only one that works unconditionally.
Codegen is additive and does not gate P6/P7.

**Owner phase:** P5.

## Q6 — Hub binary-serving route + caching  [OPEN — owner P8]

**Decision:** Not needed before P8; left open.

**Rationale:** No packaging or distribution work exists yet to decide
against; deciding now would be speculative.

**Owner phase:** P8.

## Q7 — Library names  [DECIDED 2026-07-23 (accepted by Andrew via 'proceed')]

**Decision:** `mpyfastmcp` (fixed), and `mpyws` / `mpyjsonrpc` / `mpyschema`
for the WS client / JSON-RPC stdio / schema libraries respectively.

**Rationale:** Names were already working names throughout the roadmap;
formalizing them removes ambiguity for P3–P6 package layout.

**Owner phase:** P0.
