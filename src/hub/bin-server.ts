// Serves the launcher + mirror binaries from `bin/` so a fresh host can
// bootstrap entirely from the hub via `curl <hub>/setup | bash` — no
// access to a git remote required. The mirror-agent JS bundle is built
// lazily on first request (bun build is cheap — ~10ms — so this avoids
// adding a build step to plain `bun run dev`).
//
// The file set is whitelisted: we never serve arbitrary paths from bin/.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";

export interface BinServerDeps {
  /** Absolute path to the repo root (parent of src/ and bin/). */
  repoRoot: string;
  /**
   * Hub commit hash injected into the bundle as __MIRROR_BUILD_HASH__ so the
   * mirror-agent can detect version skew against the hub it connects to.
   */
  commitHash?: string;
}

/** Filename → (path on disk, content-type, executable-ish?) */
const ASSETS: Record<string, { rel: string; contentType: string }> = {
  "claude-channels": {
    rel: "bin/claude-channels",
    contentType: "text/x-shellscript",
  },
  "claude-net-mirror-push": {
    rel: "bin/claude-net-mirror-push",
    contentType: "text/typescript",
  },
  "claude-net-mirror-agent": {
    rel: "bin/claude-net-mirror-agent",
    contentType: "text/x-shellscript",
  },
  "install-channels": {
    rel: "bin/install-channels",
    contentType: "text/x-shellscript",
  },
  "mirror-agent.bundle.js": {
    rel: "bin/mirror-agent.bundle.js",
    contentType: "application/javascript",
  },
  "statusline.py": {
    rel: "bin/statusline.py",
    contentType: "text/x-python",
  },
  // Vendored third-party bundles for the dashboard. Served alongside our
  // own scripts from the same /bin/* route so browsers hit a single origin.
  "marked.umd.min.js": {
    rel: "bin/marked.umd.min.js",
    contentType: "application/javascript",
  },
  "purify.min.js": {
    rel: "bin/purify.min.js",
    contentType: "application/javascript",
  },
  "diff.min.js": {
    rel: "bin/diff.min.js",
    contentType: "application/javascript",
  },
  "bootstrap.min.css": {
    rel: "bin/bootstrap.min.css",
    contentType: "text/css",
  },
  "bootstrap.bundle.min.js": {
    rel: "bin/bootstrap.bundle.min.js",
    contentType: "application/javascript",
  },
};

const BUNDLE_SOURCE_REL = "src/mirror-agent/agent.ts";
const BUNDLE_DEST_REL = "bin/mirror-agent.bundle.js";

let bundleBuilt = false;

/**
 * Ensure the mirror-agent bundle exists at bin/mirror-agent.bundle.js. Runs
 * `bun build` once per process. If bun isn't on PATH (should never happen
 * in the hub container), logs and returns false.
 */
function ensureBundleBuilt(repoRoot: string, commitHash?: string): boolean {
  if (bundleBuilt) return true;
  const source = path.join(repoRoot, BUNDLE_SOURCE_REL);
  const dest = path.join(repoRoot, BUNDLE_DEST_REL);
  const result = spawnSync(
    "bun",
    ["build", "--target=bun", source, "--outfile", dest],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(
      `[claude-net] mirror-agent bundle build failed: ${result.stderr ?? result.stdout}\n`,
    );
    return false;
  }
  if (commitHash) {
    const bundle = readFileSync(dest, "utf8");
    writeFileSync(dest, substituteBuildHash(bundle, commitHash));
  }
  bundleBuilt = true;
  return true;
}

/**
 * Substitute the build hash into a mirror-agent bundle. The placeholder
 * `__MIRROR_BUILD_HASH__` appears in BOTH agent.ts (the MIRROR_BUILD_HASH
 * constant) AND host-channel.ts (the dev-mode-skip guard inside
 * onVersionMismatch). Surgical substitution: only replace the assignment
 * in agent.ts.
 *
 * The skip guard's literal MUST stay intact so the runtime check
 * `localVersion !== "__MIRROR_BUILD_HASH__"` can fire — in a built bundle,
 * localVersion gets the real commit hash via the substituted constant,
 * so the check is true and onVersionMismatch fires when
 * localVersion !== hubVersion (i.e. the bundle is out of date).
 *
 * An earlier version of this code used `bundle.replaceAll(...)`, which
 * clobbered both occurrences and left the guard as
 * `localVersion !== "<commit>"` — permanently false because localVersion
 * equals that same commit. Net effect: silently disabled self-update for
 * every bundle built after the version-check landed in 62eb27d.
 */
export function substituteBuildHash(
  bundle: string,
  commitHash: string,
): string {
  const assignment = /MIRROR_BUILD_HASH\s*=\s*"__MIRROR_BUILD_HASH__"/;
  if (!assignment.test(bundle)) {
    process.stderr.write(
      "[claude-net] bin-server: MIRROR_BUILD_HASH assignment not found in bundle — version check will be inert\n",
    );
  }
  return bundle.replace(assignment, `MIRROR_BUILD_HASH = "${commitHash}"`);
}

export function binServerPlugin(deps: BinServerDeps): Elysia {
  const { repoRoot, commitHash } = deps;

  return (
    new Elysia()
      .get("/bin/:name", async ({ params, set }) => {
        const asset = ASSETS[params.name];
        if (!asset) {
          set.status = 404;
          return "not found";
        }

        // Lazy-build the JS bundle on first request.
        if (params.name === "mirror-agent.bundle.js") {
          if (!ensureBundleBuilt(repoRoot, commitHash)) {
            set.status = 500;
            return "bundle build failed; see hub logs";
          }
        }

        const file = Bun.file(path.join(repoRoot, asset.rel));
        if (!(await file.exists())) {
          set.status = 404;
          return `asset '${params.name}' not present on disk`;
        }
        set.headers["content-type"] = asset.contentType;
        return file;
      })
      // Serve markdown reference docs from docs/*.md. Restricted to flat .md
      // filenames (no path traversal, no nested directories) so an agent
      // anywhere on the tailnet can fetch e.g. /docs/SELF_INJECT.md without
      // accidentally exposing the rest of the repo.
      .get("/docs/:name", async ({ params, set }) => {
        const name = params.name;
        if (!/^[A-Za-z0-9_.-]+\.md$/.test(name)) {
          set.status = 404;
          return "not found";
        }
        const file = Bun.file(path.join(repoRoot, "docs", name));
        if (!(await file.exists())) {
          set.status = 404;
          return `doc '${name}' not present on disk`;
        }
        set.headers["content-type"] = "text/markdown; charset=utf-8";
        return file;
      })
  );
}

/** Exported for tests. */
export const BIN_ASSET_NAMES = Object.keys(ASSETS);
