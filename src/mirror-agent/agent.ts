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
import { ConsentManager, type ConsentMode } from "./consent";
import { type RawHookPayload, ingestHook } from "./hook-ingest";
import { HubClient } from "./hub-client";
import { type TailHandle, tailJsonl } from "./jsonl-tail";
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
  token: string | null;
  mirrorUrl: string | null;
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
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
const OUTBOX_MAX = 4096;

export async function startAgent(config: AgentConfig): Promise<AgentHandle> {
  const hubUrl = config.hubUrl.replace(/\/+$/, "");
  const bindHost = config.bindHost ?? "127.0.0.1";
  const stateDir = config.stateDir ?? "/tmp/claude-net";
  const idleShutdownMs = config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const sessionIdleMs = config.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  const sessions = new Map<string, SessionState>();
  const consent = new ConsentManager();
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

  // Idle-shutdown watchdog.
  const idleTimer = setInterval(() => {
    const now = Date.now();
    // Clean up idle sessions.
    for (const s of sessions.values()) {
      if (!s.closed && now - s.lastEventAt > sessionIdleMs) {
        closeSession(s, "idle");
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
          mirror_url: s.mirrorUrl,
          last_event_at: new Date(s.lastEventAt).toISOString(),
          closed: s.closed,
        })),
      );
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      void stop();
      return new Response("stopping", { status: 200 });
    }
    if (req.method === "POST" && url.pathname === "/consent") {
      return handleConsentPost(req);
    }
    if (req.method === "POST" && url.pathname === "/share") {
      return handleSharePost(req);
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      return handleRevokePost(req);
    }
    return new Response("not found", { status: 404 });
  }

  async function handleSharePost(req: Request): Promise<Response> {
    let body: { sid?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const sid = body.sid;
    const session = sid ? sessions.get(sid) : null;
    if (!sid || !session || !session.token) {
      return new Response("unknown sid", { status: 404 });
    }
    const res = await fetch(
      `${hubUrl}/api/mirror/${encodeURIComponent(sid)}/share?t=${encodeURIComponent(
        session.token,
      )}`,
      { method: "POST" },
    );
    const data = await res.json().catch(() => ({}));
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  async function handleRevokePost(req: Request): Promise<Response> {
    let body: { sid?: string; token?: string; all?: boolean };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const sid = body.sid;
    const session = sid ? sessions.get(sid) : null;
    if (!sid || !session || !session.token) {
      return new Response("unknown sid", { status: 404 });
    }
    const res = await fetch(
      `${hubUrl}/api/mirror/${encodeURIComponent(sid)}/revoke?t=${encodeURIComponent(
        session.token,
      )}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: body.token, all: body.all }),
      },
    );
    const data = await res.json().catch(() => ({}));
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  async function handleConsentPost(req: Request): Promise<Response> {
    let body: { sid?: string; mode?: ConsentMode; action?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const sid = body.sid;
    if (!sid || !sessions.has(sid)) {
      return new Response("unknown sid", { status: 404 });
    }
    if (body.action === "reset") {
      consent.reset(sid);
    } else if (body.mode) {
      consent.setMode(sid, body.mode);
    } else {
      return new Response("missing mode or action", { status: 400 });
    }
    return Response.json({ sid, ...consent.describe(sid) });
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

    // Redact before queueing — keeps sensitive content off the hub WS.
    redactor.redactFrame(ingested.frame);
    queueEvent(session, ingested.frame);

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
    let createResponse: {
      sid: string;
      owner_token: string;
      mirror_url: string;
    };
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
      createResponse = (await res.json()) as typeof createResponse;
    } catch (err) {
      log(`session create threw: ${String(err)}`);
      return null;
    }

    const wsUrl = toWsUrl(
      hubUrl,
      createResponse.sid,
      createResponse.owner_token,
    );
    const session: SessionState = {
      sid,
      ownerAgent,
      cwd: cwd ?? "",
      transcriptPath: transcriptPath ?? null,
      token: createResponse.owner_token,
      mirrorUrl: createResponse.mirror_url,
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

    log(
      `[${sid}] session opened for ${ownerAgent}; url=${createResponse.mirror_url}`,
    );
    return session;
  }

  /**
   * Build + start a HubClient for the session using its current token.
   * Replaces any existing client. Called from openSession (first time)
   * and recoverSession (after hub session loss).
   */
  function attachHubClient(session: SessionState): void {
    if (!session.token) return;
    // Clean up prior client if any.
    if (session.ws) {
      try {
        session.ws.stop();
      } catch {
        // ignore
      }
      session.ws = null;
    }
    const wsUrl = toWsUrl(hubUrl, session.sid, session.token);
    const sid = session.sid;
    const client = new HubClient({
      url: wsUrl,
      logPrefix: `claude-net/mirror:${sid}`,
      onOpen: () => {
        const outbox = session.outbox;
        session.outbox = [];
        for (const frame of outbox) client.send(frame);
      },
      onMessage: (raw) => handleHubMessage(session, raw),
      onClose: (code, reason) => {
        log(`[${sid}] WS closed (${code}) ${reason}`);
        // Hub lost our session (restart, eviction, etc.). Token no longer
        // validates on the hub, so auto-reconnect would loop forever with a
        // stale token. Re-register the sid on the hub and swap the WS client
        // over to the new token.
        if (
          code === 1008 &&
          (reason.includes("not found") || reason.includes("Invalid token")) &&
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
   * sid with the hub to get a fresh token, then reconnect the WS with it.
   * The owner URL the user held becomes stale — they need to grab the new
   * one from the dashboard or `mirror_url` tool.
   */
  async function recoverSession(session: SessionState): Promise<void> {
    session.recovering = true;
    try {
      // Tear down the looping client first.
      if (session.ws) {
        try {
          session.ws.stop();
        } catch {
          // ignore
        }
        session.ws = null;
      }
      const res = await fetch(`${hubUrl}/api/mirror/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_agent: session.ownerAgent,
          cwd: session.cwd,
          sid: session.sid,
        }),
      });
      if (!res.ok) {
        log(
          `[${session.sid}] recovery: session create failed HTTP ${res.status}; will retry on next hook`,
        );
        return;
      }
      const data = (await res.json()) as {
        sid: string;
        owner_token: string;
        mirror_url: string;
      };
      session.token = data.owner_token;
      session.mirrorUrl = data.mirror_url;
      log(`[${session.sid}] recovered on hub; new url=${data.mirror_url}`);
      attachHubClient(session);
    } finally {
      session.recovering = false;
    }
  }

  function startTailIfNeeded(session: SessionState): void {
    if (session.tail || !session.transcriptPath) return;
    session.tail = tailJsonl(session.transcriptPath, {
      onRecord: (rec) => {
        // Reconciliation: we don't emit anything here in M1 — the hook stream
        // is the primary event source. We only track the JSONL for future
        // phases (gap detection, restart recovery). Dedupe by uuid so if we
        // later start emitting from here, duplicates are suppressed.
        if (typeof rec.uuid === "string") {
          session.seenUuids.add(rec.uuid);
        }
      },
      onError: (err) => {
        log(`[${session.sid}] JSONL tail error: ${err.message}`);
      },
    });
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
    }
  }

  async function handleInject(
    session: SessionState,
    text: string,
    watcher: string,
  ): Promise<void> {
    const consentResult = await consent.check(
      session.sid,
      session.tmuxPane,
      watcher,
    );
    if (!consentResult.ok) {
      emitAuditEvent(
        session,
        `inject rejected (consent: ${consentResult.reason}): ${consentResult.message}`,
      );
      return;
    }
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
    if (session.tail) {
      session.tail.stop();
      session.tail = null;
    }
    if (session.ws) {
      session.ws.stop();
      session.ws = null;
    }
    // Fire-and-forget hub close.
    if (session.token) {
      const url = `${hubUrl}/api/mirror/${encodeURIComponent(
        session.sid,
      )}/close?t=${encodeURIComponent(session.token)}`;
      fetch(url, { method: "POST" }).catch(() => {
        /* best effort */
      });
    }
    sessions.delete(session.sid);
  }

  async function stop(): Promise<void> {
    clearInterval(idleTimer);
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

function toWsUrl(hubUrl: string, sid: string, token: string): string {
  const wsBase = hubUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}/ws/mirror/${encodeURIComponent(sid)}?t=${encodeURIComponent(
    token,
  )}&as=agent`;
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
