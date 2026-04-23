import { describe, expect, test } from "bun:test";
import { PLUGIN_VERSION_CURRENT, buildUpgradeHint } from "@/hub/version";
import pkg from "../../package.json";

describe("hub/version", () => {
  describe("PLUGIN_VERSION_CURRENT", () => {
    test("matches package.json version", () => {
      // Sanity: the constant is the single source of truth for what
      // the hub expects. Any deployment skew between this and
      // package.json is a bug.
      expect(PLUGIN_VERSION_CURRENT).toBe(pkg.version);
    });

    test("is a non-empty string", () => {
      expect(typeof PLUGIN_VERSION_CURRENT).toBe("string");
      expect(PLUGIN_VERSION_CURRENT.length).toBeGreaterThan(0);
    });
  });

  describe("buildUpgradeHint", () => {
    test("includes the observed and current versions", () => {
      const hint = buildUpgradeHint("http://hub.test:4815", "0.0.1");
      expect(hint).toContain("0.0.1");
      expect(hint).toContain(PLUGIN_VERSION_CURRENT);
    });

    test("includes the hub URL and curl install command", () => {
      const hint = buildUpgradeHint("http://hub.test:4815", "0.0.1");
      expect(hint).toContain("http://hub.test:4815/setup");
      expect(hint).toContain("curl -fsSL");
      expect(hint).toContain("bash");
    });

    test("uses 'unknown' when observedVersion is undefined", () => {
      const hint = buildUpgradeHint("http://hub.test:4815", undefined);
      expect(hint).toContain("unknown");
      expect(hint).toContain(PLUGIN_VERSION_CURRENT);
    });

    test("uses 'unknown' when observedVersion is an empty string", () => {
      const hint = buildUpgradeHint("http://hub.test:4815", "");
      expect(hint).toContain("unknown");
    });

    test("uses 'unknown' when observedVersion is null", () => {
      const hint = buildUpgradeHint("http://hub.test:4815", null);
      expect(hint).toContain("unknown");
    });

    test("stays under 300 chars to avoid bloating tool results", () => {
      // FR8 Risks: the nudge rides on every tool result until fired; a
      // too-wordy hint wastes context. 300 is the cap the phase file sets.
      const hint = buildUpgradeHint(
        "http://some-reasonably-named-hub.example.com:4815",
        "0.0.1-rc.4",
      );
      expect(hint.length).toBeLessThan(300);
    });

    test("uses the hub URL verbatim (no trailing slash munging)", () => {
      // buildUpgradeHint is a pure text-builder; the caller is
      // responsible for passing in the desired URL form. The
      // `/setup` suffix is appended here.
      const hint = buildUpgradeHint("http://localhost:4815", "0.0.1");
      expect(hint).toContain("http://localhost:4815/setup");
    });
  });
});
