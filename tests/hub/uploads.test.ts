import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MirrorRegistry } from "@/hub/mirror";
import { UploadsRegistry, uploadsPlugin } from "@/hub/uploads";

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cn-uploads-"));
}

function makeRegistry(root: string, ttlMs = 60_000): UploadsRegistry {
  // Disable the sweep timer from running on its own in tests; we'll call
  // sweep() by hand when we want it.
  return new UploadsRegistry({ root, ttlMs, sweepIntervalMs: 0 });
}

describe("UploadsRegistry.store", () => {
  let dir: string;
  let reg: UploadsRegistry;
  beforeEach(() => {
    dir = mkDir();
    reg = makeRegistry(dir);
  });
  afterEach(() => {
    reg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes file to <root>/<sid>/<uuid>.<ext> and returns the stored name", async () => {
    const file = new File(["hello"], "greet.txt", { type: "text/plain" });
    const out = await reg.store("abc-123", file);
    expect(out.bytes).toBe(5);
    expect(out.ext).toBe("txt");
    expect(out.name).toMatch(/^[0-9a-f-]+\.txt$/);
    const onDisk = path.join(dir, "abc-123", out.name);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, "utf8")).toBe("hello");
  });

  test("no extension is preserved as empty ext", async () => {
    const file = new File(["x"], "LICENSE");
    const out = await reg.store("s1", file);
    expect(out.ext).toBe("");
    expect(out.name).toMatch(/^[0-9a-f-]+$/);
  });

  test("rewrites script-executable extensions to .bin", async () => {
    // html, svg, js, ts, css — anything that could execute from our
    // origin if a browser rendered it inline.
    for (const unsafe of ["html", "svg", "js", "ts", "css", "exe", "sh"]) {
      const out = await reg.store("s-bin", new File(["x"], `file.${unsafe}`));
      expect(out.ext).toBe("bin");
      expect(out.name).toMatch(/^[0-9a-f-]+\.bin$/);
    }
  });

  test("keeps inline-safe extensions as-is", async () => {
    for (const safe of ["png", "jpg", "pdf", "md", "json"]) {
      const out = await reg.store("s-safe", new File(["x"], `f.${safe}`));
      expect(out.ext).toBe(safe);
    }
  });

  test("rejects sid that would escape the root", async () => {
    const file = new File(["x"], "a.txt");
    await expect(reg.store("../escape", file)).rejects.toThrow();
  });
});

describe("UploadsRegistry.purgeSession", () => {
  test("removes session directory", async () => {
    const dir = mkDir();
    const reg = makeRegistry(dir);
    try {
      await reg.store("sid-1", new File(["a"], "a.txt"));
      await reg.store("sid-1", new File(["b"], "b.txt"));
      expect(fs.existsSync(path.join(dir, "sid-1"))).toBe(true);
      await reg.purgeSession("sid-1");
      expect(fs.existsSync(path.join(dir, "sid-1"))).toBe(false);
    } finally {
      reg.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is safe to call on unknown sid", async () => {
    const dir = mkDir();
    const reg = makeRegistry(dir);
    try {
      await reg.purgeSession("nope");
    } finally {
      reg.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("UploadsRegistry.sweep", () => {
  test("removes files older than ttlMs and empties their dirs", async () => {
    const dir = mkDir();
    const reg = makeRegistry(dir, 1_000);
    try {
      await reg.store("old-sid", new File(["x"], "x.txt"));
      await reg.store("fresh-sid", new File(["y"], "y.txt"));
      // Backdate "old-sid"'s file by two seconds so the 1 s TTL trips.
      const oldFiles = fs.readdirSync(path.join(dir, "old-sid"));
      const old = path.join(dir, "old-sid", oldFiles[0] ?? "");
      const past = Date.now() / 1000 - 2;
      fs.utimesSync(old, past, past);

      await reg.sweep();

      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(path.join(dir, "old-sid"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "fresh-sid"))).toBe(true);
    } finally {
      reg.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("survives a missing root", async () => {
    const dir = path.join(os.tmpdir(), `cn-uploads-missing-${Date.now()}`);
    const reg = makeRegistry(dir);
    try {
      await reg.sweep(); // should not throw
    } finally {
      reg.stop();
    }
  });
});

// ── Plugin integration ────────────────────────────────────────────────────

async function buildApp(root: string) {
  const mirror = new MirrorRegistry({ orphanCloseMs: 0 });
  const uploads = new UploadsRegistry({
    root,
    ttlMs: 60_000,
    sweepIntervalMs: 0,
  });
  const { Elysia } = await import("elysia");
  const app = new Elysia().use(
    uploadsPlugin({
      mirrorRegistry: mirror,
      uploadsRegistry: uploads,
      externalHost: "http://localhost:4815",
    }),
  );
  return { app, mirror, uploads };
}

describe("uploadsPlugin", () => {
  test("POST /api/mirror/:sid/upload stores file and returns URL", async () => {
    const dir = mkDir();
    const { app, mirror, uploads } = await buildApp(dir);
    try {
      const created = mirror.createSession("owner", "/tmp", "sid-upload-1");
      expect(created.ok).toBe(true);

      const fd = new FormData();
      fd.append("file", new File(["hello"], "pic.png", { type: "image/png" }));
      const res = await app.handle(
        new Request("http://localhost:4815/api/mirror/sid-upload-1/upload", {
          method: "POST",
          body: fd,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        url: string;
        name: string;
        stored: string;
        bytes: number;
      };
      expect(body.name).toBe("pic.png");
      expect(body.bytes).toBe(5);
      expect(body.url).toMatch(
        /^http:\/\/localhost:4815\/uploads\/sid-upload-1\/[0-9a-f-]+\.png$/,
      );
      expect(body.stored).toMatch(/^[0-9a-f-]+\.png$/);
    } finally {
      mirror.stop();
      uploads.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("POST rejects when session is unknown", async () => {
    const dir = mkDir();
    const { app, mirror, uploads } = await buildApp(dir);
    try {
      const fd = new FormData();
      fd.append("file", new File(["x"], "x.txt"));
      const res = await app.handle(
        new Request("http://localhost:4815/api/mirror/unknown-sid/upload", {
          method: "POST",
          body: fd,
        }),
      );
      expect(res.status).toBe(404);
    } finally {
      mirror.stop();
      uploads.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GET /uploads/:sid/:name serves the file via @elysiajs/static", async () => {
    const dir = mkDir();
    const { app, mirror, uploads } = await buildApp(dir);
    try {
      mirror.createSession("owner", "/tmp", "sid-upload-2");
      const stored = await uploads.store(
        "sid-upload-2",
        new File(["hello-bytes"], "note.txt", { type: "text/plain" }),
      );
      const res = await app.handle(
        new Request(
          `http://localhost:4815/uploads/sid-upload-2/${stored.name}`,
          { method: "GET" },
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-bytes");
    } finally {
      mirror.stop();
      uploads.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GET 404s on unknown path and rejects traversal", async () => {
    const dir = mkDir();
    const { app, mirror, uploads } = await buildApp(dir);
    try {
      // Missing file under a legit-looking session dir.
      const res1 = await app.handle(
        new Request("http://localhost:4815/uploads/abc-123/missing.png", {
          method: "GET",
        }),
      );
      expect(res1.status).toBe(404);

      // Plant a secret beside the uploads root and confirm that a
      // traversal URL doesn't reach it (the static plugin's resolve
      // guard catches both encoded and raw `..`).
      const sibling = path.join(path.dirname(dir), "secret");
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(sibling, "passwd"), "TOPSECRET");
      try {
        const res2 = await app.handle(
          new Request(
            `http://localhost:4815/uploads/..%2F${path.basename(sibling)}%2Fpasswd`,
            { method: "GET" },
          ),
        );
        expect(res2.status).toBe(404);
      } finally {
        fs.rmSync(sibling, { recursive: true, force: true });
      }
    } finally {
      mirror.stop();
      uploads.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closing a session via MirrorRegistry.closeSession triggers purgeSession", async () => {
    const dir = mkDir();
    const { mirror, uploads } = await buildApp(dir);
    try {
      mirror.createSession("owner", "/tmp", "sid-to-close");
      await uploads.store("sid-to-close", new File(["x"], "x.txt"));
      expect(fs.existsSync(path.join(dir, "sid-to-close"))).toBe(true);

      // Wire the hook exactly as index.ts does.
      mirror.onSessionClosed((sid) => {
        uploads.purgeSession(sid).catch(() => {});
      });
      mirror.closeSession("sid-to-close");

      // purgeSession is async; give the microtask a tick.
      await new Promise((r) => setTimeout(r, 20));
      expect(fs.existsSync(path.join(dir, "sid-to-close"))).toBe(false);
    } finally {
      mirror.stop();
      uploads.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
