# P8-packaging synthesis {#20260723-packaging}

Date: 2026-07-23
Anchors: claude-net-mpy `mpy-plugin` (this worktree, P8 packaging round);
picolet mcp runtime @ `be86d845af4556dcea501bb4aebb2dca651ea165`
("Add linux-x64/mcp variant: cli baseline + static mbedtls TLS").

## Outcome

P8 packaging is done and verified. The claude-net MicroPython plugin ships
as one executable — `build/claude-net-plugin-linux-x64`, 1,068,642 bytes
(~1.06 MB) — that runs from an arbitrary working directory, completes a
full MCP `initialize` / `tools/list` / `prompts/list` / `tools/call`
handshake, and resolves every module (`plugin`, `mpyfastmcp`, `mpyjsonrpc`,
`mpyws`, the `_hub` helpers) from an appended romfs with no `sys.path`
manipulation on disk. It exposes the expected surface: 11 tools (`whoami`,
`register`, `send_message`, `send_team`, `join_team`, `leave_team`,
`list_agents`, `list_teams`, `ping`, `_ack_channel`, `hub_events`) and the
`rename` prompt. Two adversarial-review rounds ran; both returned PASS.
Scope stayed packaging-only: no `src/hub/`, `setup.ts`, or install-default
changes, and the prebuilt mcp binary was reused, not rebuilt.

## Packaging mechanism (romfs-append single file)

`scripts/package-plugin.py` (+ `.sh` wrapper) produces the artifact by:

1. Staging `plugin.py`, the `_*.py` helpers, `isrg_root_x1.der`, and
   `lib/{mpyjsonrpc,mpyschema,mpyws,mpyfastmcp}`, filtered of dev/test
   material (`test_*.py`, `tests/`, `proof_taxonomy.py`, `example_echo.py`,
   `demo_server.py`, `mock_hub.py`, READMEs, `__pycache__`, and the mpyws
   TLS test fixtures — the localhost private key/cert never ship; only the
   public ISRG Root X1 CA does).
2. Emitting a generated 4-line `main.py` (`import plugin;
   asyncio.run(plugin.main())`) that exploits picolet's app-runner
   auto-run of `/rom/main.py`.
3. Building the romfs image with `mpremote romfs --no-mpy` — raw `.py`,
   deliberately not `.mpy`. The packaging host's `mpy-cross` is not
   guaranteed to match the already-built runtime's bytecode version, and
   chasing a matching cross-compiler is out of scope for a packaging-only
   round.
4. Concatenating `runtime || romfs payload || 24-byte PYLT trailer`. The
   trailer format (magic `PYLT`, u16 version, u16 flags, u64 payload_size,
   u32 crc32, u32 pad) is reimplemented from picolet's
   `variants/common/romfs_trailer.{h,c}`, which is referenced read-only —
   nothing in the picolet tree is touched. At runtime picolet mounts the
   payload at `/rom`, puts `/rom` and `/rom/lib` on `sys.path`, and
   auto-runs `/rom/main.py`.

Verified byte-exact: trailer at offset 1068610, payload 169,234 bytes,
CRC32 matching the C verifier; build is byte-reproducible across runs; the
build directory contains exactly one file (no sidecars).

## Packaged size

1,068,642 bytes total = ~899 KB prebuilt mcp runtime + ~169 KB appended
romfs payload + 24-byte trailer.

## Version-lockstep enforcement

`_version.py`'s `PLUGIN_VERSION` is checked against `package.json`'s
version before any build work starts; on mismatch the packager exits 1 and
prints both versions. Enforced identically in a standalone CI
`version-lockstep` job. Both directions verified: a deliberate mismatch
fails the build, a match passes.

Known gap (review, minor, non-blocking): a third version literal exists at
`src/plugin/plugin.ts` (`PLUGIN_VERSION = "0.2.0"`), and `_version.py`'s
docstring claims three-way lockstep, but the P8 gate only compares
`_version.py` vs `package.json`. `ceremony_tests.py` checks plugin.ts but
against a hand-edited hardcoded literal. The bun plugin can therefore drift
silently. Resolution (grep plugin.ts in CI, or single-source the version)
is left for a follow-up — flagged here so it isn't lost.

## CI job summary

`.github/workflows/package-plugin.yml`, four jobs:

- `version-lockstep` — portable, no checkout of picolet.
- `build-mcp-runtime` — checks out picolet at a pinned immutable SHA and
  builds the linux-x64/mcp variant. Pinned to
  `be86d845af4556dcea501bb4aebb2dca651ea165`, not the branch `dev` (the
  original `PICOLET_REF: dev` was a reproducibility defect — dev HEAD is
  live-unstable while the concurrent stdin-fix / micropython-submodule
  track moves) and not the ticket's recorded anchor `2fe3ef5d14` (the
  `mcp` variant does not exist at that commit; the anchor predates the
  variant landing).
- `package-and-smoke` — portable; runs `packaged_binary_smoke.py`
  (`src/plugin-mpy/tests/`), which drives the packaged binary through
  initialize / tools-list / prompts-list / a tool call and asserts the
  exact 11-tool + `rename`-prompt set.
- `host-parity` — gated `if: false`. See residuals.

## Held for Andrew

Deliberately out of this round, requiring Andrew's decision or drive:

- **Hub route implementation** — the dedicated `/plugin-bin/:target` serve
  route and the cheap version/hash endpoint. Design only.
- **`/setup` changes** — `setup.ts` registration of the launch wrapper and
  the `?runtime=bun` fallback. Not touched.
- **Fleet rollout** — flipping the install default to the packaged binary.

All three are specified (not implemented) in
`planning/20260723_q6-hub-serving-spec.md` (SPEC ONLY): dedicated route +
version/hash endpoint, `~/.claude-net/plugin/` caching keyed on
version+hash, a `.stale`-marker refresh triggered off the register-frame
`upgrade_hint` rather than a per-launch network check, exec-PPID launch
semantics, and the bun fallback. `DECISIONS.md`'s Q6 entry is left OPEN —
ratifying it is Andrew's call. Two spec-completeness notes from review for
Andrew: (1) the launch wrapper does not verify the downloaded binary's
sha256 against the advertised hash before `mv`/`chmod`+exec — add that
integrity gate; (2) reconcile the wrapper's `bash -c` vs direct
`-- .../launch` registration wording (the exec-PPID invariant holds either
way; doc clarity only).

## Residuals

- **Canonical mcp binary may be regenerated.** The concurrent stdin-fix
  track is rebuilding the picolet micropython submodule (visible as a
  modified submodule in the picolet tree). When that lands a new mcp
  runtime, the packager simply re-appends the plugin romfs onto the new
  runtime — no packager change needed; only re-run, and bump the pinned
  `PICOLET_REF` SHA once the new runtime commit is chosen.
- **No enabled CI gate exercises the packaged binary against a real hub.**
  `packaged_binary_smoke.py` runs fully offline (no `CLAUDE_NET_HUB`), so
  CI-green attests import/registration/dispatch from romfs but not the
  shipped artifact's WS/TLS hub connectivity.
- **`host-parity` job disabled (`if: false`).** `tests/parity_harness.py`
  and `tests/ceremony_tests.py` invoke the interpreter in source-tree form
  (`[MPY_BINARY, "plugin.py"]`) and hardcode
  `NODE_PATH=/home/anl/claude-net/node_modules` (the sibling main-worktree
  bun deps). Both are host-path-coupled and don't hold on a generic runner.
  Retargeting them to drive the packaged single-file binary is a P7
  test-infra change, not packaging; the job is gated pending a self-hosted
  runner that mirrors the path layout (or a parameterized MPY_BINARY /
  NODE_PATH + a CI mock-hub WSS smoke).
