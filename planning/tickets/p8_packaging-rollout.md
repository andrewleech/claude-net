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
2. Hub serving (Q6): route for the binary (bin-server whitelist extension or
   `/plugin-bin/<target>`), correct content-type, and a version/hash endpoint
   so installs can check freshness cheaply.
3. setup.ts: new install path — download binary to `~/.claude-net/plugin/`
   (not /tmp: it must survive reboots, unlike the current per-launch .ts
   fetch), chmod +x, register the MCP server command as the binary (argv/env
   identical semantics: exec'd so ppid is CC); keep the bun path behind a
   flag during rollout (e.g. `/setup?runtime=bun`).
4. Upgrade flow: hub upgrade_hint text already says re-run `/setup` — verify
   it holds for the binary path; wrapper or launcher re-checks version against
   the hub endpoint at spawn and re-downloads when stale (decide exact
   mechanics under Q6; must not add per-launch latency when current).
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
  Status per `DECISIONS.md`: OPEN, owner P8, "not needed before P8; left
  open" — deciding earlier would have been speculative with no packaging or
  distribution work yet to decide against. This phase is where Q6 gets
  decided: work item 2 chooses between extending the bin-server whitelist and
  a dedicated `/plugin-bin/<target>` route; work item 4 chooses between
  caching at `~/.claude-net/` keyed by version and re-downloading on every
  upgrade_hint. Record the resolved choice as a new dated entry in
  `DECISIONS.md` once settled.

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
