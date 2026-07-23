# Ticket: P2 — The `mcp` picolet variant

- Phase: P2
- Owner-model (impl / test / review): sonnet / haiku / opus
- Depends on: P0
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: 2026-07-23 @ pre-commit
- Revalidated:

## Goal

A reproducible, size-gated picolet variant purpose-built for the plugin: cli
baseline + TLS (per Q1), landed in the picolet repo with an SBOM entry. P3's
TLS tests and everything after ship on this binary; P2 runs in parallel with
P1, which uses the spike's ad-hoc `picolet-mcp-tls` build instead of waiting
on this variant.

## Preconditions

P0 complete: picolet-mcp-tls worktree scaffolding committed and Q1/Q4/Q7
closed (all three are DECIDED per `planning/DECISIONS.md`). Q1's decision —
option (a), a dedicated `mcp` variant rather than re-enabling TLS in the
shared `cli` variant — is what this phase exists to execute.

## Work items

1. `variants/mcp/unix/mpconfigvariant.{h,mk}`: cli baseline with
   `MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1` (from `build_tls.sh`), compiler ON
   (dev iteration runs .py directly).
2. Decide + implement Q3 (hashlib/SHA1 .h override) after measuring its size
   cost against the 1 MiB ceiling (878 KB baseline, ~146 KB headroom).
3. `manifests/manifest_mcp.py` (initially minimal; libs ship via app romfs
   per Q4 unless Q4 chose freezing).
4. `scripts/build-runtime.sh`: `linux-x64/mcp` case arm + size-gate entry
   (ceiling 1 MiB, new NFR id, e.g. NFR-MCP-1).
5. `sbom/runtime.toml`: mbedtls declaration (dependency policy).
6. Decide + implement Q2 (cert posture): if bundling, embed
   `isrg_root_x1.der` in the romfs/frozen data and wire CERT_REQUIRED + SNI
   as the library default with an explicit insecure override.
7. Commit on picolet `dev` per its commit policy (signed, phase-tagged
   message referencing this work).

## Interfaces / contracts

The binary's import surface is the contract downstream phases build against:
`tls`, `asyncio`, `select.poll`, `ffi`, `json`, `binascii`, `os.urandom`,
`time.time_ns` must all be present. P3's `mpyws` TLS wrapping and P1's
findings both assume this surface. The cert-verification default this phase
wires (CERT_REQUIRED + SNI against the bundled ISRG Root X1 DER, with an
explicit insecure-override env var falling back to CERT_NONE) is the
contract P3's WS client codes against, not a per-call choice it re-derives.

## Tests

Build from clean; size gate green; smoke: binary runs `mp_wss.py`
register+ping against the real hub; import-surface test (asserts tls,
asyncio, select.poll, ffi, json, binascii, os.urandom, time.time_ns all
present).

## Exit criteria

`picolet-runtime-linux-x64-mcp` builds ≤ 1 MiB with gate enforced; real-hub
TLS smoke green; SBOM updated; Q2/Q3 DECIDED and recorded.

## Open questions consumed

- Q1 (TLS packaging) — DECIDED: option (a), a dedicated `mcp` picolet variant
  (cli baseline + SSL/mbedtls, 878 KB proven), not re-enabling TLS in the
  shared `cli` variant. This is what work item 1 executes; picolet's leaner
  `cli` variant stays untouched (NFR-1).
- Q2 (cert verification posture) — DECIDED: option (b), bundle ISRG Root X1
  as DER, CERT_REQUIRED, and SNI as the library default, with an explicit
  insecure-override env var (falls back to CERT_NONE over the tailnet). Work
  item 6 implements this; the hub cert is Let's Encrypt via `tailscale cert`.
- Q3 (hashlib/SHA1 for Sec-WebSocket-Accept verification) — OPEN, owner P2:
  this ticket's own deliverable. Work item 2 measures the size cost against
  the 1 MiB ceiling (~146 KB headroom over the 878 KB baseline) and enables
  the override only if it fits comfortably; Accept-header verification is
  non-load-bearing for a client, so skipping it is acceptable if it does not
  fit.
- Q4 (where the reusable libs live) — DECIDED: option (a), in the
  claude-net-mpy worktree, shipped via app romfs. This is why work item 3
  keeps `manifest_mcp.py` minimal — no picolet manifest/freeze change is
  needed for the libraries themselves, only for the variant's own baseline.

## Risks

- Size-gate blowout: enabling hashlib/SHA1 (Q3) without first measuring
  against the ~146 KB headroom could push the variant over the 1 MiB
  ceiling — mitigated by making the measurement itself work item 2, gating
  the decision on the number rather than preference.
- Single-binary guard: the bundled `isrg_root_x1.der` (Q2) must land as
  embedded romfs/frozen data, not a sidecar file next to the binary — the
  build script's post-link import-table check (per picolet's single-binary
  policy) must cover the `mcp` variant the same way it covers the existing
  webview/lvgl variants.
- Dependency-policy gate: mbedtls must be declared in
  `sbom/runtime.toml` (work item 5) before it enters the build, per
  picolet's dependency policy, and its license confirmed compatible with
  static linking (NFR-5 forbids static-linking GPL/AGPL components).
