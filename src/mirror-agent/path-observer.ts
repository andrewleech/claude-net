// Per-session file-path allowlist for the dashboard's on-demand file
// fetch. The mirror-agent is the only component with filesystem access to
// the paths a session references, so it — not the hub — decides what may
// be read and streamed back.
//
// The gate (see the "Read gate" decision) is:
//   observed paths ∪ files under the session cwd ∪ files under any observed
//   file's directory.
// "Observed" means a path the mirror-agent has actually seen flow through
// this session's event stream — in a structured tool field OR in prose
// (an assistant/user message that names a path). This deliberately makes
// any path *mentioned in the session* fetchable, which is the whole point
// of "show a file path given in a text response"; it also means a message
// that names, say, /etc/shadow makes that path fetchable. The mitigation
// versus a truly-arbitrary read is exactly that constraint: the path must
// have surfaced in this session, or live in its working tree.
//
// containsAllowed() resolves symlinks/`..` before the containment check so
// a crafted request (e.g. an observed dir holding a symlink to /) can't
// escape the allowed roots.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Cap the number of remembered paths/dirs so a long session with many file
// references can't grow these sets without bound. Oldest entries are not
// evicted — we simply stop recording once full; the cwd fallback still
// covers the common case.
export const MAX_OBSERVED_PATHS = 5000;
export const MAX_OBSERVED_DIRS = 2000;

// Matches absolute POSIX paths and ~-rooted paths embedded in arbitrary
// text or JSON. Intentionally broad on the character class (paths in this
// codebase carry dots, dashes, @, +) but anchored to a leading `/` or
// `~/` and required to have at least one more segment, so bare "/" and
// lone slashes don't match. Trailing punctuation (., ,, ), etc.) is
// trimmed by the caller.
// The (?<![\w~]) lookbehind keeps "/4" in "3/4" and "b" in "a/b" from
// matching — a path must start at a boundary, not mid-token.
const PATH_RE = /(?<![\w~])(?:~|(?=\/))(?:\/[\w.+@\-]+)+/g;

/** Extract candidate absolute paths from a blob of text or stringified
 *  JSON. `~`-rooted paths are expanded to the home directory. Returned
 *  paths are normalized (no `.`/`..` segments) but NOT symlink-resolved
 *  and NOT checked for existence — that happens at fetch time. */
export function extractPaths(text: string): string[] {
  if (!text) return [];
  const home = os.homedir();
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = text.match(PATH_RE);
  if (!matches) return out;
  for (const raw of matches) {
    let p = raw;
    // Trim trailing punctuation that commonly abuts a path in prose.
    p = p.replace(/[.,;:)\]}'"]+$/, "");
    if (p.startsWith("~")) p = path.join(home, p.slice(1));
    if (!path.isAbsolute(p)) continue;
    const norm = path.normalize(p);
    // Require a real path (more than just "/") with a segment.
    if (norm === "/" || norm.length < 2) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * The observed-path allowlist for one session. Records paths seen in the
 * event stream and the session cwd, then answers the gate question for a
 * fetch request.
 */
export class PathObserver {
  private readonly paths = new Set<string>();
  private readonly dirs = new Set<string>();
  private cwd: string | null = null;

  constructor(cwd?: string | null) {
    if (cwd) this.setCwd(cwd);
  }

  setCwd(cwd: string): void {
    if (!cwd || !path.isAbsolute(cwd)) return;
    this.cwd = path.normalize(cwd);
  }

  /** Record every path found in a blob of text/JSON. */
  observeText(text: string): void {
    for (const p of extractPaths(text)) this.add(p);
  }

  private add(p: string): void {
    if (this.paths.size < MAX_OBSERVED_PATHS) this.paths.add(p);
    // Only a path's directory that passes the safe-root test becomes a
    // same-tree root. Without this, observing a single-segment path like
    // "/tmp" or "/etc" (ubiquitous in tool output) would record dirname
    // "/" as a root, and isWithin("/", …) matches every absolute path —
    // turning the fallback into a whole-filesystem read. The safe-root
    // floor also keeps shallow shared dirs (/etc, the home dir itself)
    // from exposing their entire contents just because one file in them
    // was mentioned. Such a file stays fetchable via the exact-path check.
    const dir = path.dirname(p);
    if (isSafeRoot(dir) && this.dirs.size < MAX_OBSERVED_DIRS) {
      this.dirs.add(dir);
    }
  }

  /**
   * Decide whether `requestPath` may be read for this session. Returns the
   * symlink-resolved real path on success (the caller reads that), or null
   * if the request is refused or the file is missing / not a regular file.
   */
  resolveAllowed(requestPath: string): string | null {
    if (!requestPath || !path.isAbsolute(requestPath)) return null;

    // Resolve the request and every allowed root through the filesystem so
    // symlinks and `..` can't be used to escape. If the target doesn't
    // exist, realpathSync throws → refuse.
    let real: string;
    try {
      real = fs.realpathSync(requestPath);
    } catch {
      return null;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;

    // Exact observed path (compare on the resolved form of the observed
    // entry too, so /a/link/f and /a/real/f unify).
    for (const p of this.paths) {
      if (realpathOrNull(p) === real) return real;
    }

    // Same-tree fallback: under the cwd or an observed directory. Every
    // root is re-checked with isSafeRoot here (not just at record time) so
    // the cwd is held to the same floor — a shallow cwd like "/" or the
    // home dir never enables a whole-tree read.
    const roots: string[] = [];
    if (this.cwd && isSafeRoot(this.cwd)) roots.push(this.cwd);
    for (const d of this.dirs) roots.push(d);
    for (const root of roots) {
      const realRoot = realpathOrNull(root);
      if (realRoot && isSafeRoot(realRoot) && isWithin(realRoot, real))
        return real;
    }
    return null;
  }

  /** Test/diagnostic accessors. */
  get size(): number {
    return this.paths.size;
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// A directory is usable as a same-tree root only if it is specific enough
// that granting read of its whole subtree is not a blanket filesystem
// grant. Rejects "/", the home directory and its ancestors, and any path
// with fewer than three segments (so "/etc", "/home/user", "/usr/lib" are
// out while "/home/user/project" and deeper are in). This is the safety
// floor for the same-tree fallback; exact observed paths bypass it, so a
// specifically-referenced file in a shallow directory is still fetchable.
const MIN_ROOT_SEGMENTS = 3;
function isSafeRoot(dir: string): boolean {
  if (!dir || !path.isAbsolute(dir)) return false;
  const norm = path.normalize(dir);
  if (norm === "/") return false;
  const home = os.homedir();
  if (norm === home) return false;
  const segs = norm.split(path.sep).filter((s) => s.length > 0);
  if (segs.length < MIN_ROOT_SEGMENTS) return false;
  return true;
}

/** True if `child` is `root` itself or lives beneath it. Both must already
 *  be real (symlink-resolved) absolute paths. */
function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(rootWithSep);
}
