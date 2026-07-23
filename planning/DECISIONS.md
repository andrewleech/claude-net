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

## Q3 — hashlib/SHA1 for Sec-WebSocket-Accept verification  [OPEN — owner P2]

**Decision:** Deferred to P2: measure the size cost against the 1 MiB
ceiling (~146 KB headroom over the 878 KB baseline); enable only if it fits
comfortably. Accept-header verification is non-load-bearing for a client, so
skipping it is acceptable if it doesn't fit.

**Rationale:** No measurement exists yet against the actual `mcp` variant
build; the decision depends on a number P2 produces, not on preference.

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
