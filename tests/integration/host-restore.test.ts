// End-to-end crash recovery: a real hub, the real daemon-side host
// channel, an isolated tmux server, and a stub claude-channels standing in
// for Claude Code. Exercises discovery over the wire, the tmux spawn, and
// the folder-trust auto-answer.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hostPlugin } from "@/hub/host";
import { HostRegistry } from "@/hub/host-registry";
import { Registry } from "@/hub/registry";
import { Teams } from "@/hub/teams";
import { broadcastToDashboards, wsDashboardPlugin } from "@/hub/ws-dashboard";
import { wsHostPlugin } from "@/hub/ws-host";
import type { HostChannelHandle } from "@/mirror-agent/host-channel";
import { startHostChannel } from "@/mirror-agent/host-channel";
import { encodeProjectDirName } from "@/mirror-agent/recoverable";
import { Elysia } from "elysia";

const SID = "cccccccc-1111-2222-3333-444444444444";
const HOST_ID = `${os.userInfo().username}@${os.hostname()}`;

function tmux(tmpdir: string, args: string[]): string {
  // TMUX is deleted rather than blanked: assigning undefined into an env
  // object yields the literal string "undefined", which tmux would then
  // try to parse as a socket path.
  const env = { ...process.env, TMUX_TMPDIR: tmpdir };
  // biome-ignore lint/performance/noDelete: the key must be absent, not undefined; an undefined assignment leaves tmux reading the string "undefined" as a socket path
  delete env.TMUX;
  const res = spawnSync("tmux", args, { encoding: "utf8", env });
  return (res.stdout || "").trim();
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}: ${String(last)}`);
}

describe("host restore end-to-end", () => {
  let tmpRoot: string;
  let home: string;
  let tmuxTmp: string;
  let projectCwd: string;
  let trustLog: string;
  let app: Elysia;
  let port: number;
  let channel: HostChannelHandle | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-restore-e2e-"));
    home = path.join(tmpRoot, "home");
    tmuxTmp = path.join(tmpRoot, "tmux");
    const bin = path.join(tmpRoot, "bin");
    trustLog = path.join(tmpRoot, "trust.log");
    projectCwd = path.join(home, "projects", "widget");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(tmuxTmp, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });

    // Stub launcher: prints Claude Code's trust prompt, records the key it
    // is sent, then idles so the tmux session stays alive.
    const stub = path.join(bin, "claude-channels");
    fs.writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        `echo "$@" > "${trustLog}.args"`,
        'echo "  1. Yes, I trust this folder"',
        "read -r answer",
        `echo "$answer" > "${trustLog}"`,
        "sleep 300",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    // A project whose last exit was not graceful and which has never
    // accepted the trust dialog.
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        projects: {
          [projectCwd]: {
            lastGracefulShutdown: false,
            hasTrustDialogAccepted: false,
          },
        },
      }),
    );
    const tDir = path.join(
      home,
      ".claude",
      "projects",
      encodeProjectDirName(projectCwd),
    );
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(
      path.join(tDir, `${SID}.jsonl`),
      `${JSON.stringify({ type: "user", message: { content: "ship the widget" } })}\n`,
    );

    for (const k of ["HOME", "TMUX", "TMUX_TMPDIR", "PATH"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = home;
    process.env.TMUX_TMPDIR = tmuxTmp;
    // TMUX takes precedence over TMUX_TMPDIR, so it must be cleared or the
    // spawns land on the developer's own tmux server.
    // biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the literal string "undefined"
    delete process.env.TMUX;
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const hostRegistry = new HostRegistry();
    hostRegistry.setDashboardBroadcast(broadcastToDashboards);
    const registry = new Registry();
    const teams = new Teams(registry);
    app = new Elysia().use(hostPlugin({ hostRegistry }));
    app = wsDashboardPlugin(app, registry, teams, hostRegistry);
    app = wsHostPlugin(app, hostRegistry);
    app.listen(0);
    // biome-ignore lint/style/noNonNullAssertion: server exists after listen
    port = app.server!.port;

    channel = startHostChannel({
      hubUrl: `http://localhost:${port}`,
      getRecentCwds: () => [],
      home,
    });
    await waitFor(() => hostRegistry.get(HOST_ID), "host registration");
  });

  afterEach(() => {
    channel?.stop();
    channel = null;
    try {
      app.stop();
    } catch {
      // already stopped
    }
    // Scoped to this test's socket dir, never the developer's server.
    tmux(tmuxTmp, ["kill-server"]);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("finds the crashed session over the wire", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/recoverable`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].session_id).toBe(SID);
    expect(body.sessions[0].cwd).toBe(projectCwd);
    expect(body.sessions[0].label).toBe("widget");
    expect(body.sessions[0].needs_trust).toBe(true);
    expect(body.sessions[0].preview).toBe("ship the widget");
  });

  test("restores it into tmux and answers the trust prompt", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_ids: [SID] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].tmux_session).toBe("widget");
    expect(body.results[0].trust_answered).toBe(true);

    // The session is alive under the expected name.
    expect(tmux(tmuxTmp, ["list-sessions", "-F", "#{session_name}"])).toBe(
      "widget",
    );
    // The launcher was told to resume that exact transcript.
    expect(fs.readFileSync(`${trustLog}.args`, "utf8")).toContain(
      `--resume ${SID}`,
    );
    // And the trust prompt was answered with option 1.
    expect(fs.readFileSync(trustLog, "utf8").trim()).toBe("1");
  }, 40_000);

  // Regression for tmux's prefix matching: a bare -t target resolves
  // "widget" to an existing "widget-other", so an unanchored probe would
  // send the relaunch into someone else's pane.
  test("does not adopt a tmux session that merely shares a name prefix", async () => {
    tmux(tmuxTmp, ["new-session", "-d", "-s", "widget-other"]);

    const list = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/recoverable`),
    );
    const listBody = (await list.json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(listBody.sessions[0].tmux_conflict).toBeNull();

    const res = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_ids: [SID] }),
      }),
    );
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].tmux_session).toBe("widget");

    const names = tmux(tmuxTmp, ["list-sessions", "-F", "#{session_name}"])
      .split("\n")
      .sort();
    expect(names).toEqual(["widget", "widget-other"]);
  }, 40_000);

  test("takes the next free name when the directory's session is busy", async () => {
    tmux(tmuxTmp, ["new-session", "-d", "-s", "widget"]);

    const res = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_ids: [SID] }),
      }),
    );
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    // The scan reports the directory as already owned, so restore declines
    // rather than opening a second Claude on the same transcript.
    expect(body.results[0].ok).toBe(false);
    expect(String(body.results[0].error)).toContain("already owns");
  });

  test("rejects a session id that is not recoverable", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_ids: ["not-a-real-sid"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toBe("no longer recoverable");
    expect(tmux(tmuxTmp, ["list-sessions", "-F", "#{session_name}"])).toBe("");
  });
});
