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
import type { HostRestoreDoneFrame } from "@/shared/types";
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
  let hostRegistry: HostRegistry;
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

    hostRegistry = new HostRegistry();
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
    // The daemon replies as soon as the tmux spawn is done, before the
    // trust prompt is even visible, so the response can only report that
    // trust is still outstanding, not whether it has been answered yet.
    expect(body.results[0].needs_trust).toBe(true);

    // The session is alive under the expected name.
    expect(tmux(tmuxTmp, ["list-sessions", "-F", "#{session_name}"])).toBe(
      "widget",
    );
    // The launcher was told to resume that exact transcript. The stub
    // writes this file asynchronously, so poll rather than reading it
    // the instant the HTTP response comes back.
    await waitFor(
      () =>
        fs.existsSync(`${trustLog}.args`) &&
        fs.readFileSync(`${trustLog}.args`, "utf8"),
      "launcher args file",
    );
    expect(fs.readFileSync(`${trustLog}.args`, "utf8")).toContain(
      `--resume ${SID}`,
    );
    // The trust watch runs detached in the background; give it time to
    // see the prompt and answer it with option 1.
    await waitFor(
      () =>
        fs.existsSync(trustLog) &&
        fs.readFileSync(trustLog, "utf8").trim() === "1",
      "trust prompt answered",
    );
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
    // A pre-existing "widget" tmux session merely sharing the directory's
    // basename is not evidence the directory is in use - liveness is
    // already enforced upstream by the /proc-derived liveCwds/liveSessionIds
    // sets. Restore proceeds and lands on the next free name in the series.
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].tmux_session).toBe("widget-2");

    const names = tmux(tmuxTmp, ["list-sessions", "-F", "#{session_name}"])
      .split("\n")
      .sort();
    expect(names).toEqual(["widget", "widget-2"]);
  }, 40_000);

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

  test("restores a session older than the listing window", async () => {
    const staleSid = "dddddddd-1111-2222-3333-444444444444";
    const staleCwd = path.join(home, "projects", "stale");
    fs.mkdirSync(staleCwd, { recursive: true });

    const cfgPath = path.join(home, ".claude.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.projects[staleCwd] = {
      lastGracefulShutdown: false,
      hasTrustDialogAccepted: true,
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const tDir = path.join(
      home,
      ".claude",
      "projects",
      encodeProjectDirName(staleCwd),
    );
    fs.mkdirSync(tDir, { recursive: true });
    const file = path.join(tDir, `${staleSid}.jsonl`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "user", message: { content: "old work" } })}\n`,
    );
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, fiveDaysAgo, fiveDaysAgo);

    // A 24h-windowed listing does not surface it - the window is a
    // listing convenience, not evidence the session stopped being
    // recoverable.
    const list = await app.handle(
      new Request(
        `http://localhost/api/host/${HOST_ID}/recoverable?within_hours=24`,
      ),
    );
    const listBody = (await list.json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(listBody.sessions.some((s) => s.session_id === staleSid)).toBe(
      false,
    );

    // Restore still succeeds: the restore validation rescan applies no
    // time window at all.
    const res = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_ids: [staleSid] }),
      }),
    );
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].tmux_session).toBe("stale");
  }, 40_000);

  test("sanitizes a dotted directory basename to the tmux session name", async () => {
    const dotSid = "eeeeeeee-1111-2222-3333-444444444444";
    const dotCwd = path.join(home, "projects", "v1.2");
    fs.mkdirSync(dotCwd, { recursive: true });

    const cfgPath = path.join(home, ".claude.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.projects[dotCwd] = {
      lastGracefulShutdown: false,
      hasTrustDialogAccepted: true,
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const tDir = path.join(
      home,
      ".claude",
      "projects",
      encodeProjectDirName(dotCwd),
    );
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(
      path.join(tDir, `${dotSid}.jsonl`),
      `${JSON.stringify({ type: "user", message: { content: "dotted" } })}\n`,
    );

    const res = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_ids: [dotSid] }),
      }),
    );
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results[0].ok).toBe(true);
    // tmux itself would have rewritten a literal "v1.2" -s argument to
    // "v1_2"; the daemon must agree up front or later target-pane lookups
    // (trust-prompt polling, launch reuse) address a session that was
    // never actually created.
    expect(body.results[0].tmux_session).toBe("v1_2");

    // The name tmux actually created resolves - an unsanitized "=v1.2:"
    // target would fail here.
    expect(tmux(tmuxTmp, ["capture-pane", "-t", "=v1_2:", "-p"])).toContain(
      "Yes, I trust this folder",
    );
  }, 40_000);

  test("the daemon dedups session_ids on its own, independent of the hub", async () => {
    // Goes straight through the registry rather than the HTTP route: the
    // hub also dedups before dispatching, so exercising the daemon's own
    // dedup means bypassing that and sending the raw duplicates.
    const resp = (await hostRegistry.sendRpc(
      HOST_ID,
      "host_restore",
      { session_ids: [SID, SID, SID] },
      20_000,
    )) as HostRestoreDoneFrame;
    expect(resp.results).toHaveLength(1);
    expect(resp.results?.[0].ok).toBe(true);

    const names = tmux(tmuxTmp, ["list-sessions", "-F", "#{session_name}"])
      .split("\n")
      .filter((n) => n.length > 0);
    expect(names).toEqual(["widget"]);
  }, 40_000);

  // Regression for the shell injection in handleHostLaunch's session-reuse
  // path: a cwd containing shell metacharacters must not execute anything
  // when interpolated into the "cd ... && claude-channels" line typed into
  // the reused pane. Mirrors a real report: a directory basename doesn't
  // need the metacharacters at all - an EARLIER path component carries
  // them, the basename used for the tmux session stays an innocuous name.
  test("a cwd containing shell metacharacters cannot break out via host_launch", async () => {
    const canaryFile = path.join(tmpRoot, "canary-marker");
    // Contains ", ;, a backtick, and $ - none of which should reach a
    // live shell unescaped.
    const evilMid = 'x"; touch canary-marker; `date`; echo $HOME; #';
    const evilCwd = path.join(home, "projects", evilMid, "myapp");
    fs.mkdirSync(evilCwd, { recursive: true });

    // A pre-existing idle session named for the (safe) final basename -
    // this is what makes handleHostLaunch take the "reuse this pane"
    // branch instead of spawning a fresh, argv-array new-session.
    tmux(tmuxTmp, ["new-session", "-d", "-s", "myapp", "-c", tmpRoot]);

    const res = await app.handle(
      new Request(`http://localhost/api/host/${HOST_ID}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: evilCwd }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.tmux_session).toBe("myapp");

    // Give the injected send-keys line time to run if it were going to.
    await new Promise((r) => setTimeout(r, 2000));
    expect(fs.existsSync(canaryFile)).toBe(false);
  }, 40_000);
});
