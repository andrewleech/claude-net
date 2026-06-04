import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { binServerPlugin, substituteBuildHash } from "@/hub/bin-server";
import { Elysia } from "elysia";

describe("bin-server /bin/:name", () => {
  let app: Elysia;
  let baseUrl: string;
  const repoRoot = path.resolve(import.meta.dir, "../..");

  beforeAll(() => {
    app = new Elysia().use(binServerPlugin({ repoRoot }));
    app.listen(0);
    baseUrl = `http://localhost:${app.server?.port}`;
  });

  afterAll(() => {
    app.stop();
  });

  test("serves claude-channels script", async () => {
    const r = await fetch(`${baseUrl}/bin/claude-channels`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("shellscript");
    const body = await r.text();
    expect(body).toContain("#!/bin/bash");
  });

  test("serves claude-net-mirror-push", async () => {
    const r = await fetch(`${baseUrl}/bin/claude-net-mirror-push`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("/hook");
  });

  test("builds + serves the mirror-agent bundle lazily", async () => {
    const r = await fetch(`${baseUrl}/bin/mirror-agent.bundle.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    const body = await r.text();
    // Bundle should include unique strings from the mirror-agent source.
    expect(body).toContain("mirror-agent");
    expect(body.length).toBeGreaterThan(1000);
  });

  test("unknown asset returns 404", async () => {
    const r = await fetch(`${baseUrl}/bin/definitely-not-a-thing`);
    expect(r.status).toBe(404);
  });

  test("path traversal attempts are rejected by the whitelist", async () => {
    // Any unlisted name → 404, regardless of shape. Elysia will URL-decode,
    // but the asset name must match a whitelist key exactly.
    const r1 = await fetch(`${baseUrl}/bin/..%2fpackage.json`);
    expect(r1.status).toBe(404);
  });

  describe("/docs/:name", () => {
    test("serves a .md file from docs/ with text/markdown content-type", async () => {
      const r = await fetch(`${baseUrl}/docs/SELF_INJECT.md`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/markdown");
      const body = await r.text();
      expect(body.length).toBeGreaterThan(0);
    });

    test("404 for non-markdown extensions", async () => {
      const r = await fetch(`${baseUrl}/docs/SELF_INJECT.txt`);
      expect(r.status).toBe(404);
    });

    test("404 for path traversal attempts", async () => {
      const r = await fetch(`${baseUrl}/docs/..%2fpackage.json`);
      expect(r.status).toBe(404);
    });

    test("404 for a non-existent .md filename", async () => {
      const r = await fetch(`${baseUrl}/docs/NOPE.md`);
      expect(r.status).toBe(404);
    });
  });
});

describe("substituteBuildHash", () => {
  // Regression guard for the silently-broken self-update bug. An earlier
  // version of bin-server used bundle.replaceAll("__MIRROR_BUILD_HASH__", x),
  // which clobbered BOTH the MIRROR_BUILD_HASH constant AND the dev-mode-
  // skip guard's literal. With both replaced to the same hash, the runtime
  // check `localVersion !== "<hash>"` became permanently false (because
  // localVersion equals that same hash), and onVersionMismatch never fired
  // for any built bundle.
  test("replaces the MIRROR_BUILD_HASH constant assignment", () => {
    const input = `const MIRROR_BUILD_HASH = "__MIRROR_BUILD_HASH__";`;
    const out = substituteBuildHash(input, "deadbeef");
    expect(out).toContain('MIRROR_BUILD_HASH = "deadbeef"');
    expect(out).not.toContain('"__MIRROR_BUILD_HASH__"');
  });

  test("leaves the dev-mode-skip guard's literal placeholder intact", () => {
    // Realistic bundle excerpt: agent.ts's constant + host-channel.ts's guard
    // both end up in the same bundle. Only the constant should be substituted.
    const input = `
      const MIRROR_BUILD_HASH = "__MIRROR_BUILD_HASH__";
      // ... later in host-channel.ts ...
      if (opts.localVersion && opts.localVersion !== "__MIRROR_BUILD_HASH__" && opts.localVersion !== hubVersion) {
        opts.onVersionMismatch?.(hubVersion);
      }
    `;
    const out = substituteBuildHash(input, "1e2881f");
    expect(out).toMatch(/MIRROR_BUILD_HASH\s*=\s*"1e2881f"/);
    expect(out).toContain('opts.localVersion !== "__MIRROR_BUILD_HASH__"');
  });

  test("no-op when the constant assignment is absent", () => {
    // Defensive: if the bundle structure changes upstream (Bun renames the
    // constant, for example), substitution returns the input unchanged
    // rather than silently writing a mangled file.
    const input = `const Other = "__MIRROR_BUILD_HASH__";`;
    const out = substituteBuildHash(input, "abc1234");
    expect(out).toBe(input);
  });

  test("only replaces ONCE — multiple constants would be a structural error", () => {
    // String.replace (not replaceAll) by design: the constant should appear
    // exactly once in any built bundle. If it ever appears twice, that's a
    // bug upstream and we'd rather leave it visible than silently double-write.
    const input = `
      const MIRROR_BUILD_HASH = "__MIRROR_BUILD_HASH__";
      const MIRROR_BUILD_HASH = "__MIRROR_BUILD_HASH__";
    `;
    const out = substituteBuildHash(input, "xyz");
    const matches = out.match(/MIRROR_BUILD_HASH\s*=\s*"xyz"/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
