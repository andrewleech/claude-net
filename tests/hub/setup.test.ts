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
    expect(body).toContain('CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"');
    expect(body).toContain('SETTINGS="$CONFIG_DIR/settings.json"');
  });

  test("statusline.py installs to the shared ~/.claude regardless of CLAUDE_CONFIG_DIR", async () => {
    const resp = await fetch(`${baseUrl}/setup`);
    const body = await resp.text();

    // The account config dir (settings.json, hooks, launch config) can
    // move with CLAUDE_CONFIG_DIR, but the statusline script itself
    // stays shared at the fixed $HOME/.claude location referenced by
    // both accounts' settings.json.
    expect(body).toContain(
      'curl -fsSL "$HUB/bin/statusline.py" -o "$HOME/.claude/statusline.py"',
    );
  });

  test("response content-type is text/plain", async () => {
    const resp = await fetch(`${baseUrl}/setup`);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/plain");
  });

  describe("?runtime=mpy", () => {
    test("does not alter the default (no-param) script", async () => {
      const before = await (await fetch(`${baseUrl}/setup`)).text();
      await fetch(`${baseUrl}/setup?runtime=mpy`);
      const after = await (await fetch(`${baseUrl}/setup`)).text();
      expect(after).toBe(before);
      expect(after).toContain("bun run");
      expect(after).not.toContain("plugin-bin");
    });

    test("installs the plugin binary and launch wrapper, not the bun path", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      expect(resp.status).toBe(200);
      const body = await resp.text();

      expect(body).toStartWith("#!/bin/bash");
      expect(body).toContain('DIR="$HOME/.claude-net/plugin"');
      expect(body).toContain("/plugin-bin/linux-x64");
      expect(body).toContain("/plugin-bin/linux-x64/version");
      expect(body).not.toContain("plugin.ts");
      expect(body).not.toContain("bun run");
    });

    test("registers the MCP server pointed at the launch wrapper", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();

      expect(body).toContain("claude mcp remove --scope user claude-net");
      expect(body).toContain("claude mcp add");
      expect(body).toContain("CLAUDE_NET_HUB=");
      expect(body).toContain('claude-net -- "$HOME/.claude-net/plugin/launch"');
    });

    test("initial install verifies sha256 before trusting the download", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();

      // The [1/3] download step checks the freshly-downloaded file's
      // hash against the version endpoint's advertised sha256 before
      // ever touching the live $BIN via mv -f.
      const step1End = body.indexOf("[2/3]");
      const step1 = body.slice(0, step1End);
      expect(step1).toContain("sha256sum");
      expect(step1).toContain('"$got_sha" != "$want_sha"');
      expect(step1).toContain("aborting install");
      const mismatchIdx = step1.indexOf('"$got_sha" != "$want_sha"');
      const mvIdx = step1.indexOf('mv -f "$BIN.tmp" "$BIN"', mismatchIdx);
      expect(mismatchIdx).toBeGreaterThan(-1);
      expect(mvIdx).toBeGreaterThan(mismatchIdx);
    });

    test("launch wrapper verifies sha256 and falls back to the cached binary on mismatch", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();

      expect(body).toContain("sha256sum");
      expect(body).toContain('"$got_sha" != "$want_sha"');
      expect(body).toContain("discarding download");
      expect(body).toContain("running the existing cached binary instead");
      const mismatchIdx = body.indexOf('"$got_sha" != "$want_sha"');
      const mvIdx = body.indexOf('mv -f "$BIN.tmp" "$BIN"', mismatchIdx);
      expect(mismatchIdx).toBeGreaterThan(-1);
      expect(mvIdx).toBeGreaterThan(mismatchIdx);
    });

    test("launch wrapper only hard-fails when no cached binary exists", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();
      expect(body).toContain("no cached binary is available");
      // The refresh-failed branch must not exit when a cached binary is
      // present, the whole point of B1's fallback fix; see
      // tests/hub/launch-wrapper.test.ts for the executed-not-grepped
      // verification of this behaviour.
      expect(body).toContain("running the existing cached binary instead");
    });

    test("launch wrapper backs off after a persistent refresh failure", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();
      // A failed refresh records a timestamp; a subsequent launch within
      // the backoff window skips re-attempting the download entirely
      // rather than paying a full multi-MB fetch on every single launch
      // of a persistently-broken hub. See launch-wrapper.test.ts for the
      // executed verification (curl invocation count across launches).
      expect(body).toContain(".refresh-failed");
      expect(body).toContain("recently_failed");
      expect(body).toContain("skipping refresh");
    });

    test("launch wrapper skips redownloading when the cached version already matches the hub", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();
      // B3: the wrapper compares the version endpoint's full response
      // against the locally cached sidecar BEFORE downloading anything;
      // a hub/binary version mismatch (package.json bumped ahead of the
      // staged binary) is therefore not, on its own, a reason to
      // redownload an unchanged binary. See launch-wrapper.test.ts for
      // the executed verification (zero downloads across repeated
      // launches against a hub stuck advertising the same triple).
      const haveIdx = body.indexOf('have=$(cat "$VERSION_FILE"');
      const shortCircuitIdx = body.indexOf('"$ver" = "$have"', haveIdx);
      expect(haveIdx).toBeGreaterThan(-1);
      expect(shortCircuitIdx).toBeGreaterThan(haveIdx);
    });

    test("launch wrapper execs the binary (forwarding argv) so ppid stays Claude Code's", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();
      expect(body).toContain('exec "$BIN" "$@"');
    });

    test("output explains the partial-install scope and how to revert", async () => {
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();
      expect(body).toContain("ONLY the claude-net MCP server");
      expect(body).toContain("does not install");
      expect(body).toMatch(/curl -fsSL \$HUB\/setup \| bash/);
    });

    test("respects CLAUDE_NET_HOST like the default path", async () => {
      process.env.CLAUDE_NET_HOST = "https://localhost:9443";
      const resp = await fetch(`${baseUrl}/setup?runtime=mpy`);
      const body = await resp.text();
      expect(body).toContain('HUB="https://localhost:9443"');
      process.env.CLAUDE_NET_HOST = undefined;
    });
  });
});
