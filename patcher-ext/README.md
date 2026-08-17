# claude-net-patcher

Channel-unlock patches for the Claude Code binary, packaged as a
[`cc-patcher`](https://github.com/andrewleech/cc-patcher) provider. This
package ships inside the [claude-net](https://github.com/andrewleech/claude-net)
repo (in `patcher-ext/`), so it installs from that repo's subdirectory
rather than one of its own.

Registers seven edits under the `cc_patcher.patches` entry-point group —
six same-length, one growable:

1. Feature gate (`tengu_harbor` Statsig flag forced true)
2. Org policy (`channelsEnabled` check inverted)
3. Channel allowlist bypass
4. Session channel list fallback (growable) — the per-session lookup gets a
   synthetic server entry, so channels register without
   `--dangerously-load-development-channels` and work under any launcher
5. Dev channels dialog auto-accept
6. Channel notification suppression
7. Dynamic workflows master gate (Y2)

## Install

Injected into `cc-patcher`'s environment with `--with`:

```bash
uv tool install git+https://github.com/andrewleech/cc-patcher \
    --with "git+https://github.com/andrewleech/claude-net#subdirectory=patcher-ext"
```

The patches are then discovered automatically by `cc-patcher launch`,
`cc-patcher resolve`, `cc-patcher --list-patches`, etc. claude-net's
`bin/install-channels` runs this for you.
