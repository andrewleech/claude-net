import pkg from "../../package.json";

export const PLUGIN_VERSION_CURRENT: string = pkg.version;

/**
 * Build the upgrade-nudge text the hub returns when a registering
 * plugin's `plugin_version` does not match `PLUGIN_VERSION_CURRENT`.
 *
 * @param hubUrl  Informational hub URL shown in the curl command — does
 *                not need to be authoritative; the user corrects it
 *                locally if it's wrong.
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
