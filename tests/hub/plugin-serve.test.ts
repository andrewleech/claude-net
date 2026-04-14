import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

describe("Plugin file serving", () => {
  let app: Elysia;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    const pluginPath = `${import.meta.dir}/../../src/plugin/plugin.ts`;

    let pluginCache: string | null = null;

    app = new Elysia().get("/plugin.ts", async ({ set }) => {
      if (!pluginCache) {
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

  test("GET /plugin.ts returns plugin source", async () => {
    const resp = await fetch(`${baseUrl}/plugin.ts`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("@modelcontextprotocol/sdk");
  });

  test("GET /plugin.ts has typescript content type", async () => {
    const resp = await fetch(`${baseUrl}/plugin.ts`);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/typescript");
  });
});
