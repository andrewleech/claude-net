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
  HostRecoverableDoneFrame,
  HostRecoverableRequest,
  HostRegisterFrame,
  HostRestoreDoneFrame,
  HostRestoreRequest,
  HostRestoreResult,
  HostSessionProbeFrame,
  RecoverableSession,
} from "@/shared/types";
import { HubClient } from "./hub-client";
import { sanitizeTmuxName, scanRecoverable } from "./recoverable";

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
  /**
   * Session ids the daemon currently holds open. Recovery skips these:
   * a live session is not a crashed one.
   */
  getLiveSessionIds?: () => Set<string>;
  /** Working directories the daemon currently holds open. */
  getLiveCwds?: () => Set<string>;
  /**
   * Applied to recoverable-session previews before they leave the host.
   * Transcript prose crossing the network gets the same treatment as
   * mirrored events.
   */
  redact?: (text: string) => string;
  /**
   * Overrides the home directory the recovery scan reads and the default
   * workspace root (`<home>/projects`) is derived from. Defaults to
   * os.homedir().
   */
  home?: string;
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
  const recoverableDeps: RecoverableDeps = {
    getLiveSessionIds: opts.getLiveSessionIds,
    getLiveCwds: opts.getLiveCwds,
    redact: opts.redact,
    home: opts.home,
  };
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
      } else if (frame.action === "host_recoverable") {
        const response = await handleHostRecoverable(
          frame as HostRecoverableRequest,
          recoverableDeps,
        );
        client.send(JSON.stringify(response));
      } else if (frame.action === "host_restore") {
        const response = await handleHostRestore(
          frame as HostRestoreRequest,
          allowDangerousSkip,
          recoverableDeps,
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

/**
 * tmux resolves a -t target by exact name, then fnmatch, then unique
 * prefix, so a bare "claude" matches an existing "claude-net" session.
 * Every target here is anchored with "=" to mean exactly this session,
 * plus a trailing colon so the anchored name is parsed as the session
 * component of a target-pane argument.
 */
function exactPane(name: string): string {
  return `=${name}:`;
}

/**
 * Single-quotes a string for safe interpolation into a shell command line:
 * closes the quote, appends an escaped literal quote, and reopens it for
 * anything containing one.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Names of every current tmux session. Empty when tmux isn't running. */
async function tmuxSessionNames(): Promise<Set<string>> {
  const out = await tmuxCapture(["list-sessions", "-F", "#{session_name}"]);
  return new Set(out.split("\n").filter((n) => n.length > 0));
}

/**
 * First unused name in the series base, base-2, base-3, … matching the
 * scheme in bin/claude-channels so a restore and a manual launch in the
 * same directory agree on what to call themselves.
 */
function freeSessionName(base: string, taken: Set<string>): string {
  let n = 1;
  let name = base;
  while (taken.has(name)) {
    n += 1;
    name = `${base}-${n}`;
  }
  return name;
}

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
  const base = sanitizeTmuxName(path.basename(v.absolute));
  const taken = await tmuxSessionNames();

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

  // An existing session for this directory sitting at an idle shell means
  // claude-channels exited there. Reuse it: cd to the requested cwd and
  // relaunch in place rather than stranding it and opening a second one.
  let tmuxSession = base;
  if (taken.has(base)) {
    const paneCmd = await tmuxCapture([
      "display-message",
      "-t",
      exactPane(base),
      "-p",
      "#{pane_current_command}",
    ]);
    if (IDLE_SHELLS.has(paneCmd)) {
      const relaunch = `cd ${shellQuote(v.absolute)} && claude-channels${req.skip_permissions ? " --dangerously-skip-permissions" : ""}${sessionArg}`;
      await tmuxCapture([
        "send-keys",
        "-t",
        exactPane(base),
        relaunch,
        "Enter",
      ]);
      return {
        action: "host_launch_done",
        request_id: req.request_id,
        ok: true,
        tmux_session: base,
      };
    }
    // Busy with something else: take the next free name in the series
    // rather than -A'ing onto an unrelated same-basename session.
    tmuxSession = freeSessionName(base, taken);
  }

  const args = [
    "new-session",
    "-d",
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

// ── Crash recovery ───────────────────────────────────────────────────────

/** Batch ceiling so one request can't fork an unbounded number of Claudes. */
const MAX_RESTORE_BATCH = 20;
/** Gap between spawns; ten simultaneous starts all rewrite ~/.claude.json. */
const RESTORE_STAGGER_MS = 400;

const TRUST_PROMPT_MARKER = "Yes, I trust this folder";
const TRUST_POLL_INTERVAL_MS = 500;
const TRUST_POLL_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RecoverableDeps {
  getLiveSessionIds?: () => Set<string>;
  getLiveCwds?: () => Set<string>;
  redact?: (text: string) => string;
  home?: string;
}

interface CollectRecoverableOpts {
  withinHours?: number | null;
  metadataOnly?: boolean;
}

async function collectRecoverable(
  opts: CollectRecoverableOpts,
  deps: RecoverableDeps,
): Promise<RecoverableSession[]> {
  const taken = await tmuxSessionNames();
  return scanRecoverable({
    home: deps.home,
    withinHours: opts.withinHours,
    metadataOnly: opts.metadataOnly,
    liveSessionIds: deps.getLiveSessionIds?.(),
    liveCwds: deps.getLiveCwds?.(),
    tmuxSessionExists: (name) => taken.has(name),
    redact: deps.redact,
  });
}

async function handleHostRecoverable(
  req: HostRecoverableRequest,
  deps: RecoverableDeps,
): Promise<HostRecoverableDoneFrame> {
  try {
    const sessions = await collectRecoverable(
      { withinHours: req.within_hours },
      deps,
    );
    return {
      action: "host_recoverable_done",
      request_id: req.request_id,
      sessions,
    };
  } catch (err) {
    return {
      action: "host_recoverable_done",
      request_id: req.request_id,
      error: (err as Error).message,
    };
  }
}

/**
 * Watch a freshly-restored pane for Claude Code's folder-trust prompt and
 * answer it. Restoring a session is proof the directory already hosted one,
 * so the trust decision was made when it first opened; without this the
 * session sits wedged at the prompt and never reconnects to the hub.
 *
 * Only ever sends keys after seeing the prompt's own text in the pane.
 */
async function answerTrustPrompt(tmuxSession: string): Promise<boolean> {
  const deadline = Date.now() + TRUST_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(TRUST_POLL_INTERVAL_MS);
    const pane = await tmuxCapture([
      "capture-pane",
      "-p",
      "-t",
      exactPane(tmuxSession),
    ]);
    if (!pane) continue;
    if (!pane.includes(TRUST_PROMPT_MARKER)) continue;
    await tmuxCapture([
      "send-keys",
      "-t",
      exactPane(tmuxSession),
      "1",
      "Enter",
    ]);
    return true;
  }
  return false;
}

async function handleHostRestore(
  req: HostRestoreRequest,
  allowDangerousSkip: boolean,
  deps: RecoverableDeps,
): Promise<HostRestoreDoneFrame> {
  if (req.skip_permissions && !allowDangerousSkip) {
    return {
      action: "host_restore_done",
      request_id: req.request_id,
      error: "skip_permissions not allowed on this host",
    };
  }
  const rawIds = Array.isArray(req.session_ids) ? req.session_ids : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of rawIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    return {
      action: "host_restore_done",
      request_id: req.request_id,
      error: "session_ids must be a non-empty array",
    };
  }
  if (ids.length > MAX_RESTORE_BATCH) {
    return {
      action: "host_restore_done",
      request_id: req.request_id,
      error: `at most ${MAX_RESTORE_BATCH} sessions per restore`,
    };
  }

  // Re-scan rather than trusting anything the caller sent. An id absent
  // from the fresh scan is stale (already restored, or now running), which
  // is what makes a long-open dashboard tab harmless. No time window: the
  // listing window is a convenience for what the dashboard shows, not
  // evidence the session stopped being recoverable. Metadata only: this
  // path needs session_id/cwd/needs_trust, not the label/turns/preview a
  // full transcript parse would cost.
  let candidates: RecoverableSession[];
  try {
    candidates = await collectRecoverable(
      { withinHours: null, metadataOnly: true },
      deps,
    );
  } catch (err) {
    return {
      action: "host_restore_done",
      request_id: req.request_id,
      error: (err as Error).message,
    };
  }
  const byId = new Map(candidates.map((c) => [c.session_id, c]));
  // Defaults on when omitted, but an explicit value must be a real boolean:
  // a JSON string is not consent to answer a trust prompt on the user's behalf.
  const autoTrust =
    req.auto_trust === undefined ? true : req.auto_trust === true;

  const taken = await tmuxSessionNames();
  const results: HostRestoreResult[] = [];

  for (const id of ids) {
    const candidate = byId.get(id);
    if (!candidate) {
      results.push({
        session_id: id,
        ok: false,
        error: "no longer recoverable",
      });
      continue;
    }

    // A same-named tmux session is not evidence the directory is in use -
    // liveCwds/liveSessionIds (a /proc scan) already excluded genuinely
    // live sessions above. freeSessionName always finds a name to use.
    const base = sanitizeTmuxName(
      path.basename(candidate.cwd) || candidate.cwd,
    );
    const tmuxSession = freeSessionName(base, taken);
    taken.add(tmuxSession);

    const args = [
      "new-session",
      "-d",
      "-s",
      tmuxSession,
      "-c",
      candidate.cwd,
      // Tells bin/claude-channels it is already inside tmux so it execs
      // Claude Code directly instead of wrapping itself a second time.
      "-e",
      "CLAUDE_NET_IN_TMUX_WRAP=1",
      "--",
      "claude-channels",
    ];
    if (req.skip_permissions) args.push("--dangerously-skip-permissions");
    // --resume pins the exact transcript the user ticked. --continue would
    // pick whatever is newest for the cwd, which need not be the same one.
    args.push("--resume", candidate.session_id);

    try {
      await spawnDetached(args);
      results.push({
        session_id: id,
        ok: true,
        tmux_session: tmuxSession,
        needs_trust: candidate.needs_trust,
      });
      // Fire and forget: the trust prompt can take up to
      // TRUST_POLL_TIMEOUT_MS to appear and be answered, far longer than a
      // caller waiting on this RPC should be made to block. The .catch
      // keeps a rejection here from becoming an unhandled rejection.
      if (autoTrust && candidate.needs_trust) {
        answerTrustPrompt(tmuxSession).catch(() => {});
      }
    } catch (err) {
      taken.delete(tmuxSession);
      results.push({
        session_id: id,
        ok: false,
        error: `restore failed: ${(err as Error).message}`,
      });
      continue;
    }
    await delay(RESTORE_STAGGER_MS);
  }

  return {
    action: "host_restore_done",
    request_id: req.request_id,
    results,
  };
}

function spawnDetached(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("tmux", args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    proc.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`tmux new-session exited with code ${code}`));
    });
    proc.on("error", reject);
    proc.unref();
  });
}
