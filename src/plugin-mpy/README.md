This is the MicroPython/picolet claude-net plugin — a functional replacement
for `src/plugin/plugin.ts` running on a picolet MicroPython binary instead of
bun. Reusable libraries (`mpyws`, `mpyjsonrpc`, `mpyschema`, `mpyfastmcp`)
live under `lib/` and ship with the plugin app via the picolet build's app
romfs (Q4), not as a picolet-repo manifest change.
