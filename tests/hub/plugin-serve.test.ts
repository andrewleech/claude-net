// Mirrors the /plugin.ts route in src/hub/index.ts: the hub serves a
// self-contained bundle (built lazily via ensureBundleBuilt against the
// repo's bun.lock-pinned node_modules), NOT the bare plugin source. Serving
// the bare .ts left dependency resolution to each client's bun auto-install,
// where floating versions once paired SDK 1.29.0 with an incompatible zod
// and killed the MCP server at startup.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureBundleBuilt } from "@/hub/bin-server";
import { Elysia } from "elysia";

describe("Plugin file serving", () => {
  let app: Elysia;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    const repoRoot = `${import.meta.dir}/../..`;
    const pluginBundleRel = "bin/plugin.bundle.js";
    const pluginPath = `${repoRoot}/${pluginBundleRel}`;

    let pluginCache: string | null = null;

    app = new Elysia().get("/plugin.ts", async ({ set }) => {
      if (!pluginCache) {
        if (
          !ensureBundleBuilt(repoRoot, "src/plugin/plugin.ts", pluginBundleRel)
        ) {
          set.status = 500;
          return "plugin bundle build failed";
        }
        const file = Bun.file(pluginPath);
        pluginCache = await file.text();
      }
      set.headers["content-type"] = "text/typescript";
      return pluginCache;
    });

    app.listen(0);
    port = app.server?.port ?? 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    app.stop();
  });

  test("GET /plugin.ts returns the bundled plugin", async () => {
    const resp = await fetch(`${baseUrl}/plugin.ts`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body.length).toBeGreaterThan(0);
    // Plugin code is actually in there.
    expect(body).toContain("CLAUDE_NET_HUB");
  });

  test("served plugin is self-contained (no floating npm imports)", async () => {
    const resp = await fetch(`${baseUrl}/plugin.ts`);
    const body = await resp.text();
    // The SDK and its transitive zod must be inlined by the bundler — a bare
    // import here would put the client back on bun auto-install's floating
    // resolution. ("ws" is exempt: Bun resolves it to its built-in shim, no
    // npm fetch involved.)
    expect(body).not.toContain('from "@modelcontextprotocol');
    expect(body).not.toContain('require("@modelcontextprotocol');
    expect(body).not.toContain('from "zod');
    expect(body).not.toContain('require("zod');
  });

  test("GET /plugin.ts has typescript content type", async () => {
    const resp = await fetch(`${baseUrl}/plugin.ts`);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/typescript");
  });
});
