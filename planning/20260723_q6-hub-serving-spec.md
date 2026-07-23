# Q6 spec: hub binary-serving route + client-side caching/refresh

Date: 2026-07-23
Anchors: claude-net-mpy `mpy-plugin` @ (this worktree, P8 round 1), picolet
`dev` @ `2fe3ef5d14`

**Status: SPEC ONLY, NOT IMPLEMENTED.** This is the design Q6 asks for
(`planning/DECISIONS.md`, `planning/tickets/p8_packaging-rollout.md` work
items 2–4). It does not touch `src/hub/`, `setup.ts`, or any install
default — P8 round 1 is packaging only (`scripts/package-plugin.{sh,py}`,
the packaged-binary smoke test, the CI job). Andrew reviews this document,
decides whether to accept it as-is or amend it, then drives the hub-side
implementation and the fleet rollout himself. Once accepted, the decision
gets its own dated entry in `DECISIONS.md` replacing the current "Q6 —
OPEN" one; I haven't touched that file here since ratifying it isn't my
call to make.

## What exists today, that this extends

- `bin-server.ts` serves a fixed whitelist of files from `bin/` under
  `GET /bin/:name` — `claude-channels`, the mirror binaries, `statusline.py`,
  vendored dashboard JS. No binary artifact in that set yet; everything
  there is small enough to ship as source/script.
- `setup.ts`'s `/setup` script registers the MCP server as:
  ```
  claude mcp add --scope user -e CLAUDE_NET_HUB="$HUB" --transport stdio \
      claude-net -- bash -c 'T=$(mktemp ...) && P="$T.ts" && mv "$T" "$P" \
      && curl -fsSL '"$HUB"'/plugin.ts -o "$P" && exec bun run "$P"'
  ```
  Every launch re-downloads `plugin.ts` fresh to `/tmp` and `exec`s `bun run`
  on it — no local cache, always current, but always pays a network round
  trip and a bun cold start. `exec` replaces the shell so the running
  plugin's PPID is Claude Code's PID, which `_identity.py`/`plugin.ts`'s
  ppid-based session discovery depends on.
- `version.ts` exports `PLUGIN_VERSION_CURRENT` (from `package.json`) and
  `buildUpgradeHint()`, which the hub calls when a registering plugin's
  `plugin_version` doesn't match — currently just tells the user to re-run
  `/setup`.

The binary path changes the trade-off: a 1 MB executable is too big to
re-fetch on every launch the way `plugin.ts` (a few KB of source) is, so it
needs a real local cache with an explicit refresh trigger instead of
"always redownload."

## Route design

### `GET /plugin-bin/:target`

A dedicated route, not an extension of `bin-server.ts`'s `ASSETS` whitelist.
`ASSETS` maps name → static file already on disk in `bin/`; the plugin
binary is a versioned, per-target build artifact, not a source file the hub
ships as-is, and it wants its own content-type and headers (below). Folding
it into the same whitelist map would work mechanically but conflates two
different kinds of asset — reuse the *pattern* (flat whitelist, no path
traversal), not the same map.

`:target` values: `linux-x64` initially (the only variant P8 builds — see
`p8_packaging-rollout.md` risk register, "Only linux-x64 served initially").
Anything else is a 404, not a directory listing or a path-traversal
opportunity — same discipline as `bin-server.ts`'s `/docs/:name` filename
regex.

Response:
- `content-type: application/octet-stream`
- `content-disposition: attachment; filename="claude-net-plugin-<target>"`
- `x-plugin-version: <PLUGIN_VERSION>`
- `etag: "<sha256>"` (lets a client do a conditional `curl -z`/`If-None-Match`
  fetch instead of parsing the separate version endpoint first, if it wants)

### `GET /plugin-bin/:target/version`

Cheap on purpose — this is the thing a launcher can afford to hit somewhat
often. Returns:

```json
{ "version": "0.2.0", "sha256": "3a7f...", "target": "linux-x64" }
```

Computed once (stat + hash the file already on disk) and cached in memory,
the same lazy-once pattern `bin-server.ts` already uses for
`ensureBundleBuilt()` — not recomputed per request. Cache invalidates on
file mtime change (a redeploy replaces the binary on disk; the route
re-hashes once, then caches again) rather than per-request, so steady-state
cost is a map lookup.

### How the binary lands in `bin/` on the hub host

Out of scope for this document (deploy-pipeline detail, not a
route/caching question) — noted so it isn't silently assumed: the CI job in
`.github/workflows/package-plugin.yml` produces the artifact; something
(release step, rsync, a hub-side pull) has to put it at
`bin/claude-net-plugin-linux-x64` on whatever host runs the hub, in
lockstep with the hub's own `package.json` version. Whoever implements this
route picks that mechanism; it's a normal "how do deploy artifacts reach
the server" problem, not specific to the plugin binary.

## Client-side caching

Cache location: `~/.claude-net/plugin/` — not `/tmp` (P8 ticket already
calls this out: it must survive reboots, unlike the current per-launch
`.ts` fetch to `/tmp`).

Layout:
```
~/.claude-net/plugin/
  claude-net-plugin-linux-x64          # the cached binary, chmod +x
  claude-net-plugin-linux-x64.version  # sidecar: "version sha256\n"
  launch                               # thin exec wrapper, see below
  .stale                               # marker file, present only when an
                                        # upgrade is due (see refresh below)
```

Keying on version *and* hash (not version alone) covers a same-version
rebuild during development — a dev-cycle re-tag without a version bump
still gets picked up because the hash sidecar changes.

### Why no per-launch network check

Work item 4 says explicitly: "must not add per-launch latency when
current." A version check against `/plugin-bin/:target/version` on every
launch means every `claude-channels` invocation pays a network round trip
before Claude Code even starts, for the common case where nothing changed.
That's the wrong default for something invoked as often as every session
start.

Instead, reuse the channel that's *already* checking version on every
connection: the WS register frame. The plugin sends `plugin_version` on
register today; the hub already compares it to `PLUGIN_VERSION_CURRENT` and
calls `buildUpgradeHint()` when stale. That check is free — it rides an
already-open connection the plugin makes anyway, not an extra round trip.

The difference from today: instead of only surfacing upgrade text for a
human to read and manually re-run `/setup`, the hub's stale response also
triggers the plugin to write `~/.claude-net/plugin/.stale` (touch, empty
file) before it exits or reconnects. This costs nothing extra at launch —
it only fires on the connection where the hub *already* told the client
it's out of date, i.e. at most once per version bump, not once per launch.

### The launch wrapper

`~/.claude-net/plugin/launch` (installed by `/setup`, registered as the MCP
server command):

```bash
#!/bin/bash
set -eu
DIR="$HOME/.claude-net/plugin"
BIN="$DIR/claude-net-plugin-linux-x64"

if [ -f "$DIR/.stale" ] || [ ! -x "$BIN" ]; then
    HUB="${CLAUDE_NET_HUB:?}"
    ver=$(curl -fsSL "$HUB/plugin-bin/linux-x64/version")
    curl -fsSL "$HUB/plugin-bin/linux-x64" -o "$BIN.tmp"
    chmod +x "$BIN.tmp"
    mv -f "$BIN.tmp" "$BIN"
    echo "$ver" > "$DIR/claude-net-plugin-linux-x64.version"
    rm -f "$DIR/.stale"
fi

exec "$BIN"
```

The `mv -f` after writing to a `.tmp` sibling is the same partial-download
guard `_append_with_trailer`/`package-plugin.py`'s `append_with_trailer()`
already use on the build side — a download that dies partway through never
clobbers the binary a concurrent second session might be about to `exec`.
`exec "$BIN"` at the end keeps the same PPID-is-Claude-Code semantics the
current `bash -c '... && exec bun run ...'` line relies on: `launch` is
itself a `bash -c '...'` invocation from `claude mcp add`, and the final
`exec` replaces *that* process, so the binary's parent is Claude Code, not
`launch`.

Concurrent-session race: two sessions starting at once with `.stale`
present both attempt the download. Both write to their own `.tmp` suffix,
so neither corrupts the other's read of the currently-cached `BIN`; the
`mv -f` is atomic on the same filesystem (rename(2)), so whichever session
finishes first is visible to both, and the second `mv -f` just overwrites
it with (as expected) the same bytes. No lock file needed for correctness,
only for avoiding a duplicate download — an optimization I've left out
because a doubled download on the rare concurrent-session-during-upgrade
case is a fine trade against a lock file's own failure modes (stale locks,
etc.).

### setup.ts changes (later, when Andrew implements)

- New install path downloads `claude-net-plugin-linux-x64` to
  `~/.claude-net/plugin/`, `chmod +x`, writes the `launch` wrapper above,
  registers `claude mcp add ... claude-net -- $HOME/.claude-net/plugin/launch`
  (replacing the current `bash -c '... bun run ...'` line).
- `/setup?runtime=bun` keeps today's `plugin.ts`-fetch-and-`bun run` path
  live behind that flag for the rollout period (ticket work item 7c: "bun
  path retained as documented fallback for one release, then removed").
  Default (`/setup` with no `runtime` query param) flips to the binary path
  once the opt-in soak criteria in the ticket are met — that flip is a
  rollout decision, not part of this spec.
- Mixed-fleet support (ticket test "bun and mpy plugins registered
  simultaneously") needs no extra work here: `plugin_version` on the
  register frame already distinguishes which binary connected, and the hub
  side of this spec doesn't change based on which runtime sent it.

## Upgrade flow, end to end

1. Andrew (or CI) bumps `package.json`'s version and rebuilds/redeploys the
   binary to `bin/claude-net-plugin-linux-x64` on the hub host.
2. Next time any already-running plugin instance's WS connection sends a
   register frame (which happens on every fresh `claude-channels` launch,
   and on reconnect-after-disconnect for long-lived sessions), the hub sees
   `plugin_version` != `PLUGIN_VERSION_CURRENT`, replies with the
   upgrade-hint frame, and the plugin touches `.stale`.
3. That session keeps running on its old binary — no forced kill, no
   surprise behaviour change mid-session (matches the ticket's existing
   upgrade_hint semantics: it's a hint, not a forced upgrade).
4. The *next* `claude-channels` launch (new session, or this one restarted)
   sees `.stale`, re-downloads, and clears the marker before `exec`.

This means "soon" rather than "instantly" for stragglers (an idle session
that never reconnects won't see the hint until it does), which matches how
`upgrade_hint` already behaves today — nothing about that timing contract
changes, only the remediation action taken client-side.

## Supply-path failure modes (adversarial brief for this design)

- **Partial/interrupted download**: covered by the `.tmp` + atomic `mv -f`
  pattern above; a killed `curl` mid-download leaves `$BIN.tmp` corrupt but
  never touches the live `$BIN`, and the next launch retries because
  `.stale` is only cleared *after* the successful `mv -f`.
- **Hub/binary version skew**: the `sha256` in the version endpoint and the
  sidecar file catches a same-version-different-bytes rebuild that a
  version-string-only check would miss; `content-disposition`'s filename
  plus the sidecar's recorded version give an operator something to `diff`
  by hand if a report comes in that looks like skew.
- **Stale client-side cache**: bounded by the register-frame check above —
  worst case is "however long until this session's next reconnect", which
  is the existing `upgrade_hint` latency budget, not a new one.
- **Concurrent-session download race**: addressed above (both succeed,
  last `mv -f` wins, no corruption); flagged as a known minor inefficiency
  (double download) rather than a correctness problem.

## Open items left for the implementer

- Exact deploy mechanism for getting the CI-built artifact onto the hub
  host's `bin/` (noted above, deliberately not decided here).
- Whether `launch` should log its own redownload to somewhere a user can
  see it happened (statusline already surfaces plugin state; whether
  "upgraded to 0.3.0" belongs there is a UX call, not a caching-mechanics
  one).
- macOS/Windows targets get their own `:target` values and their own
  `launch` wrapper variant when P9 reaches them; nothing here is
  Linux-specific except the example script's shebang.
