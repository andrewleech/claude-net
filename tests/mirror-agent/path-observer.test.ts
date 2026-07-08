import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PathObserver, extractPaths } from "@/mirror-agent/path-observer";

// Real files on disk are required because the gate resolves symlinks and
// checks existence. Build a throwaway tree under the OS temp dir.
let root: string;
let observedFile: string;
let siblingFile: string;
let cwdDir: string;
let cwdFile: string;
let outsideFile: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-pathobs-"));
  const assets = path.join(root, "project", "assets");
  fs.mkdirSync(assets, { recursive: true });
  observedFile = path.join(assets, "concept-1.png");
  siblingFile = path.join(assets, "concept-2.png");
  fs.writeFileSync(observedFile, "png-1");
  fs.writeFileSync(siblingFile, "png-2");

  cwdDir = path.join(root, "project");
  cwdFile = path.join(cwdDir, "notes.md");
  fs.writeFileSync(cwdFile, "notes");

  outsideFile = path.join(root, "secret.key");
  fs.writeFileSync(outsideFile, "secret");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("extractPaths", () => {
  test("pulls absolute paths out of prose", () => {
    const got = extractPaths(
      "I saved it to /home/anl/tokens/assets/slide8.png for you.",
    );
    expect(got).toContain("/home/anl/tokens/assets/slide8.png");
  });

  test("trims trailing punctuation", () => {
    const got = extractPaths("see /a/b/c.txt, and /d/e/f.png).");
    expect(got).toContain("/a/b/c.txt");
    expect(got).toContain("/d/e/f.png");
  });

  test("expands ~ to home", () => {
    const got = extractPaths("cat ~/notes/todo.md");
    expect(got).toContain(path.join(os.homedir(), "notes/todo.md"));
  });

  test("ignores bare slashes and non-paths", () => {
    const got = extractPaths("either/or ratio 3/4 and just /");
    expect(got).not.toContain("/");
  });

  test("finds paths inside JSON blobs", () => {
    const blob = JSON.stringify({ file_path: "/x/y/z.ts", other: 1 });
    expect(extractPaths(blob)).toContain("/x/y/z.ts");
  });
});

describe("PathObserver gate", () => {
  test("allows an exactly-observed file", () => {
    const obs = new PathObserver();
    obs.observeText(`generated ${observedFile}`);
    expect(obs.resolveAllowed(observedFile)).toBe(
      fs.realpathSync(observedFile),
    );
  });

  test("allows a sibling in an observed file's directory (same-tree)", () => {
    const obs = new PathObserver();
    obs.observeText(`generated ${observedFile}`);
    // siblingFile was never mentioned, but lives beside an observed file.
    expect(obs.resolveAllowed(siblingFile)).toBe(fs.realpathSync(siblingFile));
  });

  test("allows a file under the session cwd", () => {
    const obs = new PathObserver(cwdDir);
    expect(obs.resolveAllowed(cwdFile)).toBe(fs.realpathSync(cwdFile));
  });

  test("refuses a path never observed and outside all allowed roots", () => {
    const obs = new PathObserver(cwdDir);
    obs.observeText(`generated ${observedFile}`);
    expect(obs.resolveAllowed(outsideFile)).toBeNull();
  });

  test("refuses a nonexistent path even if it was observed", () => {
    const ghost = path.join(cwdDir, "assets", "does-not-exist.png");
    const obs = new PathObserver();
    obs.observeText(`generated ${ghost}`);
    expect(obs.resolveAllowed(ghost)).toBeNull();
  });

  test("refuses a directory (only regular files are fetchable)", () => {
    const obs = new PathObserver(cwdDir);
    expect(obs.resolveAllowed(cwdDir)).toBeNull();
  });

  test("refuses a relative path", () => {
    const obs = new PathObserver(cwdDir);
    expect(obs.resolveAllowed("assets/concept-1.png")).toBeNull();
  });

  test("observing a single-segment path does NOT open the whole filesystem", () => {
    // Regression: dirname("/tmp") === "/", which as a root matched every
    // absolute path via isWithin("/", …). A shallow observation must not
    // grant reads outside the session's own tree.
    const obs = new PathObserver(cwdDir);
    obs.observeText("touched /tmp and /etc and /usr today");
    expect(obs.resolveAllowed(outsideFile)).toBeNull();
  });

  test("observing a file in the home dir does not expose sibling home files", () => {
    // dirname of a home-level file is the home dir itself — a shallow,
    // sensitive root. Only the exact observed file may be fetched, not
    // its neighbours (e.g. an SSH key).
    const home = os.homedir();
    const mentioned = path.join(home, "some-mentioned-file");
    const neighbour = path.join(home, ".bashrc");
    const obs = new PathObserver(cwdDir);
    obs.observeText(`see ${mentioned}`);
    // Even if the neighbour exists on the test machine, it must be refused
    // because the home dir is not a safe same-tree root.
    expect(obs.resolveAllowed(neighbour)).toBeNull();
  });

  test("an exactly-observed shallow file is still fetchable", () => {
    // The safety floor applies to the same-tree fallback, not to exact
    // matches: a file explicitly referenced in the session may be read
    // even if it lives in a shallow/sensitive directory.
    const shallow = path.join(root, "secret.key"); // 2-segment dir (root)
    const obs = new PathObserver(cwdDir);
    obs.observeText(`the key is at ${shallow}`);
    expect(obs.resolveAllowed(shallow)).toBe(fs.realpathSync(shallow));
  });

  test("a symlink escaping the allowed tree cannot reach an outside file", () => {
    // Place a symlink inside the observed dir pointing at the outside
    // secret. Requesting the symlink resolves to the outside real path,
    // which is not within any allowed root → refused.
    const link = path.join(cwdDir, "assets", "escape-link");
    try {
      fs.symlinkSync(outsideFile, link);
    } catch {
      return; // symlinks unsupported on this fs; skip
    }
    const obs = new PathObserver(cwdDir);
    obs.observeText(`generated ${observedFile}`);
    expect(obs.resolveAllowed(link)).toBeNull();
    fs.rmSync(link, { force: true });
  });
});
