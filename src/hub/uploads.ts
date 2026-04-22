// File uploads for mirror sessions. The dashboard composer POSTs pasted
// or dropped files here; the hub stores them under `<root>/<sid>/<uuid><ext>`
// and returns a public URL the user (or Claude, when injected) can fetch.
//
// The hub sits on a trusted network, so GET /uploads/:sid/:name is
// unauthenticated. Uploads are session-scoped (POST requires the sid) and
// purged when the session closes + on a 24 h TTL sweep.
//
// GET serving is delegated to `@elysiajs/static`, which handles MIME,
// ETag, Cache-Control and the classic path-traversal guard. We rewrite
// script-executable extensions (html, svg, js, ts, css) to `.bin` at
// upload time so browsers download rather than render them — keeps the
// download surface simple and same-origin-safe.

import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import { resolveCanonicalHubUrl } from "./hub-url";
import type { MirrorRegistry } from "./mirror";
import { RateLimiter } from "./rate-limit";

// ── Config ────────────────────────────────────────────────────────────────

const DEFAULT_ROOT = (() => {
  const envDir = process.env.CLAUDE_NET_UPLOADS_DIR;
  if (envDir) return envDir;
  // ./data/uploads relative to the hub source's grandparent (repo root).
  return path.resolve(import.meta.dir, "..", "..", "data", "uploads");
})();

const MAX_UPLOAD_BYTES = (() => {
  const raw = Number(process.env.CLAUDE_NET_UPLOADS_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 25;
  return mb * 1024 * 1024;
})();

const TTL_MS = (() => {
  const raw = Number(process.env.CLAUDE_NET_UPLOADS_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 24;
  return hours * 60 * 60 * 1000;
})();

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 h

// Per-sid rate limits: burst (one every ~500 ms) + 30 per minute.
const uploadBurstLimiter = new RateLimiter({ max: 1, windowMs: 500 });
const uploadMinuteLimiter = new RateLimiter({ max: 30, windowMs: 60_000 });

// Extensions whose content is fine to render inline in a browser from our
// origin. Everything else (html, svg, js, ts, css, .exe, unknown, …) is
// stored with a `.bin` extension so @elysiajs/static serves it as
// application/octet-stream and the browser downloads rather than
// executes. Claude's WebFetch doesn't care about content-type so URL
// injection keeps working either way.
const INLINE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "mp3",
  "wav",
  "ogg",
  "mp4",
  "webm",
  "mov",
  "pdf",
  "txt",
  "md",
  "json",
  "csv",
  "log",
  "yaml",
  "yml",
  "xml",
]);

function extFromName(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name);
  return m?.[1] ? m[1].toLowerCase() : "";
}

// ── Registry ──────────────────────────────────────────────────────────────

export interface UploadsRegistryOptions {
  root?: string;
  ttlMs?: number;
  sweepIntervalMs?: number;
}

export interface StoredUpload {
  name: string; // on-disk filename, uuid + extension
  bytes: number;
  ext: string; // no leading dot; "" if none
}

export class UploadsRegistry {
  readonly root: string;
  private ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: UploadsRegistryOptions) {
    this.root = options?.root ?? DEFAULT_ROOT;
    this.ttlMs = options?.ttlMs ?? TTL_MS;
    // @elysiajs/static expects the assets dir to exist at mount time.
    try {
      mkdirSync(this.root, { recursive: true });
    } catch {
      // best effort; plugin will 404 if dir really can't be created
    }
    const interval = options?.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    if (this.ttlMs > 0 && interval > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweep().catch(() => {});
      }, interval);
      if (
        this.sweepTimer &&
        typeof this.sweepTimer === "object" &&
        "unref" in this.sweepTimer
      ) {
        this.sweepTimer.unref();
      }
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sidDir(sid: string): string {
    return path.join(this.root, sid);
  }

  async store(sid: string, file: File): Promise<StoredUpload> {
    // Containment check for the write side. The static plugin guards the
    // read side, but since we choose the write target ourselves we have
    // to make sure a hostile sid can't escape the root.
    const dir = path.resolve(this.sidDir(sid));
    const rootResolved = path.resolve(this.root);
    if (!dir.startsWith(rootResolved + path.sep)) {
      throw new Error(`invalid sid: ${sid}`);
    }
    await fs.mkdir(dir, { recursive: true });

    const requested = extFromName(file.name);
    // Rewrite anything we wouldn't want the browser to render inline.
    const ext = INLINE_EXT.has(requested) ? requested : requested ? "bin" : "";
    const id = crypto.randomUUID();
    const storedName = ext ? `${id}.${ext}` : id;
    const filePath = path.join(dir, storedName);
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buf);
    return { name: storedName, bytes: buf.byteLength, ext };
  }

  async purgeSession(sid: string): Promise<void> {
    const dir = path.resolve(this.sidDir(sid));
    const rootResolved = path.resolve(this.root);
    if (!dir.startsWith(rootResolved + path.sep)) return;
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  async sweep(): Promise<void> {
    const cutoff = Date.now() - this.ttlMs;
    let sids: string[];
    try {
      sids = await fs.readdir(this.root);
    } catch {
      return; // root doesn't exist yet
    }
    for (const sid of sids) {
      const dir = this.sidDir(sid);
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      let kept = 0;
      for (const name of entries) {
        const p = path.join(dir, name);
        try {
          const stat = await fs.stat(p);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(p).catch(() => {});
          } else {
            kept++;
          }
        } catch {
          // vanished under us; fine
        }
      }
      if (kept === 0) {
        await fs.rmdir(dir).catch(() => {});
      }
    }
  }
}

// ── Elysia plugin ─────────────────────────────────────────────────────────

export interface UploadsPluginDeps {
  mirrorRegistry: MirrorRegistry;
  uploadsRegistry: UploadsRegistry;
  externalHost?: string;
  port?: number;
}

export function uploadsPlugin(deps: UploadsPluginDeps): Elysia {
  const { mirrorRegistry, uploadsRegistry, externalHost, port } = deps;

  return (
    new Elysia()
      .post("/api/mirror/:sid/upload", async ({ params, request, set }) => {
        const found = mirrorRegistry.getSession(params.sid);
        if (!found.ok) {
          set.status = found.status;
          return { error: found.error };
        }

        const declared = Number(request.headers.get("content-length") || 0);
        if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
          // 64 KB slack for multipart boundaries.
          set.status = 413;
          return {
            error: `Upload exceeds ${MAX_UPLOAD_BYTES} bytes (cap ${Math.floor(
              MAX_UPLOAD_BYTES / (1024 * 1024),
            )} MB).`,
          };
        }

        if (!uploadBurstLimiter.allow(params.sid)) {
          set.status = 429;
          set.headers["retry-after"] = "1";
          return { error: "Rate limit: upload bursts" };
        }
        if (!uploadMinuteLimiter.allow(params.sid)) {
          const waitMs = uploadMinuteLimiter.retryAfterMs(params.sid);
          set.status = 429;
          set.headers["retry-after"] = String(
            Math.max(1, Math.ceil(waitMs / 1000)),
          );
          return { error: "Rate limit: 30 uploads per minute" };
        }

        let file: File | null = null;
        try {
          const fd = await request.formData();
          const v = fd.get("file");
          if (v instanceof File) file = v;
        } catch (err) {
          set.status = 400;
          return { error: `Bad multipart body: ${String(err)}` };
        }
        if (!file) {
          set.status = 400;
          return { error: "Missing 'file' field" };
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          set.status = 413;
          return {
            error: `File exceeds ${MAX_UPLOAD_BYTES} bytes (cap ${Math.floor(
              MAX_UPLOAD_BYTES / (1024 * 1024),
            )} MB).`,
          };
        }

        let stored: StoredUpload;
        try {
          stored = await uploadsRegistry.store(params.sid, file);
        } catch (err) {
          set.status = 500;
          return { error: `Failed to store upload: ${String(err)}` };
        }

        const base = resolveCanonicalHubUrl(request, externalHost, port);
        const url = `${base}/uploads/${encodeURIComponent(
          params.sid,
        )}/${encodeURIComponent(stored.name)}`;
        return {
          url,
          name: file.name,
          stored: stored.name,
          bytes: stored.bytes,
          kind: file.type || null,
        };
      })

      // GET /uploads/** served by the static plugin: handles MIME from
      // Bun.file, ETag, Cache-Control, and traversal guard (verified in
      // tests). `alwaysStatic: false` is required because upload files
      // appear and disappear at runtime; without it the plugin enumerates
      // the directory at startup and never sees new uploads.
      .use(
        staticPlugin({
          assets: uploadsRegistry.root,
          prefix: "/uploads",
          alwaysStatic: false,
          indexHTML: false,
          directive: "private",
          maxAge: 3600,
        }),
      )

      .get("/api/uploads/config", () => ({
        max_mb: Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024)),
        ttl_hours: Math.floor(TTL_MS / (60 * 60 * 1000)),
      }))
  );
}
