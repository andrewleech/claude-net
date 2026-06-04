// claude-net-mirror-agent — long-running local daemon.
//
// Accepts hook POSTs from claude-net-mirror-push on 127.0.0.1, maintains one
// hub WebSocket per active Claude Code session, tails each session's JSONL
// transcript for reconciliation, and forwards deduped events to the hub.
//
// The mirror-agent is deliberately separate from both the claude process
// (so it survives restarts and /clear) and the claude-net MCP plugin (so a
// plugin crash can't take the agent down).

import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MirrorEventFrame, MirrorStatuslineFrame } from "@/shared/types";
import { scanCommands } from "./command-scanner";
import { type RawHookPayload, ingestHook } from "./hook-ingest";
import { type HostChannelHandle, startHostChannel } from "./host-channel";
import { HubClient } from "./hub-client";
import { readHistoryBefore } from "./jsonl-history";
import { type TailHandle, tailJsonl } from "./jsonl-tail";
import { jsonlRecordToHistoryFrame } from "./jsonl-to-frame";
import { ProbeAttemptTracker } from "./probe-tracker";
import { Redactor, defaultConfigPaths } from "./redactor";
import { TmuxInjector } from "./tmux-inject";

// ── Types ─────────────────────────────────────────────────────────────────

export interface AgentConfig {
  hubUrl: string;
  bindHost?: string;
  /** 0 = pick a random port. Default 0. */
  bindPort?: number;
  stateDir?: string;
  /** Idle shutdown window in ms; 0 disables. Default 30 min. */
  idleShutdownMs?: number;
  /** Session idle cleanup window in ms; 0 disables. Default 10 min. */
  sessionIdleMs?: number;
}

interface SessionState {
  sid: string;
  ownerAgent: string;
  cwd: string;
  /** Host this mirror-agent is running on — sent with every session POST
   *  so the hub can join mirror sessions to MCP agents by (host, ccPid). */
  host: string;
  /** PID of the Claude Code process that owns this session. null if the
   *  hook wrapper didn't supply it (pre-CC_PID rollout). */
  ccPid: number | null;
  transcriptPath: string | null;
  ws: HubClient | null;
  seenUuids: Set<string>;
  outbox: string[];
  tail: TailHandle | null;
  lastEventAt: number;
  closed: boolean;
  tmuxPane: string | null;
  /** Set while a recovery round-trip is in flight to avoid duplicate recoveries. */
  recovering: boolean;
  /** Highest context-window size we've inferred for this session (auto-
   *  upgrades from 200k → 1M the first time a usage row crosses 200k). */
  ctxWindow: number;
  /** Last ctx_pct sent to the hub, to avoid re-sending unchanged values. */
  lastCtxPct: number;
  /** Most-recent usage row seen in the JSONL; re-emitted on WS reconnect
   *  so a hub restart doesn't leave the dashboard without a snapshot. */
  lastUsage: Record<string, unknown> | null;
  /** True while a keep-alive POST with a new ccPid is in flight, to
   *  prevent duplicate concurrent POSTs from rapid hook arrivals. */
  pendingPidUpdate: boolean;
  /** JSONL record uuids for which we have already POSTed an
   *  api-error report to the hub. Prevents double-firing within a
   *  single agent run; on restart the timestamp filter in
   *  `maybeReportApiError` keeps us from re-reporting old records. */
  apiErrorUuidsPosted: Set<string>;
}

export interface AgentHandle {
  port: number;
  stop(): Promise<void>;
  sessions: Map<string, SessionState>;
}

// ── Entry point ───────────────────────────────────────────────────────────

// 0 = disabled. The agent is a persistent daemon and should not self-terminate
// based on a session-count heuristic — a Claude Code process waiting for user
// input generates no hooks, so sessions.size stays 0 even while the user is
// actively working. Operators who need automatic cleanup can pass
// idleShutdownMs explicitly when calling startAgent().
// Placeholder replaced with the hub's commit hash when the bundle is built
// by bin-server.ts. Stays as the literal string "__MIRROR_BUILD_HASH__" in
// dev (bun run src/...) so the version check is a no-op in that context.
const MIRROR_BUILD_HASH = "__MIRROR_BUILD_HASH__";

const DEFAULT_IDLE_SHUTDOWN_MS = 0;
/**
 * Per-session idle-close window. 0 (default) disables idle closure —
 * sessions live as long as the Claude Code that owns them is running,
 * and are closed either by an explicit session_end hook or by the
 * daemon's own idle-shutdown. The old 10-minute default was a trap:
 * users could come back to the web view after lunch and find every
 * session marked "ended".
 */
const DEFAULT_SESSION_IDLE_MS = 0;
const OUTBOX_MAX = 4096;
const MAX_ASSISTANT_TEXT_BYTES = 256 * 1024;

/**
 * Per-call cap for the loopback /inject endpoint (claude-net-self-inject).
 * Matches the hub's webui-side MAX_INJECT_BYTES default (512 KB) so a
 * single text injection has the same upper bound however it originates.
 * Override via CLAUDE_NET_MIRROR_SELF_INJECT_MAX_KB.
 */
const MAX_SELF_INJECT_BYTES = (() => {
  const raw = Number(process.env.CLAUDE_NET_MIRROR_SELF_INJECT_MAX_KB);
  const kb = Number.isFinite(raw) && raw > 0 ? raw : 512;
  return kb * 1024;
})();

/** Recovery retry schedule. Hub redeploys typically take 10–30 s so the
 *  worst-case ~8 min window here covers nearly anything short of total
 *  hub failure. */
const RECOVERY_INITIAL_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 30_000;
const RECOVERY_MAX_ATTEMPTS = 20;

/** Maximum age of an isApiErrorMessage JSONL record we'll report to the
 *  hub. The JSONL tail re-reads from byte 0 on every agent start, so
 *  without a recency filter a restart would re-fire stale errors that
 *  have already been investigated. 5 min is well past the conversation
 *  half-life where a sender would still care. */
const API_ERROR_RECENCY_MS = 5 * 60 * 1000;

/** Directory where oversized web-pastes land as `paste-<uuid>.txt`. */
const PASTE_DIR = "/tmp/claude-net/pastes";
/** Delete paste files older than this on agent startup. */
const PASTE_RETENTION_MS = 24 * 60 * 60 * 1000;

function cleanupOldPastes(): void {
  try {
    const entries = fs.readdirSync(PASTE_DIR, { withFileTypes: true });
    const cutoff = Date.now() - PASTE_RETENTION_MS;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("paste-")) continue;
      const full = path.join(PASTE_DIR, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // ignore per-file errors
      }
    }
  } catch {
    // directory may not exist yet — that's fine
  }
}

/**
 * Download the latest mirror-agent bundle from the hub and replace the
 * running bundle file, then exit so the watchdog respawns with the new code.
 * Only runs when process.argv[1] points at a bundle file (skips dev mode).
 */
async function selfUpdate(hubUrl: string, hubVersion: string): Promise<void> {
  const bundlePath = process.argv[1];
  if (!bundlePath?.endsWith("mirror-agent.bundle.js")) {
    log(`[update] skipping self-update in dev mode (argv[1]=${bundlePath})`);
    return;
  }
  log(
    `[update] hub version ${hubVersion} differs from local ${MIRROR_BUILD_HASH}; downloading update`,
  );
  try {
    const res = await fetch(`${hubUrl}/bin/mirror-agent.bundle.js`);
    if (!res.ok) {
      log(`[update] download failed: HTTP ${res.status}`);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${bundlePath}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, bundlePath);
    log("[update] bundle replaced; exiting for watchdog respawn");
    process.exit(0);
  } catch (err) {
    log(`[update] self-update failed: ${String(err)}`);
  }
}

function clampAssistantText(s: string): { value: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= MAX_ASSISTANT_TEXT_BYTES) {
    return { value: s, truncated: false };
  }
  const buf = Buffer.from(s, "utf8").subarray(0, MAX_ASSISTANT_TEXT_BYTES);
  return { value: buf.toString("utf8"), truncated: true };
}

export async function startAgent(config: AgentConfig): Promise<AgentHandle> {
  const hubUrl = config.hubUrl.replace(/\/+$/, "");
  const bindHost = config.bindHost ?? "127.0.0.1";
  const stateDir = config.stateDir ?? "/tmp/claude-net";
  const idleShutdownMs = config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const sessionIdleMs = config.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  const sessions = new Map<string, SessionState>();
  // Per-ccPid probe bookkeeping: dedups concurrent in-flight probes,
  // applies a failure cooldown, and reuses the same sid across retries
  // so 429-loops don't accumulate orphan session rows on the hub.
  const probeAttempts = new ProbeAttemptTracker();
  const injector = new TmuxInjector();
  const redactor = new Redactor({
    configPaths: defaultConfigPaths(
      os.homedir(),
      process.env.CLAUDE_NET_PROJECT_DIR ?? process.cwd(),
    ),
  });
  log(
    `redactor loaded with ${redactor.ruleCount} rule(s); hit counters logged on shutdown`,
  );
  let lastActivityAt = Date.now();

  // Ensure state dir exists.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    log(`Failed to create state dir: ${String(err)}`);
  }

  // Remove any stale sentinel from a prior clean shutdown so the watchdog
  // doesn't mistake this new process for an idle-stopped one.
  removeSentinelFile(stateDir);

  // Prune stale pastes left by previous runs (anything older than 24 h).
  cleanupOldPastes();

  // Bind server. Bun's serve/fetch API is used here; we import Bun lazily so
  // this file remains type-checkable outside Bun.
  const server = Bun.serve({
    hostname: bindHost,
    port: config.bindPort ?? 0,
    fetch: (req) => handleFetch(req),
  });

  if (bindHost !== "127.0.0.1" && bindHost !== "localhost") {
    log(`Refusing to start: bindHost must be loopback (got '${bindHost}')`);
    server.stop();
    throw new Error("mirror-agent must bind to loopback only");
  }

  writePortFile(stateDir, server.port);
  log(
    `mirror-agent listening on http://${bindHost}:${server.port} (hub=${hubUrl})`,
  );

  // Host control channel — advertises this host to the hub's sidebar and
  // accepts ls/mkdir/launch RPCs and session probes from the hub.
  const hostChannel: HostChannelHandle = startHostChannel({
    hubUrl,
    getRecentCwds: () =>
      [...sessions.values()]
        .filter((s) => s.cwd)
        .sort((a, b) => b.lastEventAt - a.lastEventAt)
        .map((s) => s.cwd),
    onSessionProbe: (ccPid, cwd) => {
      // Skip if an active session for this ccPid already exists.
      for (const s of sessions.values()) {
        if (!s.closed && s.ccPid === ccPid) return;
      }
      // Skip if a probe is in-flight or recently failed (cooldown).
      if (probeAttempts.shouldSkip(ccPid)) return;
      const sid = probeAttempts.begin(ccPid);
      log(`[probe] creating session for ccPid=${ccPid} cwd=${cwd} sid=${sid}`);
      openSession(sid, cwd, undefined, undefined, ccPid)
        .then((session) => {
          if (session) {
            probeAttempts.succeeded(ccPid);
          } else {
            probeAttempts.failed(ccPid);
          }
        })
        .catch((err: unknown) => {
          log(`[probe] session create threw: ${String(err)}`);
          probeAttempts.failed(ccPid);
        });
    },
    localVersion: MIRROR_BUILD_HASH,
    onVersionMismatch: (hubVersion) => {
      selfUpdate(hubUrl, hubVersion).catch((err: unknown) => {
        log(`[update] unexpected error: ${String(err)}`);
      });
    },
  });

  // Idle-shutdown watchdog.
  const idleTimer = setInterval(() => {
    const now = Date.now();
    // Clean up idle sessions — only when sessionIdleMs > 0. Default is
    // 0 (disabled) since the old 10-min timeout was too aggressive:
    // users would come back to the web after a break and find every
    // session marked "ended".
    if (sessionIdleMs > 0) {
      for (const s of sessions.values()) {
        if (!s.closed && now - s.lastEventAt > sessionIdleMs) {
          closeSession(s, "idle");
        }
      }
    }
    // Orphan sweep: if the Claude Code parent died (SIGKILL, crash) the
    // Stop hook never fires and the session leaks. Probe each open
    // session's ccPid with signal 0 — `kill` throws ESRCH when the
    // process is gone. Guard with a 5s grace window after lastEventAt
    // so we don't race a hook arriving on a freshly-recorded ccPid.
    for (const s of sessions.values()) {
      if (s.closed || s.ccPid === null) continue;
      if (now - s.lastEventAt < 5_000) continue;
      try {
        process.kill(s.ccPid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          closeSession(s, "orphan");
        }
        // EPERM means the process exists but we can't signal it — still alive.
      }
    }
    // Process-level idle shutdown.
    if (
      idleShutdownMs > 0 &&
      sessions.size === 0 &&
      now - lastActivityAt > idleShutdownMs
    ) {
      log("idle shutdown");
      void stop();
    }
    // Periodic singleton recheck. The startup checkExistingDaemon only
    // runs once; processes that were started before the singleton-guard
    // landed (or that won a startup race) keep running until something
    // kills them. This converges duplicates to a single daemon: if the
    // port file points at a different PID with a healthy /health, we are
    // the duplicate — exit cleanly so the watchdog (if any) doesn't
    // respawn. The port-file owner is unaffected.
    void evictIfPeerOwnsPortFile(server.port, stateDir).catch((err: unknown) =>
      log(`[singleton] recheck failed: ${String(err)}`),
    );
  }, 30_000);
  if (typeof idleTimer === "object" && "unref" in idleTimer) {
    idleTimer.unref();
  }

  async function handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/hook") {
      return handleHookPost(req);
    }
    if (req.method === "POST" && url.pathname === "/inject") {
      return handleInjectPost(req);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        sessions: sessions.size,
        port: server.port,
      });
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      return Response.json(
        [...sessions.values()].map((s) => ({
          sid: s.sid,
          owner_agent: s.ownerAgent,
          cwd: s.cwd,
          cc_pid: s.ccPid,
          last_event_at: new Date(s.lastEventAt).toISOString(),
          closed: s.closed,
        })),
      );
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      void stop();
      return new Response("stopping", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * Loopback inject endpoint — lets a process running on the same host
   * (typically the Claude Code session itself, via the
   * claude-net-self-inject CLI) push text into a session's tmux pane
   * without going through the hub. Accepts either `sid` or `ccPid` to
   * identify the target session; ccPid is the path of least resistance
   * for self-inject because the caller can walk its own process tree.
   *
   * Security model: bound to 127.0.0.1, port file mode 0600, so only
   * same-uid processes can reach it. The trust boundary is identical to
   * what a process can already do with `tmux send-keys -t <pane>` —
   * adding this endpoint does not expand the attack surface.
   */
  async function handleInjectPost(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const resolved = resolveSelfInject(body, sessions, MAX_SELF_INJECT_BYTES);
    if ("error" in resolved) {
      return Response.json(
        { error: resolved.error },
        { status: resolved.status },
      );
    }
    const { session, text, source } = resolved;
    void handleInject(session, text, source).catch((err: unknown) => {
      log(`[${session.sid}] self-inject handler threw: ${String(err)}`);
    });
    return Response.json({ ok: true, sid: session.sid });
  }

  /**
   * Emit a context-usage snapshot derived from the JSONL transcript.
   * Called from the tail's onRecord callback whenever a new `usage` row
   * appears. Window auto-upgrades from 200k to 1M the first time a
   * usage row crosses 200k, so both standard and 1m-context sessions
   * render correctly without any client config.
   */
  function emitCtxFromUsage(
    session: SessionState,
    usage: Record<string, unknown>,
  ): void {
    session.lastUsage = usage;
    if (!session.ws) return;
    const input = Number(usage.input_tokens) || 0;
    const creation = Number(usage.cache_creation_input_tokens) || 0;
    const read = Number(usage.cache_read_input_tokens) || 0;
    const tokens = input + creation + read;
    if (tokens <= 0) return;
    if (tokens > session.ctxWindow) {
      // Jump to the next known tier so the bar doesn't overflow.
      session.ctxWindow = tokens > 1_000_000 ? 2_000_000 : 1_000_000;
    }
    const pct = Math.min(100, Math.round((tokens / session.ctxWindow) * 100));
    if (pct === session.lastCtxPct) return;
    session.lastCtxPct = pct;
    const frame: MirrorStatuslineFrame = {
      action: "mirror_statusline",
      sid: session.sid,
      ctx_pct: pct,
      ctx_tokens: tokens,
      ctx_window: session.ctxWindow,
      ts: Date.now(),
    };
    session.ws.send(JSON.stringify(frame));
  }

  async function handleHookPost(req: Request): Promise<Response> {
    let payload: RawHookPayload;
    try {
      payload = (await req.json()) as RawHookPayload;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    lastActivityAt = Date.now();

    const ingested = ingestHook(payload);
    if (!ingested) {
      return new Response("ignored", { status: 202 });
    }

    const sid = ingested.sid;
    let session = sessions.get(sid);
    if (!session) {
      session = await openSession(
        sid,
        ingested.cwd,
        ingested.transcriptPath,
        ingested.tmuxPane,
        ingested.ccPid,
      );
      if (!session) {
        return new Response("hub unavailable", { status: 503 });
      }
    } else {
      if (
        ingested.transcriptPath &&
        session.transcriptPath !== ingested.transcriptPath
      ) {
        session.transcriptPath = ingested.transcriptPath;
        startTailIfNeeded(session);
      }
      // Update tmux pane on each hook — if the user moves panes, we track it.
      if (ingested.tmuxPane && session.tmuxPane !== ingested.tmuxPane) {
        session.tmuxPane = ingested.tmuxPane;
      }
      // The Claude Code PID on an existing sid changes when the user
      // --continues a session under a fresh CC process. Pick it up and
      // re-POST so the hub's rename-join matches the current plugin,
      // not a dead pid from the previous CC. We mutate session.ccPid
      // ONLY on a successful POST — otherwise a transient hub blip
      // would advance local state past the hub's, and the next-hook
      // check below would see them equal and never retry.
      if (
        typeof ingested.ccPid === "number" &&
        Number.isFinite(ingested.ccPid) &&
        session.ccPid !== ingested.ccPid &&
        !session.pendingPidUpdate
      ) {
        const newPid = ingested.ccPid;
        session.pendingPidUpdate = true;
        fetch(`${hubUrl}/api/mirror/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            owner_agent: session.ownerAgent,
            cwd: session.cwd,
            sid: session.sid,
            host: session.host,
            cc_pid: newPid,
          }),
        })
          .then((res) => {
            if (res.ok) session.ccPid = newPid;
          })
          .catch(() => {
            // Best-effort; next hook retries because we left
            // session.ccPid stale.
          })
          .finally(() => {
            session.pendingPidUpdate = false;
          });
      }
    }

    // /clear handling. A fresh session_id arrives for a Claude Code we
    // already had a session for — the user issued /clear (or /compact,
    // which also rotates session_id). The old mirror session never
    // receives another hook, so without an explicit close it sits
    // "open, agent-bound" forever: the hub's orphan sweep skips it
    // because entry.agent is still set, and the dashboard shows it as
    // a permanent gravestone.
    for (const staleSid of findReplacedByClear(
      sessions,
      sid,
      ingested.ccPid,
      ingested.tmuxPane,
    )) {
      const stale = sessions.get(staleSid);
      if (stale) closeSession(stale, "replaced-by-clear");
    }

    // Stop / SubagentStop fire at turn end and carry only the FINAL
    // assistant text block. When the JSONL tail is running for this
    // session we already emit every text block (including the final
    // one), so suppress the hook-sourced duplicate. The hook's arrival
    // is still our "turn ended" signal for the thinking indicator —
    // Stop / SubagentStop ends the turn. The hook's arrival is still
    // the definitive turn-ended signal for the thinking indicator even
    // when we're about to suppress its event (because the JSONL tail
    // already emitted the final text).
    if (ingested.frame.kind === "assistant_message" && session.tail !== null) {
      onTurnEnd(session);
      return new Response("suppressed-tail-active", { status: 202 });
    }

    // Redact before queueing — keeps sensitive content off the hub WS.
    redactor.redactFrame(ingested.frame);
    queueEvent(session, ingested.frame);

    // Permission-prompt follow-up: Claude Code's Notification hook only
    // carries the title ("Claude needs your permission to use Write"),
    // not the numbered menu options. After a beat, scrape them off the
    // tmux pane and emit a second notification so the dashboard banner
    // actually tells the user which digit does what.
    if (
      ingested.frame.kind === "notification" &&
      session.tmuxPane &&
      isPermissionNotification(ingested.frame.payload)
    ) {
      void capturePermissionMenu(session, ingested.frame.payload).catch(
        (err: unknown) => {
          log(`[${session.sid}] capturePermissionMenu threw: ${String(err)}`);
        },
      );
    }

    // Drive the thinking indicator purely off hook transitions.
    if (ingested.frame.kind === "user_prompt") {
      onTurnStart(session);
    } else if (ingested.frame.kind === "tool_call") {
      const payload = ingested.frame.payload as { tool_name?: string };
      const toolName =
        typeof payload?.tool_name === "string" ? payload.tool_name : "tool";
      onToolStart(session, toolName);
    } else if (ingested.frame.kind === "tool_result") {
      onToolEnd(session);
    } else if (
      ingested.frame.kind === "assistant_message" ||
      ingested.frame.kind === "session_end"
    ) {
      onTurnEnd(session);
    }

    // Close on session_end.
    if (ingested.frame.kind === "session_end") {
      closeSession(session, "event");
    }

    return new Response("ok", { status: 202 });
  }

  async function openSession(
    sid: string,
    cwd: string | undefined,
    transcriptPath: string | undefined,
    tmuxPane: string | undefined,
    ccPid: number | undefined,
  ): Promise<SessionState | null> {
    const ownerAgent = deriveOwnerAgent(cwd ?? process.cwd());
    const host = os.hostname() || "host";
    const resolvedPid =
      typeof ccPid === "number" && Number.isFinite(ccPid) ? ccPid : null;
    try {
      const res = await fetch(`${hubUrl}/api/mirror/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_agent: ownerAgent,
          cwd: cwd ?? "",
          sid,
          host,
          cc_pid: resolvedPid,
        }),
      });
      if (!res.ok) {
        log(`session create failed: HTTP ${res.status} ${await res.text()}`);
        return null;
      }
      await res.json().catch(() => ({}));
    } catch (err) {
      log(`session create threw: ${String(err)}`);
      return null;
    }

    const session: SessionState = {
      sid,
      ownerAgent,
      cwd: cwd ?? "",
      host,
      ccPid: resolvedPid,
      transcriptPath: transcriptPath ?? null,
      ws: null,
      seenUuids: new Set(),
      outbox: [],
      tail: null,
      lastEventAt: Date.now(),
      closed: false,
      tmuxPane: tmuxPane ?? null,
      recovering: false,
      ctxWindow: 200_000,
      lastCtxPct: -1,
      lastUsage: null,
      pendingPidUpdate: false,
      apiErrorUuidsPosted: new Set(),
    };
    sessions.set(sid, session);

    attachHubClient(session);
    startTailIfNeeded(session);

    log(`[${sid}] session opened for ${ownerAgent}`);
    return session;
  }

  /**
   * Build + start a HubClient for the session. Replaces any existing
   * client. Called from openSession (first time) and recoverSession
   * (after hub session loss).
   */
  function attachHubClient(session: SessionState): void {
    // Clean up prior client if any.
    if (session.ws) {
      try {
        session.ws.stop();
      } catch {
        // ignore
      }
      session.ws = null;
    }
    const wsUrl = toWsUrl(hubUrl, session.sid);
    const sid = session.sid;
    const client = new HubClient({
      url: wsUrl,
      logPrefix: `claude-net/mirror:${sid}`,
      onOpen: () => {
        // Re-assert the session on the hub every time the WS opens
        // (first connect and every reconnect). Covers sleep-wake, hub
        // restart, orphan auto-close — all the states where the WS
        // handshake succeeds but the hub considers the session dead
        // or closed and silently drops incoming events. createSession
        // is idempotent: existing open sessions no-op, closed ones
        // get reopened, lost ones get re-created with the same sid.
        fetch(`${hubUrl}/api/mirror/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            owner_agent: session.ownerAgent,
            cwd: session.cwd,
            sid: session.sid,
            host: session.host,
            cc_pid: session.ccPid,
          }),
        }).catch(() => {
          // WS onClose will retry; nothing to do here.
        });
        const outbox = session.outbox;
        session.outbox = [];
        for (const frame of outbox) client.send(frame);
        // Fresh hub (e.g. post-restart) has no cached statusline. Re-emit
        // the last known usage so the dashboard's bar lights up on attach
        // instead of waiting for the next assistant turn.
        if (session.lastUsage) {
          session.lastCtxPct = -1; // force re-send
          emitCtxFromUsage(session, session.lastUsage);
        }
      },
      onMessage: (raw) => handleHubMessage(session, raw),
      onClose: (code, reason) => {
        log(`[${sid}] WS closed (${code}) ${reason}`);
        // Any unexpected close (hub restart, eviction, network drop) should
        // trigger recovery: re-register + reconnect. recoverSession's POST
        // is idempotent so it's safe even when the session still exists on
        // the hub. Only skip when the session was intentionally closed or
        // recovery is already running.
        if (!session.closed && !session.recovering) {
          void recoverSession(session).catch((err: unknown) => {
            log(`[${sid}] recovery failed: ${String(err)}`);
          });
        }
      },
      onError: (err) => {
        log(`[${sid}] WS error: ${err.message}`);
      },
    });
    session.ws = client;
    client.start();
  }

  /**
   * Hub lost this session (restart, eviction, etc.). Re-register the same
   * sid with the hub, then reconnect the WS.
   *
   * Retries with exponential backoff (1s → 30s cap, 20 attempts, ~8 min
   * worst case) because the POST can legitimately fail while the hub is
   * still booting after a redeploy.
   */
  async function recoverSession(session: SessionState): Promise<void> {
    session.recovering = true;
    try {
      if (session.ws) {
        try {
          session.ws.stop();
        } catch {
          // ignore
        }
        session.ws = null;
      }

      let delayMs = RECOVERY_INITIAL_DELAY_MS;
      for (let attempt = 1; attempt <= RECOVERY_MAX_ATTEMPTS; attempt++) {
        if (session.closed) return;
        try {
          const res = await fetch(`${hubUrl}/api/mirror/session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner_agent: session.ownerAgent,
              cwd: session.cwd,
              sid: session.sid,
              host: session.host,
              cc_pid: session.ccPid,
            }),
          });
          if (res.ok) {
            log(`[${session.sid}] recovered on hub (attempt ${attempt})`);
            attachHubClient(session);
            return;
          }
          log(
            `[${session.sid}] recovery: HTTP ${res.status} on attempt ${attempt}/${RECOVERY_MAX_ATTEMPTS}; retry in ${delayMs}ms`,
          );
        } catch (err) {
          log(
            `[${session.sid}] recovery: fetch threw on attempt ${attempt}/${RECOVERY_MAX_ATTEMPTS}: ${String(err)}; retry in ${delayMs}ms`,
          );
        }
        if (attempt === RECOVERY_MAX_ATTEMPTS) break;
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, RECOVERY_MAX_DELAY_MS);
      }
      log(
        `[${session.sid}] recovery exhausted after ${RECOVERY_MAX_ATTEMPTS} attempts — session wedged, restart claude-channels to retry`,
      );
    } finally {
      session.recovering = false;
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function startTailIfNeeded(session: SessionState): void {
    if (session.tail || !session.transcriptPath) return;
    session.tail = tailJsonl(session.transcriptPath, {
      onRecord: (rec) => {
        // Track the record's own uuid (dedup against any future uuid
        // overlaps with the hook stream).
        if (typeof rec.uuid === "string") {
          session.seenUuids.add(rec.uuid);
        }
        // Assistant records are the source of truth for assistant text.
        // The Stop hook only delivers the final text block at end-of-turn,
        // so anything Claude wrote before/between tool calls would be
        // missed. The JSONL is written incrementally as Claude generates,
        // with one content-array per turn holding text + tool_use blocks.
        if (
          rec.type === "assistant" &&
          rec.message &&
          typeof rec.message === "object"
        ) {
          const msg = rec.message as {
            content?: unknown;
            usage?: Record<string, unknown>;
          };
          const content = Array.isArray(msg.content) ? msg.content : [];
          for (let i = 0; i < content.length; i++) {
            const block = content[i] as
              | { type?: string; text?: string }
              | undefined;
            if (
              block &&
              block.type === "text" &&
              typeof block.text === "string" &&
              block.text.length > 0
            ) {
              emitAssistantTextFromJsonl(session, rec, i, block.text);
            }
          }
          if (msg.usage && typeof msg.usage === "object") {
            emitCtxFromUsage(session, msg.usage);
          }
        }
        // Detect Claude Code's synthetic API-error assistant records and
        // report them to the hub. Used by the delivery-failure feedback
        // path: when a sender's claude-net message lands on a receiver
        // whose next API call subsequently fails, the hub can route a
        // system notification back to the sender so they know their
        // message wasn't processed end-to-end.
        if (rec.type === "assistant" && isApiErrorRecord(rec)) {
          maybeReportApiError(session, rec).catch((err: unknown) => {
            log(`[${session.sid}] api-error report threw: ${String(err)}`);
          });
        }
      },
      onError: (err) => {
        log(`[${session.sid}] JSONL tail error: ${err.message}`);
      },
    });
  }

  /**
   * POST a CC-side API-error record back to the hub. Dedupes per-uuid in
   * memory (lost on agent restart) and applies a 5-minute recency filter
   * so an agent restart re-reading old JSONL doesn't spam the hub with
   * historical errors. The hub correlates the error to the most recent
   * inbound claude-net message and notifies that sender.
   */
  async function maybeReportApiError(
    session: SessionState,
    rec: Record<string, unknown>,
  ): Promise<void> {
    const uuid = typeof rec.uuid === "string" ? rec.uuid : "";
    if (!uuid) return;
    if (session.apiErrorUuidsPosted.has(uuid)) return;

    const recTs =
      typeof rec.timestamp === "string"
        ? Date.parse(rec.timestamp)
        : Number.NaN;
    const tsMs = Number.isFinite(recTs) ? recTs : Date.now();
    if (Date.now() - tsMs > API_ERROR_RECENCY_MS) return;

    session.apiErrorUuidsPosted.add(uuid);

    const status =
      typeof rec.apiErrorStatus === "number" ? rec.apiErrorStatus : null;
    const text = extractApiErrorText(rec);

    try {
      await fetch(`${hubUrl}/api/mirror/api-error`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sid: session.sid,
          owner_agent: session.ownerAgent,
          uuid,
          status,
          text,
          ts: tsMs,
        }),
      });
    } catch (err) {
      log(`[${session.sid}] api-error POST failed: ${String(err)}`);
    }
  }

  /**
   * Emit a mirror `assistant_message` frame for one text block read out
   * of the JSONL. The uuid is derived from the record's uuid + block
   * index so repeated reads of the same record (e.g. on tail restart)
   * dedup cleanly at `queueEvent`.
   */
  function emitAssistantTextFromJsonl(
    session: SessionState,
    rec: { uuid?: string; timestamp?: string },
    blockIndex: number,
    text: string,
  ): void {
    const baseUuid =
      typeof rec.uuid === "string" && rec.uuid.length > 0
        ? rec.uuid
        : crypto.randomUUID();
    const uuid = `${baseUuid}-text-${blockIndex}`;
    if (session.seenUuids.has(uuid)) return;
    const ts =
      typeof rec.timestamp === "string"
        ? Date.parse(rec.timestamp)
        : Number.NaN;
    const clamped = clampAssistantText(text);
    const frame: MirrorEventFrame = {
      action: "mirror_event",
      sid: session.sid,
      uuid,
      kind: "assistant_message",
      ts: Number.isFinite(ts) ? ts : Date.now(),
      payload: {
        kind: "assistant_message",
        text: clamped.value,
        stop_reason: "",
        ...(clamped.truncated ? { truncated: true } : {}),
      },
    };
    redactor.redactFrame(frame);
    queueEvent(session, frame);
  }

  function queueEvent(session: SessionState, frame: MirrorEventFrame): void {
    if (session.closed) return;
    session.lastEventAt = Date.now();
    if (session.seenUuids.has(frame.uuid)) return;
    session.seenUuids.add(frame.uuid);

    const json = JSON.stringify(frame);
    if (session.ws?.isOpen()) {
      session.ws.send(json);
    } else {
      if (session.outbox.length >= OUTBOX_MAX) {
        // Drop oldest.
        session.outbox.splice(0, session.outbox.length - OUTBOX_MAX + 1);
        log(`[${session.sid}] outbox full — dropping oldest`);
      }
      session.outbox.push(json);
    }
  }

  function handleHubMessage(session: SessionState, raw: string): void {
    let data: {
      event?: string;
      text?: string;
      seq?: number;
      requestId?: string;
      origin?: { watcher?: string };
    };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return;
    }
    if (data.event === "mirror_inject") {
      const text = typeof data.text === "string" ? data.text : "";
      const watcher =
        typeof data.origin?.watcher === "string"
          ? data.origin.watcher
          : "unknown";
      void handleInject(session, text, watcher).catch((err: unknown) => {
        log(`[${session.sid}] inject handler threw: ${String(err)}`);
      });
    } else if (data.event === "mirror_paste") {
      const text = typeof data.text === "string" ? data.text : "";
      const requestId =
        typeof data.requestId === "string" ? data.requestId : "";
      const watcher =
        typeof data.origin?.watcher === "string"
          ? data.origin.watcher
          : "unknown";
      if (!requestId) return;
      void handlePaste(session, requestId, text, watcher).catch(
        (err: unknown) => {
          log(`[${session.sid}] paste handler threw: ${String(err)}`);
          sendPasteResponse(session, requestId, { error: String(err) });
        },
      );
    } else if (data.event === "mirror_list_commands") {
      const requestId =
        typeof data.requestId === "string" ? data.requestId : "";
      if (!requestId) return;
      handleListCommands(session, requestId);
    } else if (data.event === "mirror_history_request") {
      const requestId =
        typeof data.requestId === "string" ? data.requestId : "";
      if (!requestId) return;
      const hist = data as unknown as {
        before_ts?: unknown;
        limit?: unknown;
      };
      const beforeTs =
        typeof hist.before_ts === "number" && Number.isFinite(hist.before_ts)
          ? hist.before_ts
          : null;
      const limit =
        typeof hist.limit === "number" && Number.isFinite(hist.limit)
          ? Math.max(1, Math.min(1000, Math.floor(hist.limit)))
          : 200;
      void handleHistoryRequest(session, requestId, beforeTs, limit).catch(
        (err: unknown) => {
          log(`[${session.sid}] history handler threw: ${String(err)}`);
          sendHistoryChunk(session, requestId, [], true, String(err));
        },
      );
    } else if (data.event === "mirror_stop") {
      const watcher =
        typeof data.origin?.watcher === "string"
          ? data.origin.watcher
          : "unknown";
      void handleStop(session, watcher).catch((err: unknown) => {
        log(`[${session.sid}] stop handler threw: ${String(err)}`);
      });
    }
  }

  async function handlePaste(
    session: SessionState,
    requestId: string,
    text: string,
    watcher: string,
  ): Promise<void> {
    try {
      fs.mkdirSync(PASTE_DIR, { recursive: true, mode: 0o700 });
    } catch (err) {
      sendPasteResponse(session, requestId, {
        error: `Failed to create paste dir: ${String(err)}`,
      });
      return;
    }
    const id = crypto.randomUUID();
    const filePath = path.join(PASTE_DIR, `paste-${id}.txt`);
    try {
      fs.writeFileSync(filePath, text, { mode: 0o600 });
    } catch (err) {
      sendPasteResponse(session, requestId, {
        error: `Failed to write paste file: ${String(err)}`,
      });
      return;
    }
    // Happy-path audit suppressed: the user initiated the paste from the
    // dashboard, the response carries the path, and the live transcript
    // shows whatever Claude does with it. The line was just noise.
    sendPasteResponse(session, requestId, { path: filePath });
  }

  /** Handle a hub-initiated history-backfill request: read up to `limit`
   *  records from the on-disk JSONL strictly older than `beforeTs`,
   *  convert them to history_text MirrorEventFrames, and reply with a
   *  chunk frame. */
  async function handleHistoryRequest(
    session: SessionState,
    requestId: string,
    beforeTs: number | null,
    limit: number,
  ): Promise<void> {
    const transcriptPath = session.transcriptPath;
    if (!transcriptPath) {
      sendHistoryChunk(
        session,
        requestId,
        [],
        true,
        "transcript_path unknown for this session",
      );
      return;
    }
    const result = await readHistoryBefore(transcriptPath, beforeTs, limit);
    const frames: MirrorEventFrame[] = [];
    for (const rec of result.records) {
      const frame = jsonlRecordToHistoryFrame(session.sid, rec);
      if (frame) {
        redactor.redactFrame(frame);
        frames.push(frame);
      }
    }
    sendHistoryChunk(session, requestId, frames, result.exhausted);
  }

  function sendHistoryChunk(
    session: SessionState,
    requestId: string,
    frames: MirrorEventFrame[],
    exhausted: boolean,
    error?: string,
  ): void {
    const frame = {
      action: "mirror_history_chunk" as const,
      sid: session.sid,
      requestId,
      frames,
      exhausted,
      ...(error ? { error } : {}),
    };
    if (!session.ws || !session.ws.send(JSON.stringify(frame))) {
      log(`[${session.sid}] failed to send history chunk (hub disconnected)`);
    }
  }

  function sendPasteResponse(
    session: SessionState,
    requestId: string,
    result: { path?: string; error?: string },
  ): void {
    const frame = {
      action: "mirror_paste_done" as const,
      sid: session.sid,
      requestId,
      ...(result.path ? { path: result.path } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    if (!session.ws || !session.ws.send(JSON.stringify(frame))) {
      log(`[${session.sid}] failed to send paste ack (hub disconnected)`);
    }
  }

  /** Handle a hub-initiated stop: send Escape to the session's tmux
   *  pane, emit an audit event so watchers see it in the transcript. */
  async function handleStop(
    session: SessionState,
    watcher: string,
  ): Promise<void> {
    if (!session.tmuxPane) {
      emitAuditEvent(
        session,
        "stop rejected: session is not running inside tmux",
      );
      return;
    }
    const result = await injector.sendEscape(session.tmuxPane);
    if (!result.ok) {
      emitAuditEvent(session, `stop failed (${result.code}): ${result.error}`);
      return;
    }
    // Happy-path audit suppressed — user clicked Stop, Esc was sent;
    // the next transcript event already reflects the interrupt.
  }

  /** Respond to a hub-initiated slash-command catalog query. Scans the
   *  .claude/ trees for this session's cwd and replies with the list. */
  function handleListCommands(session: SessionState, requestId: string): void {
    let commands: ReturnType<typeof scanCommands>;
    try {
      commands = scanCommands(session.cwd);
    } catch (err) {
      const errFrame = {
        action: "mirror_commands_done" as const,
        sid: session.sid,
        requestId,
        error: `scan failed: ${String(err)}`,
      };
      if (session.ws) session.ws.send(JSON.stringify(errFrame));
      return;
    }
    const frame = {
      action: "mirror_commands_done" as const,
      sid: session.sid,
      requestId,
      commands,
    };
    if (!session.ws || !session.ws.send(JSON.stringify(frame))) {
      log(`[${session.sid}] failed to send commands ack (hub disconnected)`);
    }
  }

  async function handleInject(
    session: SessionState,
    text: string,
    watcher: string,
  ): Promise<void> {
    if (!session.tmuxPane) {
      emitAuditEvent(
        session,
        "inject rejected: session is not running inside tmux (no pane recorded)",
      );
      return;
    }
    const result = await injector.inject(session.sid, session.tmuxPane, text);
    if (!result.ok) {
      // Append the dropped prompt so the user can copy it back into the
      // compose box without retyping. The inject cap upstream is 512 KB
      // (MAX_INJECT_BYTES), so the worst-case audit payload is bounded.
      emitAuditEvent(
        session,
        `inject failed (${result.code}): ${result.error}\n\n--- dropped prompt (copy to retry) ---\n${text}`,
      );
      return;
    }
    // Happy-path audit suppressed: the user just typed the text into
    // the compose box; echoing a preview here was pure repetition.
    // Failure-path audits below still emit so transmit issues surface.
    // Claude Code prints TUI-level rejections ("Unknown command:", "Args
    // from unknown skill:") directly to the pane without emitting a hook
    // event. Capture the pane after it's had time to redraw and forward
    // any such lines as a notification so the web watcher sees them.
    void postInjectRejectionCheck(session).catch((err: unknown) => {
      log(`[${session.sid}] post-inject check threw: ${String(err)}`);
    });
  }

  async function postInjectRejectionCheck(
    session: SessionState,
  ): Promise<void> {
    if (!session.tmuxPane) return;
    // Wait long enough for Claude Code to redraw but short enough that
    // the rejection line is near the bottom of what we capture.
    await sleep(800);
    const cap = await injector.capturePane(session.tmuxPane, 30);
    if (!cap.ok) return;
    const lines = cap.output.split("\n").slice(-30);
    const rejectionRx =
      /^\s*(?:❯\s+)?(Unknown command:.*|Args from unknown (?:skill|command):.*|Error: .*)$/;
    const matches: string[] = [];
    for (const line of lines) {
      const m = line.match(rejectionRx);
      if (m?.[1]) matches.push(m[1].trim());
    }
    if (matches.length === 0) return;
    emitAuditEvent(session, `tmux pane reported: ${matches.join(" · ")}`);
  }

  function isPermissionNotification(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const text =
      typeof (payload as { text?: unknown }).text === "string"
        ? (payload as { text: string }).text
        : "";
    if (!text) return false;
    // Keep in sync with PROMPT_RE in dashboard.html.
    return /permission|approval|allow|needs your|waiting for input/i.test(text);
  }

  /**
   * Claude Code's Notification hook fires BEFORE the modal text is
   * drawn and only carries the title, so the numbered menu options
   * (1. Yes / 2. Yes, always / 3. No …) never reach the dashboard.
   * After a short delay we capture the pane, extract any numbered
   * menu rows, and emit a second notification carrying them. The
   * dashboard's banner picks up the later (richer) notification
   * because it still matches the permission regex.
   */
  async function capturePermissionMenu(
    session: SessionState,
    payload: unknown,
  ): Promise<void> {
    if (!session.tmuxPane) return;
    const original =
      payload && typeof payload === "object" && "text" in payload
        ? String((payload as { text?: unknown }).text ?? "")
        : "";
    await sleep(600);
    const cap = await injector.capturePane(session.tmuxPane, 40);
    if (!cap.ok) return;
    // Strip box-drawing chars only at line start/end so option text
    // containing > or | is not mangled.
    const boxRx = /^[│┃┆╎╌╍┄┅─━╭╮╰╯╷╵╴╶❯>|\s]+|[│┃┆╎╌╍┄┅─━╭╮╰╯╷╵╴╶\s]+$/g;
    // Support up to two-digit option numbers (10+ option menus).
    const menuRx = /^\s*(\d{1,2})\.\s+(.+?)\s*$/;
    const menu: string[] = [];
    const seen = new Set<string>();
    for (const raw of cap.output.split("\n")) {
      const cleaned = raw.replace(boxRx, "").trimEnd();
      const m = cleaned.match(menuRx);
      if (!m?.[1] || !m[2]) continue;
      const key = `${m[1]}|${m[2].trim()}`;
      if (seen.has(key)) continue; // modal sometimes renders twice
      seen.add(key);
      menu.push(`${m[1]}. ${m[2].trim()}`);
    }
    if (menu.length === 0) return;
    const augmented = `${original}\n\n${menu.join("\n")}`;
    const frame: MirrorEventFrame = {
      action: "mirror_event",
      sid: session.sid,
      uuid: crypto.randomUUID(),
      kind: "notification",
      ts: Date.now(),
      payload: { kind: "notification", text: augmented },
    };
    queueEvent(session, frame);
  }

  // ── Thinking indicator ──────────────────────────────────────────────
  // Hook-driven. A turn begins on UserPromptSubmit (→ user_prompt),
  // runs through any number of PreToolUse/PostToolUse pairs
  // (→ tool_call / tool_result), and ends on Stop/SubagentStop
  // (→ assistant_message hook) or session_end. We emit a
  // `mirror_thinking` frame on each state transition carrying the
  // turn's start timestamp and the currently-running tool name (if
  // any); the dashboard ticks the elapsed-seconds counter client-side.
  const turnState = new Map<
    string,
    { startedAt: number; currentTool: string | null }
  >();

  function onTurnStart(session: SessionState): void {
    const state = { startedAt: Date.now(), currentTool: null as string | null };
    turnState.set(session.sid, state);
    emitThinkingFrame(session, {
      active: true,
      startedAt: state.startedAt,
      tool: null,
    });
  }

  function onToolStart(session: SessionState, toolName: string): void {
    const state = turnState.get(session.sid);
    if (!state) return;
    state.currentTool = toolName;
    emitThinkingFrame(session, {
      active: true,
      startedAt: state.startedAt,
      tool: toolName,
    });
  }

  function onToolEnd(session: SessionState): void {
    const state = turnState.get(session.sid);
    if (!state) return;
    state.currentTool = null;
    emitThinkingFrame(session, {
      active: true,
      startedAt: state.startedAt,
      tool: null,
    });
  }

  function onTurnEnd(session: SessionState): void {
    if (!turnState.has(session.sid)) return;
    turnState.delete(session.sid);
    emitThinkingFrame(session, { active: false });
  }

  function emitThinkingFrame(
    session: SessionState,
    payload: {
      active: boolean;
      startedAt?: number;
      tool?: string | null;
    },
  ): void {
    if (!session.ws) return;
    const frame = {
      action: "mirror_thinking" as const,
      sid: session.sid,
      active: payload.active,
      ...(payload.startedAt !== undefined
        ? { startedAt: payload.startedAt }
        : {}),
      ...(payload.tool !== undefined ? { tool: payload.tool } : {}),
    };
    session.ws.send(JSON.stringify(frame));
  }

  function emitAuditEvent(session: SessionState, text: string): void {
    const frame = {
      action: "mirror_event" as const,
      sid: session.sid,
      uuid: crypto.randomUUID(),
      kind: "notification" as const,
      ts: Date.now(),
      payload: {
        kind: "notification" as const,
        text,
        source: "mirror-agent",
      },
    };
    queueEvent(session, frame);
  }

  function closeSession(session: SessionState, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    log(`[${session.sid}] closing (${reason})`);
    // Clear any open turn-state BEFORE nulling session.ws so the final
    // active:false frame can still go out.
    onTurnEnd(session);
    if (session.tail) {
      session.tail.stop();
      session.tail = null;
    }
    if (session.ws) {
      session.ws.stop();
      session.ws = null;
    }
    // Fire-and-forget hub close.
    const url = `${hubUrl}/api/mirror/${encodeURIComponent(session.sid)}/close`;
    fetch(url, { method: "POST" }).catch(() => {
      /* best effort */
    });
    sessions.delete(session.sid);
  }

  async function stop(): Promise<void> {
    clearInterval(idleTimer);
    hostChannel.stop();
    for (const s of [...sessions.values()]) {
      closeSession(s, "shutdown");
    }
    // Log redactor stats so users can gauge how often rules fired. We log
    // aggregate counts only — never any matched content.
    const stats = redactor.stats;
    const entries = Object.entries(stats);
    if (entries.length > 0) {
      const summary = entries
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v}×${k}`)
        .join(", ");
      log(`redactor hit totals: ${summary}`);
    }
    writeSentinelFile(stateDir);
    server.stop();
    removePortFile(stateDir);
  }

  return {
    port: server.port,
    stop,
    sessions,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function toWsUrl(hubUrl: string, sid: string): string {
  const wsBase = hubUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}/ws/mirror/${encodeURIComponent(sid)}?as=agent`;
}

/**
 * Identify sessions that should be closed because a fresh session_id
 * has arrived for the same Claude Code process — the user issued
 * /clear (or /compact, which also rotates session_id). Without the
 * explicit close, the old session sits "open, agent-bound" forever
 * because the per-session WS stays attached even though no further
 * hooks will ever target the old sid.
 *
 * Two identity signals, tried in order:
 *   1. ccPid — strongest signal. Each Claude Code is one OS process;
 *      fork-session siblings have distinct ccPids; --continue keeps
 *      the same session_id so no rotation happens.
 *   2. tmuxPane — fallback for hosts whose hook wrapper doesn't
 *      inject CC_PID (pre-rollout clients), or for sessions whose
 *      ccPid was never recorded.
 *
 * Exported pure for unit-testability — the real handler iterates the
 * returned sids and calls closeSession on each.
 */
export interface ClearReplaceCandidate {
  sid: string;
  ccPid: number | null;
  tmuxPane: string | null;
  closed: boolean;
}

export function findReplacedByClear(
  sessions:
    | Iterable<ClearReplaceCandidate>
    | Map<string, ClearReplaceCandidate>,
  incomingSid: string,
  incomingCcPid: number | undefined,
  incomingTmuxPane: string | null | undefined,
): string[] {
  const iter = sessions instanceof Map ? sessions.values() : sessions;
  const victims: string[] = [];
  const ccPidUsable =
    typeof incomingCcPid === "number" && Number.isFinite(incomingCcPid);
  for (const s of iter) {
    if (s.closed) continue;
    if (s.sid === incomingSid) continue;
    const matchByPid = ccPidUsable && s.ccPid === incomingCcPid;
    const matchByPane = !!incomingTmuxPane && s.tmuxPane === incomingTmuxPane;
    if (matchByPid || matchByPane) {
      victims.push(s.sid);
    }
  }
  return victims;
}

/**
 * Claude Code writes "synthetic" assistant records into the JSONL
 * transcript when an upstream Anthropic API call fails. They carry
 * `type: "assistant"`, `isApiErrorMessage: true`, and an `apiErrorStatus`
 * number alongside a single text block describing the error. This is the
 * structured marker the mirror-agent uses to detect downstream failures
 * without parsing free-form text.
 */
export function isApiErrorRecord(rec: Record<string, unknown>): boolean {
  return rec.isApiErrorMessage === true;
}

/**
 * Pull a human-readable error string out of an isApiErrorMessage record.
 * Falls back through the documented fields (`message.content[0].text` →
 * `error` → empty string) so the hub always has something useful to
 * include in the system notification it routes back to the sender.
 */
export function extractApiErrorText(rec: Record<string, unknown>): string {
  const message = rec.message as { content?: unknown } | undefined;
  if (message && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: string }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
  }
  if (typeof rec.error === "string") return rec.error;
  return "";
}

function deriveOwnerAgent(cwd: string): string {
  const session = path.basename(cwd || ".") || "session";
  const user = os.userInfo().username || process.env.USER || "user";
  const host = os.hostname() || "host";
  return `${session}:${user}@${host}`;
}

/**
 * Structural shape of the candidate sessions resolveSelfInject inspects.
 * Defined narrowly so this helper can be unit-tested against a tiny
 * fixture instead of needing a full SessionState.
 */
export interface SelfInjectSessionCandidate {
  sid: string;
  ccPid: number | null;
  closed: boolean;
  tmuxPane: string | null;
}

export type SelfInjectResolution<S> =
  | { session: S; text: string; source: string }
  | { error: string; status: number };

/**
 * Validate a /inject POST body and resolve it to a session. Pure: takes
 * the parsed JSON and a sessions map, returns either the matched
 * session + sanitized fields or a structured error with HTTP status.
 *
 * Lookup order: explicit sid wins over ccPid (the latter is the
 * convenience path for the self-inject CLI which only knows its own pid).
 */
export function resolveSelfInject<S extends SelfInjectSessionCandidate>(
  raw: unknown,
  sessions: Iterable<S> | Map<string, S>,
  maxBytes: number,
): SelfInjectResolution<S> {
  if (!raw || typeof raw !== "object") {
    return { error: "bad json", status: 400 };
  }
  const body = raw as Record<string, unknown>;
  const text = typeof body.text === "string" ? body.text : "";
  if (!text) return { error: "missing text", status: 400 };
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { error: `text exceeds ${maxBytes} bytes`, status: 413 };
  }
  const sid = typeof body.sid === "string" && body.sid ? body.sid : undefined;
  const ccPid =
    typeof body.ccPid === "number" && Number.isFinite(body.ccPid)
      ? body.ccPid
      : undefined;
  if (!sid && ccPid === undefined) {
    return { error: "missing sid or ccPid", status: 400 };
  }
  const source =
    typeof body.source === "string" && body.source ? body.source : "self";

  let match: S | undefined;
  if (sid) {
    if (sessions instanceof Map) {
      match = sessions.get(sid);
    } else {
      for (const s of sessions)
        if (s.sid === sid) {
          match = s;
          break;
        }
    }
  } else {
    const it: Iterable<S> =
      sessions instanceof Map ? sessions.values() : sessions;
    for (const s of it) {
      if (!s.closed && s.ccPid === ccPid) {
        match = s;
        break;
      }
    }
  }
  if (!match) return { error: "no matching session", status: 404 };
  if (match.closed) return { error: "session closed", status: 410 };
  if (!match.tmuxPane) {
    return { error: "session not running inside tmux", status: 409 };
  }
  return { session: match, text, source };
}

function portFilePath(stateDir: string): string {
  const uid = process.getuid?.() ?? 0;
  return path.join(stateDir, `mirror-agent-${uid}.port`);
}

function writePortFile(stateDir: string, port: number): void {
  try {
    fs.writeFileSync(portFilePath(stateDir), String(port), { mode: 0o600 });
  } catch (err) {
    log(`Failed to write port file: ${String(err)}`);
  }
}

function removePortFile(stateDir: string): void {
  try {
    fs.unlinkSync(portFilePath(stateDir));
  } catch {
    // ignore
  }
}

/**
 * Periodic singleton check called from inside a running daemon. If the
 * port file is owned by a DIFFERENT, healthy peer, this process exits
 * (we are the duplicate). If the port file is missing or stale or
 * already names this process, do nothing.
 *
 * Designed to converge the multi-daemon-zombie state that predates the
 * startup singleton guard: existing duplicates die off naturally as
 * each detects the registered owner on its next 30s tick.
 */
export async function evictIfPeerOwnsPortFile(
  myPort: number,
  stateDir: string,
  fetchImpl: typeof fetch = fetch,
  exit: (code: number) => never = process.exit,
): Promise<void> {
  const portFile = portFilePath(stateDir);
  let registeredPort: number | null = null;
  try {
    const raw = fs.readFileSync(portFile, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) registeredPort = parsed;
  } catch {
    return; // file missing — no peer to defer to
  }
  if (registeredPort === null || registeredPort === myPort) return;
  // Different port registered — see if it's healthy.
  try {
    const res = await fetchImpl(`http://127.0.0.1:${registeredPort}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      process.stderr.write(
        `[claude-net/mirror] [singleton] peer on port ${registeredPort} is healthy; exiting (my port ${myPort})\n`,
      );
      exit(0);
    }
  } catch {
    // Peer unreachable — leave the port file alone; the next startup
    // singleton check on someone else will deal with reclaiming it.
  }
}

/**
 * Checks whether an existing mirror-agent daemon is running and healthy.
 * Returns the port if a peer responds 200 on /health; null otherwise. A
 * stale port file (file present, peer unreachable) is removed as a side
 * effect so the caller can write a fresh one.
 *
 * Used as a singleton guard at startup: when /setup or install-channels
 * pkills mirror-agents, every claude-channels watchdog (one per Claude
 * Code session) detects the kill and racingly respawns. The bash spawn
 * lock catches most of that, but this check defends against the corner
 * cases (manual `bun mirror-agent.bundle.js`, hosts without flock).
 */
export async function checkExistingDaemon(
  stateDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ healthy: boolean; port: number | null }> {
  const portFile = portFilePath(stateDir);
  let port: number | null = null;
  try {
    const raw = fs.readFileSync(portFile, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) port = parsed;
  } catch {
    return { healthy: false, port: null };
  }
  if (port === null) {
    try {
      fs.unlinkSync(portFile);
    } catch {
      // ignore
    }
    return { healthy: false, port: null };
  }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) return { healthy: true, port };
  } catch {
    // unreachable — peer is dead
  }
  try {
    fs.unlinkSync(portFile);
  } catch {
    // ignore
  }
  return { healthy: false, port };
}

function writeSentinelFile(stateDir: string): void {
  const uid = process.getuid?.() ?? 0;
  const sentinel = path.join(stateDir, `mirror-agent-${uid}.stopped`);
  try {
    fs.writeFileSync(sentinel, new Date().toISOString(), { mode: 0o600 });
  } catch {
    // ignore
  }
}

function removeSentinelFile(stateDir: string): void {
  const uid = process.getuid?.() ?? 0;
  const sentinel = path.join(stateDir, `mirror-agent-${uid}.stopped`);
  try {
    fs.unlinkSync(sentinel);
  } catch {
    // ignore
  }
}

function log(msg: string): void {
  process.stderr.write(`[claude-net/mirror] ${msg}\n`);
}

// ── Self-inject CLI (subcommand of the mirror-agent entry) ────────────────
//
// `claude-net-mirror-agent inject [--sid SID|--pid PID] [--source NAME] <text>`
// reads the port file written by the running daemon, walks the process tree
// to find the calling Claude Code's pid, and POSTs to /inject. Exit codes:
//   0 success, 2 unreachable, 3 no matching session,
//   4 bad arguments, 5 inject rejected (closed, not in tmux, etc.)

interface InjectCliArgs {
  sid: string | null;
  pid: number | null;
  source: string | null;
  text: string | null;
  help: boolean;
}

export function parseInjectCliArgs(
  argv: string[],
): InjectCliArgs | { error: string } {
  const out: InjectCliArgs = {
    sid: null,
    pid: null,
    source: null,
    text: null,
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--sid") {
      const v = argv[++i];
      if (!v) return { error: "--sid requires a value" };
      out.sid = v;
      continue;
    }
    if (a === "--pid") {
      const v = argv[++i];
      if (!v) return { error: "--pid requires a value" };
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `--pid must be a positive integer, got '${v}'` };
      }
      out.pid = n;
      continue;
    }
    if (a === "--source") {
      const v = argv[++i];
      if (!v) return { error: "--source requires a value" };
      out.source = v;
      continue;
    }
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a?.startsWith("-")) {
      return { error: `unknown flag: ${a}` };
    }
    if (a !== undefined) positional.push(a);
  }
  if (positional.length > 0) out.text = positional.join(" ");
  return out;
}

const INJECT_CLI_USAGE = [
  "claude-net-mirror-agent inject — queue text at the calling session's prompt",
  "",
  "Usage:",
  "  claude-net-mirror-agent inject [--sid SID|--pid PID] [--source NAME] <text>",
  "  echo <text> | claude-net-mirror-agent inject [--sid SID|--pid PID]",
  "",
  "Without --sid/--pid, walks the process tree to find Claude Code and",
  "targets the session bound to that pid.",
].join("\n");

// NUL (\x00) is the field separator in /proc/PID/cmdline on Linux —
// argv[0] ends in NUL, not whitespace. The control-char is intentional.
const CC_BINARY_PATTERN = (() => {
  const src =
    process.env.CLAUDE_NET_CC_BINARY_PATTERN ??
    "\\/claude-patched(?:\\x00|\\s|$)";
  try {
    return new RegExp(src);
  } catch {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is the /proc/PID/cmdline field separator
    return /\/claude-patched(?:\x00|\s|$)/;
  }
})();

/**
 * Walk up the process tree to find Claude Code's pid. Mirrors the
 * resolution in bin/claude-net-mirror-push so both paths agree on
 * "which CC process owns me".
 */
function resolveCallingCcPid(): number | null {
  let pid = process.ppid;
  for (let i = 0; i < 6; i++) {
    const info = readProcessInfo(pid);
    if (CC_BINARY_PATTERN.test(info.cmdline)) return pid;
    if (!info.ppid || info.ppid <= 1) break;
    pid = info.ppid;
  }
  return null;
}

function readProcessInfo(pid: number): { ppid: number; cmdline: string } {
  if (process.platform === "linux") {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^PPid:\s*(\d+)/m);
      return {
        ppid: m?.[1] ? Number.parseInt(m[1], 10) : 0,
        cmdline,
      };
    } catch {
      return { ppid: 0, cmdline: "" };
    }
  }
  try {
    const result = Bun.spawnSync({
      cmd: ["ps", "-o", "ppid=,command=", "-p", String(pid)],
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = new TextDecoder().decode(result.stdout).trim();
    const m = out.match(/^\s*(\d+)\s+(.*)$/);
    if (!m?.[1]) return { ppid: 0, cmdline: "" };
    return {
      ppid: Number.parseInt(m[1], 10),
      cmdline: m[2] ?? "",
    };
  } catch {
    return { ppid: 0, cmdline: "" };
  }
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.from(chunk as Uint8Array),
      );
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
}

export async function runInjectCli(argv: string[]): Promise<number> {
  const parsed = parseInjectCliArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n${INJECT_CLI_USAGE}\n`);
    return 4;
  }
  if (parsed.help) {
    process.stdout.write(`${INJECT_CLI_USAGE}\n`);
    return 0;
  }

  let text = parsed.text;
  if (text === null) text = (await readStdinText()).trimEnd();
  if (!text) {
    process.stderr.write(`error: no text to inject\n\n${INJECT_CLI_USAGE}\n`);
    return 4;
  }

  const uid = process.getuid?.() ?? 0;
  const portFile = `/tmp/claude-net/mirror-agent-${uid}.port`;
  let port: number;
  try {
    const raw = fs.readFileSync(portFile, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error("bad port");
    port = n;
  } catch {
    process.stderr.write(
      "error: mirror-agent not running (port file missing)\n",
    );
    return 2;
  }

  const body: Record<string, unknown> = { text };
  if (parsed.source) body.source = parsed.source;
  if (parsed.sid) {
    body.sid = parsed.sid;
  } else if (parsed.pid !== null) {
    body.ccPid = parsed.pid;
  } else {
    const pid = resolveCallingCcPid();
    if (pid === null) {
      process.stderr.write(
        "error: could not resolve Claude Code pid from process tree; pass --sid or --pid explicitly\n",
      );
      return 3;
    }
    body.ccPid = pid;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.ok) return 0;
    const txt = await res
      .text()
      .then((s) => s.trim())
      .catch(() => "");
    process.stderr.write(`error: ${res.status} ${txt}\n`);
    if (res.status === 404) return 3;
    if (res.status === 409 || res.status === 410) return 5;
    return 5;
  } catch (err) {
    process.stderr.write(`error: ${String(err)}\n`);
    return 2;
  } finally {
    clearTimeout(timer);
  }
}

// ── Run when invoked directly ─────────────────────────────────────────────

if (import.meta.main) {
  // Subcommand dispatch — `claude-net-mirror-agent inject ...` routes to
  // the loopback inject client; no subcommand falls through to daemon mode.
  if (process.argv[2] === "inject") {
    const code = await runInjectCli(process.argv.slice(3));
    process.exit(code);
  }
  const hub = process.env.CLAUDE_NET_HUB || "http://localhost:4815";
  const portEnv = process.env.CLAUDE_NET_MIRROR_AGENT_PORT;
  const bindPort = portEnv ? Number.parseInt(portEnv, 10) || 0 : 0;
  const uid = process.getuid?.() ?? 0;
  const stateDir = "/tmp/claude-net";
  const logPath = `${stateDir}/mirror-agent-${uid}.log`;

  function writeCrashRecord(kind: string, err: unknown): void {
    const record = {
      kind,
      ts: new Date().toISOString(),
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? (err.stack ?? "") : "",
    };
    try {
      fs.appendFileSync(
        logPath,
        `[claude-net/mirror] CRASH ${JSON.stringify(record)}\n`,
      );
    } catch {
      // nowhere left to report
    }
  }

  function notifyCrashToHub(record: Record<string, unknown>): void {
    try {
      let hostId: string;
      try {
        hostId = `${os.userInfo().username}@${os.hostname()}`;
      } catch {
        hostId = "unknown@unknown";
      }
      const hubUrl = hub.replace(/\/$/, "");
      const body = JSON.stringify({
        host_id: hostId,
        ...record,
      });
      // Bun has no synchronous fetch; pipe body via stdin to avoid exposing
      // stack traces in the process argv (visible in /proc on Linux).
      // stdin must be a Buffer/Uint8Array — Bun.spawnSync rejects a plain string.
      Bun.spawnSync(
        [
          "curl",
          "-fsS",
          "-m",
          "2",
          "-H",
          "content-type: application/json",
          "--data-binary",
          "@-",
          `${hubUrl}/api/mirror/agent-crash`,
        ],
        { stdin: Buffer.from(body), stdout: "ignore", stderr: "ignore" },
      );
    } catch {
      // best-effort only
    }
  }

  process.on("uncaughtException", (err: Error) => {
    writeCrashRecord("uncaughtException", err);
    // Sync hub notification omitted: process is in unknown state after an
    // uncaught exception; blocking on a curl fork risks hangs. The watchdog
    // will respawn and the agent-log endpoint exposes the crash record.
    process.exit(1);
  });

  // unhandledRejection: log and notify but keep running — a stray rejected
  // promise is rarely fatal and killing the whole agent is too drastic.
  // uncaughtException (above) still exits because a synchronous throw that
  // escapes the event loop genuinely leaves the process in unknown state.
  process.on("unhandledRejection", (reason: unknown) => {
    const record = {
      kind: "unhandledRejection",
      ts: new Date().toISOString(),
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? (reason.stack ?? "") : "",
    };
    writeCrashRecord("unhandledRejection", reason);
    notifyCrashToHub(record);
  });

  (async () => {
    // Singleton guard: exit cleanly if a healthy peer already owns the
    // port file. Layer-1 (bash flock in claude-channels) prevents most
    // races; this catches the rest (hosts without flock, manual launches).
    const peer = await checkExistingDaemon(stateDir);
    if (peer.healthy && peer.port !== null) {
      log(`existing daemon healthy on port ${peer.port}; exiting cleanly`);
      process.exit(0);
    }
    try {
      await startAgent({ hubUrl: hub, bindPort });
    } catch (err) {
      writeCrashRecord("startupError", err);
      process.stderr.write(
        `[claude-net/mirror] startup failed: ${String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}
