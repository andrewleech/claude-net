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

/** Recovery retry schedule. Hub redeploys typically take 10–30 s so the
 *  worst-case ~8 min window here covers nearly anything short of total
 *  hub failure. */
const RECOVERY_INITIAL_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 30_000;
const RECOVERY_MAX_ATTEMPTS = 20;

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
  // (in Phase B) accepts ls/mkdir/launch RPCs. Phase A is fire-and-forget:
  // the channel re-connects on its own; failures don't block the daemon.
  const hostChannel: HostChannelHandle = startHostChannel({
    hubUrl,
    getRecentCwds: () =>
      [...sessions.values()]
        .filter((s) => s.cwd)
        .sort((a, b) => b.lastEventAt - a.lastEventAt)
        .map((s) => s.cwd),
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
    // Process-level idle shutdown.
    if (
      idleShutdownMs > 0 &&
      sessions.size === 0 &&
      now - lastActivityAt > idleShutdownMs
    ) {
      log("idle shutdown");
      void stop();
    }
  }, 30_000);
  if (typeof idleTimer === "object" && "unref" in idleTimer) {
    idleTimer.unref();
  }

  async function handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/hook") {
      return handleHookPost(req);
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

    // /clear handling. If any OTHER session shares this one's tmux pane
    // it's a stale mirror from before a /clear — same claude process,
    // new session_id — and every inject aimed at the stale sid would
    // actually land in the current pane, confusing users. Close them.
    if (ingested.tmuxPane) {
      for (const other of sessions.values()) {
        if (
          other.sid !== sid &&
          !other.closed &&
          other.tmuxPane === ingested.tmuxPane
        ) {
          closeSession(other, "replaced-by-clear");
        }
      }
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
      },
      onError: (err) => {
        log(`[${session.sid}] JSONL tail error: ${err.message}`);
      },
    });
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
      emitAuditEvent(
        session,
        `inject failed (${result.code}): ${result.error}`,
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

function deriveOwnerAgent(cwd: string): string {
  const session = path.basename(cwd || ".") || "session";
  const user = os.userInfo().username || process.env.USER || "user";
  const host = os.hostname() || "host";
  return `${session}:${user}@${host}`;
}

function writePortFile(stateDir: string, port: number): void {
  const uid = process.getuid?.() ?? 0;
  const portFile = path.join(stateDir, `mirror-agent-${uid}.port`);
  try {
    fs.writeFileSync(portFile, String(port), { mode: 0o600 });
  } catch (err) {
    log(`Failed to write port file: ${String(err)}`);
  }
}

function removePortFile(stateDir: string): void {
  const uid = process.getuid?.() ?? 0;
  const portFile = path.join(stateDir, `mirror-agent-${uid}.port`);
  try {
    fs.unlinkSync(portFile);
  } catch {
    // ignore
  }
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

// ── Run when invoked directly ─────────────────────────────────────────────

if (import.meta.main) {
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

  startAgent({ hubUrl: hub, bindPort }).catch((err: unknown) => {
    writeCrashRecord("startupError", err);
    process.stderr.write(
      `[claude-net/mirror] startup failed: ${String(err)}\n`,
    );
    process.exit(1);
  });
}
