// Long-lived daemon → hub WebSocket at /ws/host.
//
// Distinct from the per-session /ws/mirror/:sid sockets. Identifies
// this host on the hub and serves the ls / mkdir / launch RPCs the
// dashboard uses to open new claude-channels sessions remotely.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  HostLaunchDoneFrame,
  HostLaunchRequest,
  HostLsDoneFrame,
  HostLsRequest,
  HostMkdirDoneFrame,
  HostMkdirRequest,
  HostRegisterFrame,
  HostSessionProbeFrame,
} from "@/shared/types";
import { HubClient } from "./hub-client";

export interface HostChannelOptions {
  hubUrl: string;
  /** Provides the last-N cwds from active/recent sessions for the popover. */
  getRecentCwds: () => string[];
  /**
   * Called when the hub sends a host_session_probe. The daemon should
   * create a mirror session for the given (ccPid, cwd) if one doesn't
   * already exist. Fire-and-forget — errors are logged inside the daemon.
   */
  onSessionProbe?: (ccPid: number, cwd: string) => void;
}

/**
 * Read `claudeNet.workspaces` + `claudeNet.launch` from the user's
 * ~/.claude/settings.json, filling in defaults. Fails soft — a missing
 * or unparseable file just yields the defaults.
 */
export function loadHostConfig(): {
  roots: string[];
  allowDangerousSkip: boolean;
} {
  const defaults = {
    roots: [path.join(os.homedir(), "projects")],
    allowDangerousSkip: true,
  };
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return defaults;
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      claudeNet?: {
        workspaces?: { roots?: string[] };
        launch?: { allow_dangerous_skip?: boolean };
      };
    };
    const roots = parsed.claudeNet?.workspaces?.roots;
    const allowSkip = parsed.claudeNet?.launch?.allow_dangerous_skip;
    return {
      roots:
        Array.isArray(roots) && roots.length > 0
          ? roots.map((r) => expandHome(r))
          : defaults.roots,
      allowDangerousSkip:
        typeof allowSkip === "boolean"
          ? allowSkip
          : defaults.allowDangerousSkip,
    };
  } catch {
    return defaults;
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function deriveHostId(): string {
  const user = os.userInfo().username || process.env.USER || "user";
  const host = os.hostname() || "host";
  return `${user}@${host}`;
}

export interface HostChannelHandle {
  stop(): void;
  /** Expose the loaded roots so other RPC handlers (Phase B) can reuse them. */
  getRoots(): string[];
}

export function startHostChannel(opts: HostChannelOptions): HostChannelHandle {
  const { roots, allowDangerousSkip } = loadHostConfig();
  const realRoots = resolveRealRoots(roots);
  const hostId = deriveHostId();
  const wsBase = opts.hubUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/+$/, "");

  const client = new HubClient({
    url: `${wsBase}/ws/host`,
    logPrefix: "claude-net/host",
    onOpen: () => {
      const frame: HostRegisterFrame = {
        action: "host_register",
        host_id: hostId,
        user: os.userInfo().username || process.env.USER || "user",
        hostname: os.hostname() || "host",
        home: os.homedir(),
        recent_cwds: opts.getRecentCwds().slice(0, 20),
        allow_dangerous_skip: allowDangerousSkip,
      };
      client.send(JSON.stringify(frame));
    },
    onMessage: async (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      if (!data || typeof data !== "object" || !("action" in data)) return;
      const frame = data as { action: string } & Record<string, unknown>;

      if (frame.action === "host_ls") {
        const response = await handleHostLs(frame as HostLsRequest, realRoots);
        client.send(JSON.stringify(response));
      } else if (frame.action === "host_mkdir") {
        const response = await handleHostMkdir(
          frame as HostMkdirRequest,
          realRoots,
        );
        client.send(JSON.stringify(response));
      } else if (frame.action === "host_launch") {
        const response = await handleHostLaunch(
          frame as HostLaunchRequest,
          realRoots,
          allowDangerousSkip,
        );
        client.send(JSON.stringify(response));
      } else if (frame.action === "host_session_probe") {
        const probe = frame as HostSessionProbeFrame;
        if (
          typeof probe.cc_pid === "number" &&
          typeof probe.cwd === "string" &&
          opts.onSessionProbe
        ) {
          opts.onSessionProbe(probe.cc_pid, probe.cwd);
        }
      }
    },
  });
  client.start();

  return {
    stop: () => client.stop(),
    getRoots: () => roots,
  };
}

// ── Path validation ──────────────────────────────────────────────────────

function resolveRealRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(fs.realpathSync(r));
    } catch {
      // Root doesn't exist on this host — skip. ls/mkdir/launch requests
      // under it will fail the containment check.
    }
  }
  return out;
}

/**
 * Resolve a user-supplied path to an absolute path and verify it sits
 * inside one of the allowed roots. For paths that already exist, we
 * realpath the full path so symlinks inside the tree can't escape. For
 * paths that don't yet exist (mkdir), we realpath the longest existing
 * ancestor and check the non-realpath full path starts with it (no
 * symlinks to follow, so prefix-matching is sufficient).
 */
function resolveAndValidate(
  requested: string,
  realRoots: string[],
): { ok: true; absolute: string } | { ok: false; error: string } {
  if (typeof requested !== "string" || requested.length === 0) {
    return { ok: false, error: "path must be a non-empty string" };
  }
  const expanded = expandHome(requested);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: "path must be absolute" };
  }
  const absolute = path.resolve(expanded);
  let real: string;
  if (fs.existsSync(absolute)) {
    try {
      real = fs.realpathSync(absolute);
    } catch {
      return { ok: false, error: "failed to resolve path" };
    }
  } else {
    // Walk up until we find an existing ancestor.
    let cursor = absolute;
    while (cursor !== path.dirname(cursor) && !fs.existsSync(cursor)) {
      cursor = path.dirname(cursor);
    }
    let ancestorReal: string;
    try {
      ancestorReal = fs.realpathSync(cursor);
    } catch {
      return { ok: false, error: "failed to resolve ancestor" };
    }
    // Reconstruct: ancestorReal + remainder below cursor.
    const remainder = absolute.slice(cursor.length);
    real = ancestorReal + remainder;
  }
  for (const root of realRoots) {
    if (real === root || real.startsWith(root + path.sep)) {
      return { ok: true, absolute };
    }
  }
  return { ok: false, error: "path is outside allowed roots" };
}

// ── RPC handlers ─────────────────────────────────────────────────────────

async function handleHostLs(
  req: HostLsRequest,
  realRoots: string[],
): Promise<HostLsDoneFrame> {
  const v = resolveAndValidate(req.path, realRoots);
  if (!v.ok) {
    return {
      action: "host_ls_done",
      request_id: req.request_id,
      error: v.error,
    };
  }
  try {
    const dirents = await fs.promises.readdir(v.absolute, {
      withFileTypes: true,
    });
    const entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, is_dir: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      action: "host_ls_done",
      request_id: req.request_id,
      entries,
    };
  } catch (err) {
    return {
      action: "host_ls_done",
      request_id: req.request_id,
      error: (err as Error).message,
    };
  }
}

async function handleHostMkdir(
  req: HostMkdirRequest,
  realRoots: string[],
): Promise<HostMkdirDoneFrame> {
  const v = resolveAndValidate(req.path, realRoots);
  if (!v.ok) {
    return {
      action: "host_mkdir_done",
      request_id: req.request_id,
      error: v.error,
    };
  }
  try {
    await fs.promises.mkdir(v.absolute, { recursive: true });
    return {
      action: "host_mkdir_done",
      request_id: req.request_id,
      ok: true,
    };
  } catch (err) {
    return {
      action: "host_mkdir_done",
      request_id: req.request_id,
      error: (err as Error).message,
    };
  }
}

function tmuxCapture(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn("tmux", args, { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", () => resolve(Buffer.concat(chunks).toString().trim()));
    proc.on("error", () => resolve(""));
  });
}

async function handleHostLaunch(
  req: HostLaunchRequest,
  realRoots: string[],
  allowDangerousSkip: boolean,
): Promise<HostLaunchDoneFrame> {
  if (req.skip_permissions && !allowDangerousSkip) {
    return {
      action: "host_launch_done",
      request_id: req.request_id,
      error: "skip_permissions not allowed on this host",
    };
  }
  const v = resolveAndValidate(req.cwd, realRoots);
  if (!v.ok) {
    return {
      action: "host_launch_done",
      request_id: req.request_id,
      error: v.error,
    };
  }
  // If cwd is missing, either create it (when asked) or reject.
  if (!fs.existsSync(v.absolute)) {
    if (!req.create_if_missing) {
      return {
        action: "host_launch_done",
        request_id: req.request_id,
        error: "cwd does not exist (set create_if_missing to create it)",
      };
    }
    try {
      await fs.promises.mkdir(v.absolute, { recursive: true });
    } catch (err) {
      return {
        action: "host_launch_done",
        request_id: req.request_id,
        error: `mkdir failed: ${(err as Error).message}`,
      };
    }
  }
  const tmuxSession = path.basename(v.absolute);

  // Check if the session already exists with an idle shell (claude-channels
  // exited). If so, cd to the requested cwd and re-launch rather than
  // silently no-oping via -A.
  const IDLE_SHELLS = new Set([
    "bash",
    "sh",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
  ]);
  const paneCmd = await tmuxCapture([
    "display-message",
    "-t",
    tmuxSession,
    "-p",
    "#{pane_current_command}",
  ]);
  if (IDLE_SHELLS.has(paneCmd)) {
    const relaunch = `cd "${v.absolute}" && claude-channels${req.skip_permissions ? " --dangerously-skip-permissions" : ""}`;
    await tmuxCapture(["send-keys", "-t", tmuxSession, relaunch, "Enter"]);
    return {
      action: "host_launch_done",
      request_id: req.request_id,
      ok: true,
      tmux_session: tmuxSession,
    };
  }

  const args = [
    "new-session",
    "-d",
    "-A",
    "-s",
    tmuxSession,
    "-c",
    v.absolute,
    "--",
    "claude-channels",
  ];
  if (req.skip_permissions) args.push("--dangerously-skip-permissions");
  try {
    const proc = spawn("tmux", args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    // tmux new-session -d returns after creating the detached session.
    // Wait briefly for it to exit; a non-zero exit means tmux rejected us
    // (bad binary, etc.) — surface it rather than silently succeeding.
    await new Promise<void>((resolve, reject) => {
      proc.on("exit", (code) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`tmux new-session exited with code ${code}`));
      });
      proc.on("error", reject);
    });
    proc.unref();
    return {
      action: "host_launch_done",
      request_id: req.request_id,
      ok: true,
      tmux_session: tmuxSession,
    };
  } catch (err) {
    return {
      action: "host_launch_done",
      request_id: req.request_id,
      error: `launch failed: ${(err as Error).message}`,
    };
  }
}
