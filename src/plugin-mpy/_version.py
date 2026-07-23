"""Single source for the claude-net plugin version.

`plugin.py` reports this as both the MCP `serverInfo.version` and the
`plugin_version` field on every register frame sent to the hub. Must stay
in lockstep with the bun plugin's `PLUGIN_VERSION`
(`src/plugin/plugin.ts`) and the hub's `PLUGIN_VERSION_CURRENT`.
"""

PLUGIN_VERSION = "0.2.0"
