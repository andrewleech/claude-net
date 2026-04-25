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
import type { MirrorEventFrame } from "@/shared/types";
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
}

export interface AgentHandle {
  port: number;
  stop(): Promise<void>;
  sessions: Map<string, SessionState>;
}

// ── Entry point ───────────────────────────────────────────────────────────

const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
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
  ): Promise<SessionState | null> {
    const ownerAgent = deriveOwnerAgent(cwd ?? process.cwd());
    try {
      const res = await fetch(`${hubUrl}/api/mirror/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_agent: ownerAgent, cwd: cwd ?? "", sid }),
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
      transcriptPath: transcriptPath ?? null,
      ws: null,
      seenUuids: new Set(),
      outbox: [],
      tail: null,
      lastEventAt: Date.now(),
      closed: false,
      tmuxPane: tmuxPane ?? null,
      recovering: false,
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
          }),
        }).catch(() => {
          // WS onClose will retry; nothing to do here.
        });
        const outbox = session.outbox;
        session.outbox = [];
        for (const frame of outbox) client.send(frame);
      },
      onMessage: (raw) => handleHubMessage(session, raw),
      onClose: (code, reason) => {
        log(`[${sid}] WS closed (${code}) ${reason}`);
        // Hub lost our session (restart, eviction, etc.). Re-register
        // the same sid so the hub recreates the entry and we can
        // reconnect; auto-reconnecting blindly would loop forever
        // against a 404.
        if (
          code === 1008 &&
          reason.includes("not found") &&
          !session.closed &&
          !session.recovering
        ) {
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
          const msg = rec.message as { content?: unknown };
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
        before_uuid?: unknown;
        limit?: unknown;
      };
      const beforeUuid =
        typeof hist.before_uuid === "string" ? hist.before_uuid : null;
      const limit =
        typeof hist.limit === "number" && Number.isFinite(hist.limit)
          ? Math.max(1, Math.min(1000, Math.floor(hist.limit)))
          : 200;
      void handleHistoryRequest(session, requestId, beforeUuid, limit).catch(
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
    emitAuditEvent(
      session,
      `paste from ${watcher}: saved ${Buffer.byteLength(text, "utf8")} bytes → ${filePath}`,
    );
    sendPasteResponse(session, requestId, { path: filePath });
  }

  /** Handle a hub-initiated history-backfill request: read up to `limit`
   *  records from the on-disk JSONL preceding `beforeUuid`, convert them
   *  to history_text MirrorEventFrames, and reply with a chunk frame. */
  async function handleHistoryRequest(
    session: SessionState,
    requestId: string,
    beforeUuid: string | null,
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
    const result = await readHistoryBefore(transcriptPath, beforeUuid, limit);
    const frames: MirrorEventFrame[] = [];
    for (const rec of result.records) {
      const frame = jsonlRecordToHistoryFrame(session.sid, rec);
      if (frame) {
        redactor.redactFrame(frame);
        frames.push(frame);
      }
    }
    sendHistoryChunk(
      session,
      requestId,
      frames,
      result.exhausted,
      result.anchor_missing ? "anchor_missing" : undefined,
    );
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
    emitAuditEvent(session, `stop from ${watcher}: sent Esc`);
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
    const preview = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    emitAuditEvent(
      session,
      `inject from ${watcher}: ${JSON.stringify(preview)}`,
    );
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

function log(msg: string): void {
  process.stderr.write(`[claude-net/mirror] ${msg}\n`);
}

// ── Run when invoked directly ─────────────────────────────────────────────

if (import.meta.main) {
  const hub = process.env.CLAUDE_NET_HUB || "http://localhost:4815";
  const portEnv = process.env.CLAUDE_NET_MIRROR_AGENT_PORT;
  const bindPort = portEnv ? Number.parseInt(portEnv, 10) || 0 : 0;
  startAgent({ hubUrl: hub, bindPort }).catch((err: unknown) => {
    process.stderr.write(
      `[claude-net/mirror] startup failed: ${String(err)}\n`,
    );
    process.exit(1);
  });
}
