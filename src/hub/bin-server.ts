// Serves the launcher + mirror binaries from `bin/` so a fresh host can
// bootstrap entirely from the hub via `curl <hub>/setup | bash` — no
// access to a git remote required. The mirror-agent JS bundle is built
// lazily on first request (bun build is cheap — ~10ms — so this avoids
// adding a build step to plain `bun run dev`).
//
// The file set is whitelisted: we never serve arbitrary paths from bin/.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { Elysia } from "elysia";

export interface BinServerDeps {
  /** Absolute path to the repo root (parent of src/ and bin/). */
  repoRoot: string;
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
  "patch-binary.py": {
    rel: "bin/patch-binary.py",
    contentType: "text/x-python",
  },
  "install-channels": {
    rel: "bin/install-channels",
    contentType: "text/x-shellscript",
  },
  "mirror-agent.bundle.js": {
    rel: "bin/mirror-agent.bundle.js",
    contentType: "application/javascript",
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
function ensureBundleBuilt(repoRoot: string): boolean {
  if (bundleBuilt) return true;
  const source = path.join(repoRoot, BUNDLE_SOURCE_REL);
  const dest = path.join(repoRoot, BUNDLE_DEST_REL);
  const result = spawnSync(
    "bun",
    ["build", "--target=bun", source, "--outfile", dest],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (result.status === 0) {
    bundleBuilt = true;
    return true;
  }
  process.stderr.write(
    `[claude-net] mirror-agent bundle build failed: ${result.stderr ?? result.stdout}\n`,
  );
  return false;
}

export function binServerPlugin(deps: BinServerDeps): Elysia {
  const { repoRoot } = deps;

  return new Elysia().get("/bin/:name", async ({ params, set }) => {
    const asset = ASSETS[params.name];
    if (!asset) {
      set.status = 404;
      return "not found";
    }

    // Lazy-build the JS bundle on first request.
    if (params.name === "mirror-agent.bundle.js") {
      if (!ensureBundleBuilt(repoRoot)) {
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
  });
}

/** Exported for tests. */
export const BIN_ASSET_NAMES = Object.keys(ASSETS);
