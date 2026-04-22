import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { binServerPlugin } from "@/hub/bin-server";
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
});
