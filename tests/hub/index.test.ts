import { afterAll, describe, expect, test } from "bun:test";
import { app } from "@/hub/index";

describe("hub server", () => {
  afterAll(() => {
    app.stop();
  });

  test("GET /health returns enhanced status info", async () => {
    const port = app.server?.port;
    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.agents).toBe("number");
    expect(typeof body.teams).toBe("number");
  });

  test("GET /manifest.webmanifest returns PWA manifest JSON", async () => {
    const port = app.server?.port;
    const response = await fetch(
      `http://localhost:${port}/manifest.webmanifest`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("manifest");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.name).toBe("claude-net");
    expect(body.start_url).toBe("/");
    expect(body.display).toBe("standalone");
    expect(Array.isArray(body.icons)).toBe(true);
  });

  test("every manifest icon src resolves to a 200", async () => {
    const port = app.server?.port;
    const manifest = (await (
      await fetch(`http://localhost:${port}/manifest.webmanifest`)
    ).json()) as { icons: Array<{ src: string; type?: string }> };
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const r = await fetch(`http://localhost:${port}${icon.src}`);
      expect(r.status).toBe(200);
      if (icon.type) {
        expect(r.headers.get("content-type")).toContain(
          icon.type.split("/")[1],
        );
      }
    }
  });

  test("GET /sw.js returns the service worker with no-cache", async () => {
    const port = app.server?.port;
    const response = await fetch(`http://localhost:${port}/sw.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const body = await response.text();
    expect(body).toContain("claude-net-shell-v2");
    expect(body).toContain("addEventListener");
  });

  test("service worker SHELL list includes every shell path", async () => {
    // The SW pre-caches these at install and is the exclusive allowlist
    // for write-through during fetch. Every path must be a live route
    // served by the hub, or installability and the offline fallback
    // break. This test catches drift between index.ts and sw.js.
    const port = app.server?.port;
    const sw = await (await fetch(`http://localhost:${port}/sw.js`)).text();
    const expectedShell = [
      "/",
      "/manifest.webmanifest",
      "/icon.svg",
      "/icon-192.png",
      "/icon-512.png",
      "/dashboard/parsers.js",
    ];
    for (const path of expectedShell) {
      expect(sw).toContain(`"${path}"`);
      const r = await fetch(`http://localhost:${port}${path}`);
      expect(r.status).toBe(200);
    }
  });

  test("service worker skip list covers every live-data path", async () => {
    // Live data must never be intercepted by the SW. If a new REST/WS
    // route is added to index.ts, add it here AND to sw.js's bypass
    // lists — this test exists so the two stay in lockstep.
    const port = app.server?.port;
    const sw = await (await fetch(`http://localhost:${port}/sw.js`)).text();
    const exactPaths = ["/plugin.ts", "/setup", "/health", "/ws"];
    const prefixPaths = ["/api/", "/ws/", "/bin/", "/uploads/"];
    for (const p of [...exactPaths, ...prefixPaths]) {
      expect(sw).toContain(`"${p}"`);
    }
  });

  test("GET /icon.svg returns the app icon", async () => {
    const port = app.server?.port;
    const response = await fetch(`http://localhost:${port}/icon.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("svg");
    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("</svg>");
  });

  test("GET /icon-192.png returns a PNG", async () => {
    const port = app.server?.port;
    const response = await fetch(`http://localhost:${port}/icon-192.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // PNG magic number: 89 50 4E 47 0D 0A 1A 0A
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  });

  test("GET /icon-512.png returns a PNG", async () => {
    const port = app.server?.port;
    const response = await fetch(`http://localhost:${port}/icon-512.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  });
});
