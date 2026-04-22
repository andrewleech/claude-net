import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupPlugin } from "@/hub/setup";
import { Elysia } from "elysia";

describe("Setup endpoint", () => {
  let app: Elysia;
  let port: number;
  let baseUrl: string;

  beforeAll(() => {
    // Clear CLAUDE_NET_HOST before tests
    process.env.CLAUDE_NET_HOST = undefined;

    app = new Elysia().use(setupPlugin({ port: 4815 }));
    app.listen(0);
    port = app.server?.port ?? 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    process.env.CLAUDE_NET_HOST = undefined;
    app.stop();
  });

  test("GET /setup without CLAUDE_NET_HOST uses Host header", async () => {
    const resp = await fetch(`${baseUrl}/setup`);
    expect(resp.status).toBe(200);

    const body = await resp.text();
    expect(body).toStartWith("#!/bin/bash");
    // Host header will be localhost:<port>, so script should contain that
    expect(body).toContain(`localhost:${port}`);
    expect(body).toContain("claude mcp add");
  });

  test("GET /setup with CLAUDE_NET_HOST uses env var", async () => {
    process.env.CLAUDE_NET_HOST = "mybox:4815";
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    expect(body).toContain("http://mybox:4815");
    expect(body).toContain("claude mcp add");

    process.env.CLAUDE_NET_HOST = undefined;
  });

  test("GET /setup appends port when CLAUDE_NET_HOST has no port", async () => {
    process.env.CLAUDE_NET_HOST = "mybox.local";
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    expect(body).toContain("http://mybox.local:4815");

    process.env.CLAUDE_NET_HOST = undefined;
  });

  test("GET /setup uses full URL verbatim when CLAUDE_NET_HOST is a URL", async () => {
    process.env.CLAUDE_NET_HOST = "https://localhost:9443";
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    expect(body).toContain('HUB="https://localhost:9443"');
    expect(body).not.toContain("https://localhost:9443:4815");

    process.env.CLAUDE_NET_HOST = undefined;
  });

  test("GET /setup strips trailing slash from full CLAUDE_NET_HOST URL", async () => {
    process.env.CLAUDE_NET_HOST = "https://localhost:9443/";
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    expect(body).toContain('HUB="https://localhost:9443"');

    process.env.CLAUDE_NET_HOST = undefined;
  });

  test("GET /setup ignores X-Forwarded-Host (canonical URL wins)", async () => {
    process.env.CLAUDE_NET_HOST = "http://london:4815";
    const resp = await fetch(`${baseUrl}/setup`, {
      headers: {
        "x-forwarded-host": "public.example",
        "x-forwarded-proto": "https",
      },
    });
    const body = await resp.text();

    // Canonical model: setup always emits CLAUDE_NET_HOST, not the
    // entry-point-specific X-Forwarded-* headers.
    expect(body).toContain('HUB="http://london:4815"');
    expect(body).not.toContain("public.example");

    process.env.CLAUDE_NET_HOST = undefined;
  });

  test("response includes bun preflight check", async () => {
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    expect(body).toContain("command -v bun");
    expect(body).toContain("bun.sh/install");
  });

  test("response is valid bash script", async () => {
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    expect(body).toStartWith("#!/bin/bash");
    expect(body).toContain("set -e");
    expect(body).toContain("claude mcp add");
    // hub URL is passed to the plugin via CLAUDE_NET_HUB
    expect(body).toContain("CLAUDE_NET_HUB=");
    expect(body).toContain("http://");
    expect(body).toContain("plugin.ts");
    expect(body).toContain("bun run");
    // new bits added in the full-installer rewrite
    expect(body).toContain("claude-net-mirror-push");
    expect(body).toContain(".claude/settings.json");
  });

  test("response content-type is text/plain", async () => {
    const resp = await fetch(`${baseUrl}/setup`);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/plain");
  });
});
