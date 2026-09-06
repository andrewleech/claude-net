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

## Q6 — Hub binary-serving route + caching  [DECIDED 2026-09-05]

**Decision:** A dedicated `GET /plugin-bin/:target` route in `claude-net/src/hub/plugin-bin-server.ts` (not an extension of `bin-server.ts`'s static `ASSETS` whitelist), with a paired `GET /plugin-bin/:target/version` returning `{version, sha256, target}`. `:target` is a fixed whitelist (`linux-x64` only); both routes hash the on-disk binary once and cache it, mirroring `bin-server.ts`'s lazy-build-once pattern. The cache key is `mtimeMs + size + ino`, not mtime alone. A stage-then-rename deploy (`rsync -a`'s default behaviour, and `sync-plugin-binary.sh` itself, which stages to a `.tmp` sibling and `mv -f`s it into place) can leave mtime identical while the bytes change; the rename always points the served path at a freshly allocated inode, which `ino` catches. `size` separately catches a length-changing in-place overwrite (a plain `cp` onto an existing path truncates and rewrites the *same* inode, unlike the stage-then-rename case). Neither field catches a same-length, same-mtime, in-place overwrite via a bare `cp`/`cp -p`; that residual gap is accepted, avoided in practice by always deploying through `sync-plugin-binary.sh`'s atomic rename rather than a bare `cp` onto the live path.

The `version` field the routes advertise is read from a `.version` sidecar file next to the binary (`sync-plugin-binary.sh` writes it when staging), not from this hub process's own `package.json`. The sidecar's content is validated against a plain version-string shape before use; a malformed or multi-line sidecar falls back to `PLUGIN_VERSION_CURRENT` with a log line rather than being placed into an HTTP header verbatim. Those two version sources are deliberately decoupled: the binary is staged manually, not on every hub deploy, so advertising `PLUGIN_VERSION_CURRENT` directly would advertise a version the staged binary doesn't actually have. This sidecar makes the *advertised* version honest, but on its own does not stop a redownload loop when package.json is bumped ahead of the staged binary; the actual fix for that loop is client-side, in the `launch` wrapper (below). Falls back to `PLUGIN_VERSION_CURRENT`, logged, when the sidecar is absent or malformed.

No wire-protocol change for the refresh signal: `ws-plugin.ts`'s existing `upgrade_hint` field on the register response (present whenever a connecting plugin's `plugin_version` doesn't match `PLUGIN_VERSION_CURRENT`) is sufficient on its own; its mere presence is the machine-readable trigger. `plugin.py`'s `_auto_register_with_retry` now also writes an empty `~/.claude-net/plugin/.stale` marker in that branch (best-effort, log-only, never raised), alongside the existing one-shot nudge-queue append it already did.

Deploy mechanism: `claude-net/scripts/sync-plugin-binary.sh`, run manually or via manually-triggered `workflow_dispatch` (never on every push); downloads the named CI artifact, verifies its embedded `PLUGIN_VERSION` (read via a real MCP `initialize` handshake, matching `packaged_binary_smoke.py`'s stdio session pattern) against `package.json`'s version, and stages both the binary and its `.version` sidecar at `bin/claude-net-plugin-linux-x64[.version]` via a `.tmp` + atomic `mv -f` (never a plain `cp` onto the live, served path), without committing.

`/setup?runtime=mpy` is an opt-in query-param branch alongside the unchanged default `/setup` (bun path); it registers only the MCP server, not claude-channels/mirror/statusline, and its own output says so plus how to revert. It installs the binary (verifying sha256 against the version endpoint before trusting the initial download too) plus a `launch` wrapper (`~/.claude-net/plugin/launch`) that only re-checks freshness against `/plugin-bin/linux-x64/version` when `.stale` is present or the binary is missing, never on every launch. Because `upgrade_hint` fires on a `plugin_version` mismatch against the hub's own `PLUGIN_VERSION_CURRENT`, not against what's actually staged, the wrapper does not trust the hint at face value: it compares the version endpoint's full `{version, sha256, target}` response against the sidecar recorded at its own last successful install, and when they're identical it clears `.stale` without downloading anything: the hub-advertised triple hasn't changed, so `.stale` was a false positive from a package.json bump the staged binary hasn't caught up to. Only a real difference triggers an actual refresh, which still re-verifies sha256 before replacing the cached binary, and every step of that install (chmod, mv, sidecar write) is failure-checked so a partial failure can never silently clear `.stale` or report success. A refresh failure (hub unreachable, sha256 mismatch, a failed install step) is best-effort when a usable cached binary already exists: the wrapper logs to stderr and falls through to `exec`ing the cached binary rather than aborting the session. A persistent failure backs off via a `.refresh-failed` timestamp (skips re-attempting for several minutes) rather than paying a full multi-MB download on every single launch. A hard failure is reserved for the one case with nothing to fall back to: no cached binary and the refresh itself failed. Flipping `/setup`'s *default* to the binary path is explicitly deferred to a separate decision pending a real tracked soak period (ticket work item 7); this decision covers the route, caching, and opt-in install mechanics only.

**Rationale:** Reusing the existing `upgrade_hint` signal avoids a wire protocol change and rides a connection the plugin already opens on every launch/reconnect, so there is no added per-launch latency for the common "already current" case. A dedicated route (vs. extending `bin-server.ts`) keeps the static-asset whitelist and the versioned-binary-with-headers concern separate, since they have different content-types, caching semantics, and lifecycles. Committing the binary via a manual sync script rather than continuous CI deployment keeps binary updates deliberate and in lockstep with a version bump, per the ticket's own "not continuous" framing. Fixing the hub/binary version-skew redownload loop client-side (compare-before-download in the wrapper) rather than server-side defends regardless of what the hub advertises, since the hub's own `PLUGIN_VERSION_CURRENT`/staged-binary decoupling is inherent to the deploy model, not a bug to chase out of `ws-plugin.ts`.

**Owner phase:** P8.

## Q7 — Library names  [DECIDED 2026-07-23 (accepted by Andrew via 'proceed')]

**Decision:** `mpyfastmcp` (fixed), and `mpyws` / `mpyjsonrpc` / `mpyschema`
for the WS client / JSON-RPC stdio / schema libraries respectively.

**Rationale:** Names were already working names throughout the roadmap;
formalizing them removes ambiguity for P3–P6 package layout.

**Owner phase:** P0.
