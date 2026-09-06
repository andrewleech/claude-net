# Ticket: P8 — Packaging, distribution, rollout

- Phase: P8
- Owner-model (impl / test / review): sonnet / haiku / opus
- Depends on: P7
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: 2026-07-23 @ pre-commit
- Revalidated:

## Goal

The hub serves the versioned binary; a fresh host installs and runs the
MicroPython plugin via `curl <hub>/setup | bash`; version lockstep and
upgrade_hint keep it current; rollout is opt-in first, then default.

## Preconditions

P7 complete: the claude-net plugin has full feature parity on the picolet
MicroPython runtime, with the parity harness green against the pinned hub
version. The picolet `mcp` variant (P2) is built and available as the
runtime this phase packages.

## Work items

1. Production packaging: `build-runtime.sh` romfs-append step producing
   `claude-net-plugin-linux-x64` (mcp binary + plugin app romfs), version
   stamped at build; a build check asserts embedded PLUGIN_VERSION equals hub
   package.json version (lockstep, replacing plugin.ts's "bump both" comment
   discipline).
2. **Done (2026-09-05).** Hub serving (Q6): dedicated `GET /plugin-bin/:target` + `GET /plugin-bin/:target/version` route in `claude-net/src/hub/plugin-bin-server.ts` (not a bin-server whitelist extension, see DECISIONS.md). `:target` whitelisted to `linux-x64`; version endpoint returns `{version, sha256, target}`, hash cached (keyed on mtime + size + ino, not mtime alone) until the file's identity changes, version read from a `.version` sidecar `sync-plugin-binary.sh` stages alongside the binary rather than from the hub's own package.json.
3. **Done (2026-09-05).** setup.ts: new `/setup?runtime=mpy` install path, downloads the binary to `~/.claude-net/plugin/` (sha256-verified against the version endpoint before it's trusted), chmod +x, writes the `launch` wrapper, registers the MCP server command as that wrapper (`exec`'d with argv forwarded, so ppid is CC). Its own output states the install is MCP-server-only (not claude-channels/mirror/statusline) and how to revert to the bun path. Deviation from this item's original phrasing: the *default* `/setup` (no param) is unchanged (still bun), and the new binary path is opt-in behind `?runtime=mpy`, not the reverse (`?runtime=bun` gating the old path) as the Q6 spec draft's "later" section had sketched, since flipping the default is explicitly deferred to work item 7 pending a real soak period, not assumed here.
4. **Done (2026-09-05).** Upgrade flow: no wire-protocol change needed; `ws-plugin.ts`'s existing `upgrade_hint` field is sufficient signal on its own. `plugin.py`'s register-response handler now also writes `~/.claude-net/plugin/.stale` (best-effort, alongside the existing nudge-queue append) when `upgrade_hint` is present. The `launch` wrapper only re-checks the hub's version endpoint when `.stale` is set or the binary is missing, never on every launch. Because `upgrade_hint` fires on a mismatch against the hub's own `PLUGIN_VERSION_CURRENT` rather than what's actually staged, the wrapper compares the version endpoint's full `{version, sha256, target}` response against its own cached copy before downloading anything, and skips the download entirely when they already match (closing a redownload loop a hub/binary version-skew would otherwise cause on every single launch). A real difference still gets sha256-verified before replacing the live binary, and every install step (chmod, mv, sidecar write) is failure-checked so a partial failure can't silently clear `.stale` or report success. A refresh failure is best-effort when a cached binary already exists: the wrapper falls back to exec'ing it rather than aborting the session, backs off via a `.refresh-failed` timestamp on a persistent failure, and only hard-fails when there's no cached binary to fall back to.
5. install-channels / statusline / mirror-agent interplay: state-file format
   unchanged (statusline.py reads it), `CLAUDE_NET_CHANNELS_PATCHED` export
   honored, docs updated.
6. Hub-side PLUGIN_VERSION_CURRENT / buildUpgradeHint unchanged in semantics;
   CI job in the worktree builds the binary and runs the parity harness
   against the hub version it will ship with.
7. Rollout: (a) opt-in on Andrew's hosts, soak ≥ 1 week of real use across
   ≥ 10 concurrent sessions; (b) flip /setup default to the binary; (c) bun
   path retained as documented fallback for one release, then removed.
   Aggregate-memory measurement before/after recorded in the phase report.

## Interfaces / contracts

- `/plugin-bin/<target>` (or the extended bin-server route) exposed by the
  hub, serving the versioned linux-x64 binary alongside a version/hash
  endpoint.
- `setup.ts` install contract: binary lands at `~/.claude-net/plugin/`,
  executable, registered as the MCP server command with argv/env semantics
  identical to the current bun invocation; `/setup?runtime=bun` selector kept
  live for the duration of the rollout.
- Embedded `PLUGIN_VERSION` in the binary must equal the hub's package.json
  version at build time (lockstep assert, enforced in CI).
- State-file format consumed by statusline.py is unchanged;
  `CLAUDE_NET_CHANNELS_PATCHED` export contract is honored by the new install
  path.

## Tests

- Fresh-host install: clean container, run `/setup` from scratch, confirm a
  working session with inbound channels and zero manual steps beyond the
  one-liner.
- Upgrade test: old binary + bumped hub version → upgrade_hint surfaces →
  re-running setup lands the new version.
- Mixed-fleet test: bun and mpy plugins registered simultaneously against the
  same hub; hub treats both correctly (register frame's plugin_version
  distinguishes fleets).
- statusline renders correctly from the mpy plugin's state file.
- `/mcp reconnect` restores the persisted name.
- Adversarial pass (opus, part of the review loop) on the supply path:
  partial/interrupted download, hub/binary version skew, stale client-side
  cache, concurrent-session download race.

## Exit criteria

- Fresh install produces a working session with inbound channels, zero
  manual steps beyond the documented one-liner.
- Version-lockstep check (embedded PLUGIN_VERSION == hub package.json
  version) enforced in CI.
- Soak criteria met: ≥ 1 week opt-in soak across ≥ 10 concurrent sessions on
  Andrew's hosts, with before/after aggregate-memory measurement recorded in
  the phase report.
- `/setup` default flipped to the binary path, with the bun path documented
  as the retained fallback for one release before removal.

## Open questions consumed

- Q6 — Hub binary-serving route + client-side caching/refresh mechanics.
  **Decided 2026-09-05**, see `DECISIONS.md`: dedicated `/plugin-bin/:target` route (not a bin-server whitelist extension), caching at `~/.claude-net/plugin/` gated on the existing `upgrade_hint` signal (no new wire field), deploy via `scripts/sync-plugin-binary.sh` (manual/`workflow_dispatch`, not per-push CI), opt-in via `?runtime=mpy` with the default-flip left to work item 7.

## Risks

- Version skew binary↔hub after install (risk register, owner P8): mitigated
  by the build-time lockstep assert, the spawn-time freshness check, and the
  upgrade_hint path test.
- Only linux-x64 served initially; non-Linux hosts (risk register, owner
  P8/P9): mitigated by mixed-fleet support keeping the bun path working on
  hosts P9 has not yet reached.
- Parity drift vs the bun plugin evolving on main during build-out (risk
  register, owner P7, but load-bearing for P8's CI job): the CI job in work
  item 6 runs the parity harness against the hub version P8 ships with, which
  depends on P7's harness having been revalidated at P8 entry.
- Supply-path failure modes implied by "rollout" but not separately listed in
  the roadmap's risk register: a partial download leaving a half-written
  binary at `~/.claude-net/plugin/`; concurrent sessions racing the same
  download; a stale hub-side cache serving a mismatched version/hash pair.
  These form the adversarial-review brief for this phase's opus pass.
