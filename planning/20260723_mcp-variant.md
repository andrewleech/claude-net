# P2 findings: the `mcp` picolet runtime variant

Date: 2026-07-23
Anchors: claude-net `main` @ `4f564a56b9`, picolet `dev` @ `2fe3ef5d14`

This note records P2: standing up a dedicated `mcp` picolet runtime variant
(cli baseline + TLS) per the Q1 decision, sizing it against the NFR-MCP-1
1 MiB ceiling, enforcing the single-binary guarantee, and closing Q3.

## Outcome

PASS. The `linux-x64/mcp` variant builds to 899,384 bytes (85% of the 1 MiB
ceiling), links mbedtls and libffi statically (single-binary clean, enforced
by a new post-link import-table guard), satisfies the full import surface,
and passes a real-hub WSS/TLS smoke. Q3 is decided and recorded. Two review
rounds; all major findings from round 1 closed in round 2; only minor
documentation/robustness nits remain (see residuals).

## Variant configuration

- **SSL: on.** `MICROPY_PY_SSL=1`, `MICROPY_SSL_MBEDTLS=1`, `MICROPY_SSL_AXTLS=0`
  set in `variants/mcp/unix/mpconfigvariant.mk`. Setting `MICROPY_SSL_MBEDTLS=1`
  in the `.mk` (which the unix port Makefile `include`s before `extmod/extmod.mk`
  parses) makes `extmod.mk`'s `GIT_SUBMODULES += lib/mbedtls` trigger for the
  `make submodules` step — no separate submodule wiring needed.
- **Compiler: on.** The variant `.h` includes the shared picolet common header,
  so the MicroPython compiler stays enabled (cli baseline behaviour).
- **hashlib: SHA1 only.** `MICROPY_PY_HASHLIB=1` + `MICROPY_PY_HASHLIB_SHA1=1`,
  MD5 and SHA256 explicitly forced to 0 (see Q3).
- **FFI: on.** `MICROPY_PY_FFI=1`; FFI + STANDALONE + romfs_trailer wiring
  carried over from the cli baseline.
- **Manifest:** `manifests/manifest_mcp.py`, content-identical to
  `manifest_cli.py` (dedicated variant per Q1; plugin libs ship via app romfs
  per Q4, not frozen here).
- mbedtls is version 3.6.6 (reported by the running binary).

## Final binary size vs the 1 MiB ceiling

- Artifact: `build/picolet-runtime-linux-x64-mcp`, **899,384 bytes**
  (878.3 KiB), stripped, ELF 64-bit LSB PIE, x86-64.
- Ceiling: **1,048,576 bytes** (NFR-MCP-1). Headroom: **149,192 bytes**
  (~14.2%); binary is at 85% of the limit.
- The size gate in `build-runtime.sh` (`linux-x64/mcp) CEILING=1048576;
  NFR_ID="NFR-MCP-1"`) is a hard `exit 1` under `set -e`, not a warning.

## Single-binary check

`objdump -p` NEEDED list on the artifact:

```
NEEDED   libm.so.6
NEEDED   libc.so.6
```

`ldd` confirms only `linux-vdso.so.1`, `libm.so.6`, `libc.so.6`,
`/lib64/ld-linux-x86-64.so.2` — all ubiquitous system libs. No mbedtls,
libffi, or sidecar `.so`; both third-party libs link statically as intended.

A new `[7c]` post-strip guard was added to `build_linux_x64()` in
`build-runtime.sh`, gated on `VARIANT == "mcp"`, mirroring the windows-lvgl
`[7c]` pattern: it runs `objdump -p`, extracts NEEDED entries via `awk`, and
fails the build if any entry falls outside the allow-list (`libc.so.6`,
`libm.so.6`, `libpthread.so.0`, `libdl.so.2`, `librt.so.1`,
`ld-linux-x86-64.so.2`, `linux-vdso.so.1`). It also asserts objdump did not
silently produce zero NEEDED lines, so a tool failure can't be mistaken for a
pass. Verified by hand: passes on the mcp artifact, and correctly flags
`libSDL2-2.0.so.0` when pointed at the lvgl artifact (regex discriminates).

## Import surface

All present, verified by running the binary: `tls`, `asyncio`,
`select.poll`, `ffi`, `json`, `binascii`, `os.urandom`, `time.time_ns`, plus
`hashlib.sha1` (correct 20-byte digest / Sec-WebSocket-Accept confirmed).
`tls.SSLContext` with `CERT_REQUIRED` instantiates — TLS is genuinely
compiled in, not a stub.

## Q3 — hashlib/SHA1 measurement and decision

**Decision: enable `hashlib.sha1`; keep MD5 and SHA256 off.** Recorded in
`planning/DECISIONS.md` (status flipped OPEN → DECIDED 2026-07-23), and the
ROADMAP open-questions row updated to match.

**Measured delta:** both configurations were built and the stripped artifacts
compared. Without hashlib: 899,384 bytes. With `hashlib.sha1` enabled
(MD5/SHA256 off): 899,384 bytes — **identical stripped size** (different
`md5sum`, same byte count). SHA1 is effectively free because mbedtls' SHA1
implementation is already statically linked for TLS; exposing it to `hashlib`
adds no measurable code. (Round-1 unstripped ELF section totals showed a
~952-byte `.text`/`.data` delta that page-alignment rounding erases after
strip.) Since verification costs nothing, Sec-WebSocket-Accept verification
stays in the WS client as a defensive check rather than being dropped.

## Build path

- **Path used: native fallback**, not the containerised `build-runtime.sh`
  docker path. Docker was unavailable in the sandbox (permission denied on the
  docker socket), so the build ran natively via a script adapted from the P1
  `build_tls.sh` spike, mirroring what `build-runtime.sh` does.
- `build-runtime.sh --target linux-x64 --variant mcp` is **wired** (dispatch
  case arm + size gate + `[7c]` guard) but **the containerised path is not
  itself validated end-to-end** here. The native build validates that the
  variant's own `.mk` / `.h` / manifest are correct; exercising the
  containerised path is a P3 residual (see below).
- One build detail carried from the spike: the romfs image must be staged under
  `$PKG_ROOT/build/` (as `build-runtime.sh`'s `build_romfs_image()` does), not
  under the scratchpad path — that path contains dashes, and `objcopy -I binary`
  symbol-name sanitization (all non-alphanumerics → `_`) desyncs from the unix
  port Makefile's `$(subst)` rule (handles only `.` and `/`), leaving
  `romfs_embedded_data`/`_end` undefined at link. This is the known issue
  already documented inline in `build_romfs_image()`.

## TLS smoke result

Round-2 verification ran the spike client (`mp_wss.py`) against the **real
claude-net hub** (`telie.story-kettle.ts.net:4815`): TCP connect, TLS
handshake with SNI, WebSocket 101 upgrade, `register` + `ping` both returning
correct JSON, clean close. VmRSS ~3.3 MB. End-to-end TLS/WSS/JSON-RPC on this
binary is confirmed viable.

## Files created / edited in picolet

Created:
- `packages/picolet-runtime/variants/mcp/unix/mpconfigvariant.mk`
- `packages/picolet-runtime/variants/mcp/unix/mpconfigvariant.h`
- `packages/picolet-runtime/manifests/manifest_mcp.py`

Edited:
- `packages/picolet-runtime/scripts/build-runtime.sh` — `linux-x64/mcp`
  dispatch arm, size-gate entry (`CEILING=1048576; NFR_ID="NFR-MCP-1"`), and
  the `[7c]` single-binary import-table guard.
- `packages/picolet-runtime/sbom/runtime.toml` — Mbed TLS 3.6.6 / Apache-2.0
  component scoped `variants=["mcp"]` (dual Apache-2.0 / GPL-2.0-or-later
  upstream; picolet takes the Apache-2.0 option per NFR-5); `mcp` added to the
  supported-variants header comment.

No git commit was made. Pre-existing uncommitted `.cdx.json` diffs and the
`micropython` submodule state were left untouched.

## Residuals for P3

- **Containerised build path unvalidated.** `build-runtime.sh --variant mcp`
  is wired but only proven via the native fallback (docker unavailable in the
  sandbox). Run the containerised path end-to-end when docker is available and
  confirm byte-for-byte parity with the native artifact.
- **`manifest_mcp.py` is a byte-for-byte copy of `manifest_cli.py`.** If the
  cli baseline manifest gains a module later, the mcp copy silently diverges
  with nothing to catch it. Consider delegating to a shared common manifest so
  mcp carries only its variant-specific delta. (Minor; deferred, not blocking.)
- **Doc-accuracy nits in variant comments.** The `mpconfigvariant.h` comment
  states SHA1 "fits per measured headroom" (real reason: ~0 marginal cost
  because mbedtls SHA1 is already linked), and the MD5/SHA256 default-mechanism
  note is wrong for SHA256 (it defaults on unconditionally at EXTRA_FEATURES
  ROM level, not SSL-gated; MD5 is the SSL-gated one). Behaviour is correct
  (both forced to 0); only the explanatory comments are imprecise.
- **`[7c]` allow-list omits `libgcc_s.so.1` / `libstdc++`.** Fail-closed today
  (current binary needs neither), but a future toolchain emitting `libgcc_s`
  as NEEDED would false-fail the build. Add it to the allow-list or document
  the deliberate strictness.
- **`[7c]` guard scoped to mcp only.** Other linux variants (notably lvgl,
  which legitimately links SDL2 dynamically) have no import-table guard; the
  lvgl dynamic-SDL2-on-Linux linkage is pre-existing and out of scope for P2.
