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
  /**
   * This daemon's embedded build hash (the __MIRROR_BUILD_HASH__ placeholder
   * injected into the bundle at build time). Used to detect version skew
   * against the hub on connect.
   */
  localVersion?: string;
  /**
   * Called when the hub's version differs from localVersion. The daemon
   * should download the new bundle and restart.
   */
  onVersionMismatch?: (hubVersion: string) => void;
}

/**
 * Read `claudeNet.launch` from the user's ~/.claude/settings.json, filling
 * in defaults. Fails soft — a missing or unparseable file just yields the
 * defaults.
 */
export function loadHostConfig(): {
  allowDangerousSkip: boolean;
} {
  const defaults = { allowDangerousSkip: true };
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return defaults;
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      claudeNet?: { launch?: { allow_dangerous_skip?: boolean } };
    };
    const allowSkip = parsed.claudeNet?.launch?.allow_dangerous_skip;
    return {
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
}

export function startHostChannel(opts: HostChannelOptions): HostChannelHandle {
  const { allowDangerousSkip } = loadHostConfig();
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
      if (!data || typeof data !== "object") return;
      const msg = data as Record<string, unknown>;

      // Hub acknowledgement sent after host_register is accepted.
      if (msg.event === "host_registered") {
        const hubVersion =
          typeof msg.hub_version === "string" ? msg.hub_version : null;
        if (
          hubVersion &&
          opts.localVersion &&
          opts.localVersion !== "__MIRROR_BUILD_HASH__" &&
          opts.localVersion !== hubVersion
        ) {
          opts.onVersionMismatch?.(hubVersion);
        }
        return;
      }

      if (!("action" in msg)) return;
      const frame = msg as { action: string } & Record<string, unknown>;

      if (frame.action === "host_ls") {
        const response = await handleHostLs(frame as HostLsRequest);
        client.send(JSON.stringify(response));
      } else if (frame.action === "host_mkdir") {
        const response = await handleHostMkdir(frame as HostMkdirRequest);
        client.send(JSON.stringify(response));
      } else if (frame.action === "host_launch") {
        const response = await handleHostLaunch(
          frame as HostLaunchRequest,
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
  };
}

// ── Path validation ──────────────────────────────────────────────────────

/**
 * Expand `~` and normalise a user-supplied path to an absolute one. The
 * daemon runs as the user and may address anywhere that user can reach;
 * the only requirement is that the path is absolute after expansion.
 */
function resolveAndValidate(
  requested: string,
): { ok: true; absolute: string } | { ok: false; error: string } {
  if (typeof requested !== "string" || requested.length === 0) {
    return { ok: false, error: "path must be a non-empty string" };
  }
  const expanded = expandHome(requested);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: "path must be absolute" };
  }
  return { ok: true, absolute: path.resolve(expanded) };
}

// ── RPC handlers ─────────────────────────────────────────────────────────

async function handleHostLs(req: HostLsRequest): Promise<HostLsDoneFrame> {
  const v = resolveAndValidate(req.path);
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
): Promise<HostMkdirDoneFrame> {
  const v = resolveAndValidate(req.path);
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
  allowDangerousSkip: boolean,
): Promise<HostLaunchDoneFrame> {
  if (req.skip_permissions && !allowDangerousSkip) {
    return {
      action: "host_launch_done",
      request_id: req.request_id,
      error: "skip_permissions not allowed on this host",
    };
  }
  const v = resolveAndValidate(req.cwd);
  if (!v.ok) {
    return {
      action: "host_launch_done",
      request_id: req.request_id,
      error: v.error,
    };
  }
  // If cwd is missing, either create it (when asked) or reject.
  let dirWasCreated = false;
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
      dirWasCreated = true;
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
  // --resume <sid> targets a specific dead session and takes precedence
  // over --continue. Neither applies to a freshly-created dir (nothing to
  // resume/continue). resume_sid is validated here before it is
  // interpolated into the send-keys shell string; a bad value is dropped
  // rather than trusted from the frame. The leading char must be
  // alphanumeric so it can't be read as a CLI flag.
  const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  if (req.resume_sid !== undefined && !SID_RE.test(req.resume_sid)) {
    return {
      action: "host_launch_done",
      request_id: req.request_id,
      error: "invalid resume_sid",
    };
  }
  const resumeSid =
    req.resume_sid && !dirWasCreated ? req.resume_sid : undefined;
  const sessionArg = resumeSid
    ? ` --resume ${resumeSid}`
    : req.continue_session && !dirWasCreated
      ? " --continue"
      : "";
  if (IDLE_SHELLS.has(paneCmd)) {
    const relaunch = `cd "${v.absolute}" && claude-channels${req.skip_permissions ? " --dangerously-skip-permissions" : ""}${sessionArg}`;
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
  if (resumeSid) {
    args.push("--resume", resumeSid);
  } else if (req.continue_session && !dirWasCreated) {
    args.push("--continue");
  }
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
