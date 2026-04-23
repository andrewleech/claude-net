// FR8: hub-side plugin version tracking.
//
// `PLUGIN_VERSION_CURRENT` is the single source of truth for the plugin
// version the hub expects. It is sourced from `package.json` via Bun's
// `resolveJsonModule` support — keeping the hub, the /plugin.ts bundle
// served over HTTP, and the MCP `Server({ version })` declaration all in
// lockstep with one source (the repo's package.json).
//
// If the plugin registers with a different `plugin_version` (or omits
// the field entirely — old plugins that predate FR8), the hub returns
// `upgrade_hint` in the register response `data`. The plugin surfaces
// that hint on the next tool result (see `attachUpgradeNudgeIfPending`
// in src/plugin/plugin.ts).

import pkg from "../../package.json";

export const PLUGIN_VERSION_CURRENT: string = pkg.version;

/**
 * Build the upgrade-nudge text the hub returns when a registering
 * plugin's `plugin_version` does not match `PLUGIN_VERSION_CURRENT`.
 *
 * @param hubUrl  Informational hub URL shown in the curl command — does
 *                not need to be authoritative; the user corrects it
 *                locally if it's wrong. See FR8's Risks note.
 * @param observedVersion  The plugin-reported version. If falsy (e.g.
 *                older plugins that omitted the field), the hint uses
 *                `"unknown"` in its place.
 */
export function buildUpgradeHint(
  hubUrl: string,
  observedVersion: string | undefined | null,
): string {
  const observed =
    observedVersion && observedVersion.length > 0 ? observedVersion : "unknown";
  return `claude-net: your plugin (version ${observed}) is out of date. The hub is on ${PLUGIN_VERSION_CURRENT}. To upgrade, re-run the install script: curl -fsSL ${hubUrl}/setup | bash`;
}
