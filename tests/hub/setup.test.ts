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

    expect(body).toContain('HUB="mybox:4815"');
    expect(body).toContain("http://$HUB");
    expect(body).toContain("claude mcp add");

    process.env.CLAUDE_NET_HOST = undefined;
  });

  test("GET /setup appends port when CLAUDE_NET_HOST has no port", async () => {
    process.env.CLAUDE_NET_HOST = "mybox.local";
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    expect(body).toContain('HUB="mybox.local:4815"');

    process.env.CLAUDE_NET_HOST = undefined;
  });

  test("response is valid bash script", async () => {
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    expect(body).toStartWith("#!/bin/bash");
    expect(body).toContain("set -e");
    expect(body).toContain("claude mcp add --transport stdio");
    expect(body).toContain("--env CLAUDE_NET_HUB=http://$HUB");
    expect(body).toContain("claude-net -- bun run http://$HUB/plugin.ts");
  });

  test("response content-type is text/plain", async () => {
    const resp = await fetch(`${baseUrl}/setup`);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/plain");
  });
});
