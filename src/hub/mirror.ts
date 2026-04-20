import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import type {
  DashboardEvent,
  MirrorEventBroadcastEvent,
  MirrorEventFrame,
  MirrorInjectFrame,
  MirrorSessionSummary,
  MirrorTokenType,
} from "@/shared/types";
import { Elysia } from "elysia";

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_TRANSCRIPT_RING = 2000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 16;

// ── Entry types ───────────────────────────────────────────────────────────

export interface SessionWatcher {
  ws: { send(data: string): void };
  wsIdentity: object;
  id: string;
  tokenType: MirrorTokenType;
}

export interface AgentConnection {
  ws: { send(data: string): void };
  wsIdentity: object;
}

export interface MirrorSessionEntry {
  sid: string;
  ownerAgent: string;
  cwd: string;
  createdAt: Date;
  lastEventAt: Date;
  transcript: MirrorEventFrame[];
  watchers: Set<SessionWatcher>;
  agent: AgentConnection | null;
  ownerToken: string;
  ownerTokenCreatedAt: Date;
  ownerTokenRevokedAt: Date | null;
  nextInjectSeq: number;
  closedAt: Date | null;
  retentionTimerId: ReturnType<typeof setTimeout> | null;
}

export interface MirrorRegistryOptions {
  transcriptRing?: number;
  retentionMs?: number;
}

// ── MirrorRegistry ────────────────────────────────────────────────────────

export class MirrorRegistry {
  readonly sessions = new Map<string, MirrorSessionEntry>();
  private transcriptRing: number;
  private retentionMs: number;
  private dashboardBroadcast: (event: DashboardEvent) => void = () => {};

  constructor(options?: MirrorRegistryOptions) {
    this.transcriptRing = options?.transcriptRing ?? DEFAULT_TRANSCRIPT_RING;
    this.retentionMs = options?.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  setDashboardBroadcast(fn: (event: DashboardEvent) => void): void {
    this.dashboardBroadcast = fn;
  }

  /**
   * Create a new mirror session, or return an existing one idempotently if
   * the same owner is reconnecting with the same sid.
   */
  createSession(
    ownerAgent: string,
    cwd: string,
    sid?: string,
  ):
    | { ok: true; entry: MirrorSessionEntry; token: string; restored: boolean }
    | { ok: false; error: string } {
    const actualSid = sid ?? crypto.randomUUID();
    const existing = this.sessions.get(actualSid);
    if (existing) {
      if (existing.ownerAgent !== ownerAgent) {
        return {
          ok: false,
          error: `Session '${actualSid}' belongs to a different owner.`,
        };
      }
      if (existing.closedAt) {
        return {
          ok: false,
          error: `Session '${actualSid}' is closed; create a new session.`,
        };
      }
      return {
        ok: true,
        entry: existing,
        token: existing.ownerToken,
        restored: true,
      };
    }

    const token = generateToken();
    const now = new Date();
    const entry: MirrorSessionEntry = {
      sid: actualSid,
      ownerAgent,
      cwd,
      createdAt: now,
      lastEventAt: now,
      transcript: [],
      watchers: new Set(),
      agent: null,
      ownerToken: token,
      ownerTokenCreatedAt: now,
      ownerTokenRevokedAt: null,
      nextInjectSeq: 0,
      closedAt: null,
      retentionTimerId: null,
    };
    this.sessions.set(actualSid, entry);

    this.dashboardBroadcast({
      event: "mirror:session_started",
      sid: actualSid,
      owner_agent: ownerAgent,
      cwd,
      created_at: now.toISOString(),
    });

    return { ok: true, entry, token, restored: false };
  }

  getSession(sid: string): MirrorSessionEntry | null {
    return this.sessions.get(sid) ?? null;
  }

  /**
   * Validate a token for a session. Uses timing-safe comparison.
   */
  validateToken(
    sid: string,
    token: string | undefined,
  ):
    | { ok: true; entry: MirrorSessionEntry; type: MirrorTokenType }
    | { ok: false; error: string; status: number } {
    if (!token) return { ok: false, error: "Missing token.", status: 401 };
    const entry = this.sessions.get(sid);
    if (!entry)
      return { ok: false, error: `Session '${sid}' not found.`, status: 404 };
    if (entry.ownerTokenRevokedAt)
      return { ok: false, error: "Token revoked.", status: 403 };
    if (constantTimeEqual(token, entry.ownerToken)) {
      return { ok: true, entry, type: "owner" };
    }
    return { ok: false, error: "Invalid token.", status: 403 };
  }

  /**
   * Record an event from the mirror-agent, dedupe by `uuid`, fan out to watchers.
   */
  recordEvent(
    sid: string,
    frame: MirrorEventFrame,
  ): { ok: true; duplicate: boolean } | { ok: false; error: string } {
    const entry = this.sessions.get(sid);
    if (!entry) return { ok: false, error: `Session '${sid}' not found.` };
    if (entry.closedAt) return { ok: false, error: "Session is closed." };

    // Dedupe by uuid against the tail of the ring (cheap linear scan —
    // transcripts rarely see duplicates other than adjacent ones from the
    // hook/JSONL reconciler).
    for (let i = entry.transcript.length - 1; i >= 0; i--) {
      const existing = entry.transcript[i];
      if (existing && existing.uuid === frame.uuid) {
        return { ok: true, duplicate: true };
      }
    }

    entry.transcript.push(frame);
    if (entry.transcript.length > this.transcriptRing) {
      entry.transcript.splice(0, entry.transcript.length - this.transcriptRing);
    }
    entry.lastEventAt = new Date();

    const broadcast: MirrorEventBroadcastEvent = {
      event: "mirror:event",
      sid,
      uuid: frame.uuid,
      kind: frame.kind,
      ts: frame.ts,
      payload: frame.payload,
    };
    const payload = JSON.stringify(broadcast);
    for (const watcher of entry.watchers) {
      try {
        watcher.ws.send(payload);
      } catch {
        // Watcher may have disconnected; cleaned up in close handler.
      }
    }

    return { ok: true, duplicate: false };
  }

  addWatcher(sid: string, watcher: SessionWatcher): void {
    const entry = this.sessions.get(sid);
    if (!entry) return;
    entry.watchers.add(watcher);
    this.dashboardBroadcast({
      event: "mirror:watcher_joined",
      sid,
      watcher_id: watcher.id,
      token_type: watcher.tokenType,
    });
  }

  removeWatcher(sid: string, watcher: SessionWatcher): void {
    const entry = this.sessions.get(sid);
    if (!entry) return;
    entry.watchers.delete(watcher);
    this.dashboardBroadcast({
      event: "mirror:watcher_left",
      sid,
      watcher_id: watcher.id,
    });
  }

  setAgentConnection(sid: string, agent: AgentConnection | null): void {
    const entry = this.sessions.get(sid);
    if (!entry) return;
    entry.agent = agent;
  }

  /**
   * Close a session. Emits a session_end event to watchers and schedules
   * retention cleanup. Idempotent.
   */
  closeSession(sid: string, reason: "exit" | "agent_timeout" = "exit"): void {
    const entry = this.sessions.get(sid);
    if (!entry || entry.closedAt) return;
    entry.closedAt = new Date();

    // Synthesize a session_end event into the transcript and broadcast it.
    const endFrame: MirrorEventFrame = {
      action: "mirror_event",
      sid,
      uuid: crypto.randomUUID(),
      kind: "session_end",
      ts: Date.now(),
      payload: { kind: "session_end", reason },
    };
    entry.transcript.push(endFrame);

    const broadcast: MirrorEventBroadcastEvent = {
      event: "mirror:event",
      sid,
      uuid: endFrame.uuid,
      kind: endFrame.kind,
      ts: endFrame.ts,
      payload: endFrame.payload,
    };
    const payload = JSON.stringify(broadcast);
    for (const watcher of entry.watchers) {
      try {
        watcher.ws.send(payload);
      } catch {
        // ignore
      }
    }

    this.dashboardBroadcast({
      event: "mirror:session_ended",
      sid,
      ended_at: entry.closedAt.toISOString(),
    });

    if (this.retentionMs > 0) {
      const timer = setTimeout(() => {
        this.sessions.delete(sid);
      }, this.retentionMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
      entry.retentionTimerId = timer;
    } else {
      this.sessions.delete(sid);
    }
  }

  listOwnedBy(ownerAgent: string): MirrorSessionSummary[] {
    const result: MirrorSessionSummary[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.ownerAgent === ownerAgent) {
        result.push(toSummary(entry));
      }
    }
    return result;
  }

  handleAgentDisconnect(wsIdentity: object): void {
    for (const entry of this.sessions.values()) {
      if (entry.agent && entry.agent.wsIdentity === wsIdentity) {
        entry.agent = null;
      }
    }
  }

  /**
   * Forward an inject frame to the session's mirror-agent. Returns the
   * assigned sequence number on success. Caller must have already
   * validated the token and the text.
   */
  relayInject(
    sid: string,
    text: string,
    watcher: string,
  ): { ok: true; seq: number } | { ok: false; error: string; status: number } {
    const entry = this.sessions.get(sid);
    if (!entry)
      return { ok: false, error: `Session '${sid}' not found.`, status: 404 };
    if (entry.closedAt)
      return { ok: false, error: "Session is closed.", status: 409 };
    if (!entry.agent)
      return {
        ok: false,
        error: "Mirror-agent is not connected for this session.",
        status: 503,
      };
    const seq = ++entry.nextInjectSeq;
    const frame: MirrorInjectFrame = {
      event: "mirror_inject",
      sid,
      text,
      seq,
      origin: { watcher, ts: Date.now() },
    };
    try {
      entry.agent.ws.send(JSON.stringify(frame));
    } catch (err) {
      return {
        ok: false,
        error: `Failed to relay to mirror-agent: ${String(err)}`,
        status: 502,
      };
    }
    return { ok: true, seq };
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function toSummary(entry: MirrorSessionEntry): MirrorSessionSummary {
  return {
    sid: entry.sid,
    owner_agent: entry.ownerAgent,
    cwd: entry.cwd,
    created_at: entry.createdAt.toISOString(),
    last_event_at: entry.lastEventAt.toISOString(),
    watcher_count: entry.watchers.size,
    transcript_len: entry.transcript.length,
  };
}

// ── Elysia plugin (REST /api/mirror/*) ────────────────────────────────────

export interface MirrorPluginDeps {
  mirrorRegistry: MirrorRegistry;
  /** External hostname used to generate mirror URLs. Overrides the Host header when set. */
  externalHost?: string;
  /** Port used to generate mirror URLs when the host is bare. */
  port?: number;
}

export function mirrorPlugin(deps: MirrorPluginDeps): Elysia {
  const { mirrorRegistry, externalHost, port } = deps;

  return new Elysia({ prefix: "/api/mirror" })
    .post("/session", ({ body, set, request }) => {
      const payload = body as {
        owner_agent?: string;
        cwd?: string;
        sid?: string;
      };
      if (!payload.owner_agent || !payload.cwd) {
        set.status = 400;
        return { error: "Missing required fields: owner_agent, cwd" };
      }
      const result = mirrorRegistry.createSession(
        payload.owner_agent,
        payload.cwd,
        payload.sid,
      );
      if (!result.ok) {
        set.status = 409;
        return { error: result.error };
      }
      const host = resolveMirrorHost(externalHost, port, request);
      const mirrorUrl = `http://${host}/mirror/${result.entry.sid}#token=${result.token}`;
      return {
        sid: result.entry.sid,
        owner_token: result.token,
        mirror_url: mirrorUrl,
        restored: result.restored,
      };
    })

    .get("/sessions", ({ query, set }) => {
      const owner = (query as Record<string, string | undefined>).owner;
      if (!owner) {
        set.status = 400;
        return { error: "Missing required query: owner" };
      }
      return mirrorRegistry.listOwnedBy(owner);
    })

    .get("/:sid/transcript", ({ params, query, set }) => {
      const token = (query as Record<string, string | undefined>).t;
      const validation = mirrorRegistry.validateToken(params.sid, token);
      if (!validation.ok) {
        set.status = validation.status;
        return { error: validation.error };
      }
      const entry = validation.entry;
      return {
        sid: entry.sid,
        owner_agent: entry.ownerAgent,
        cwd: entry.cwd,
        created_at: entry.createdAt.toISOString(),
        last_event_at: entry.lastEventAt.toISOString(),
        closed_at: entry.closedAt ? entry.closedAt.toISOString() : null,
        transcript: entry.transcript.map((f) => ({
          uuid: f.uuid,
          kind: f.kind,
          ts: f.ts,
          payload: f.payload,
        })),
      };
    })

    .post("/:sid/close", ({ params, query, set }) => {
      const token = (query as Record<string, string | undefined>).t;
      const validation = mirrorRegistry.validateToken(params.sid, token);
      if (!validation.ok) {
        set.status = validation.status;
        return { error: validation.error };
      }
      mirrorRegistry.closeSession(params.sid, "exit");
      return { closed: true };
    })

    .post("/:sid/inject", ({ params, query, body, set, request }) => {
      const token = (query as Record<string, string | undefined>).t;
      const validation = mirrorRegistry.validateToken(params.sid, token);
      if (!validation.ok) {
        set.status = validation.status;
        return { error: validation.error };
      }
      if (validation.type !== "owner") {
        set.status = 403;
        return { error: "Reader tokens cannot inject." };
      }
      const payload = body as { text?: string; watcher?: string };
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text.trim().length === 0) {
        set.status = 400;
        return { error: "Empty prompt." };
      }
      if (Buffer.byteLength(text, "utf8") > MAX_INJECT_BYTES) {
        set.status = 413;
        return { error: `Prompt exceeds ${MAX_INJECT_BYTES} bytes.` };
      }
      // Per-session rate limit at the hub (defense in depth; mirror-agent
      // re-applies its own).
      if (!injectLimiter.allow(params.sid)) {
        set.status = 429;
        set.headers["retry-after"] = "1";
        return { error: "Rate limit exceeded." };
      }
      const watcher = sanitizeWatcher(
        payload.watcher ?? request.headers.get("user-agent") ?? "unknown",
      );
      const result = mirrorRegistry.relayInject(params.sid, text, watcher);
      if (!result.ok) {
        set.status = result.status;
        return { error: result.error };
      }
      return { accepted: true, seq: result.seq };
    });
}

// ── Inject limits & helpers ───────────────────────────────────────────────

const MAX_INJECT_BYTES = 32 * 1024;

class InjectLimiter {
  private last = new Map<string, number>();
  private readonly minIntervalMs: number;
  constructor(minIntervalMs = 250) {
    this.minIntervalMs = minIntervalMs;
  }
  allow(sid: string): boolean {
    const now = Date.now();
    const prev = this.last.get(sid) ?? 0;
    if (now - prev < this.minIntervalMs) return false;
    this.last.set(sid, now);
    return true;
  }
}

const injectLimiter = new InjectLimiter();

function sanitizeWatcher(s: string): string {
  // Strip control characters and double-quotes so the value is safe to embed
  // in notifications and logs.
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === '"') continue;
    out += ch;
    if (out.length >= 120) break;
  }
  return out;
}

function resolveMirrorHost(
  externalHost: string | undefined,
  port: number | undefined,
  request: Request,
): string {
  if (externalHost) {
    if (!externalHost.includes(":") && port) {
      return `${externalHost}:${port}`;
    }
    return externalHost;
  }
  const headerHost = request.headers.get("host");
  if (headerHost) return headerHost;
  return `localhost:${port ?? 4815}`;
}

// ── WebSocket plugin (/ws/mirror/:sid) ────────────────────────────────────

interface MirrorWs {
  send(data: string | object): void;
  raw: object;
  id: string;
  data: {
    params: { sid: string };
    query: Record<string, string | undefined>;
  };
  close(code?: number, reason?: string): void;
}

// Per-connection metadata, keyed by ws.raw. We avoid mutating ws.raw so the
// object stays a plain ServerWebSocket.
interface ConnMeta {
  role: "agent" | "watcher";
  sid: string;
  watcher?: SessionWatcher;
}

const connMeta = new WeakMap<object, ConnMeta>();

export function wsMirrorPlugin(
  app: Elysia,
  mirrorRegistry: MirrorRegistry,
): Elysia {
  return app.ws("/ws/mirror/:sid", {
    open(ws: MirrorWs) {
      const sid = ws.data.params.sid;
      const q = ws.data.query ?? {};
      const token = q.t;
      const asParam = q.as;

      const validation = mirrorRegistry.validateToken(sid, token);
      if (!validation.ok) {
        ws.send(JSON.stringify({ event: "error", message: validation.error }));
        ws.close(1008, validation.error);
        return;
      }

      const sendRaw = (data: string): void => {
        ws.send(data);
      };

      if (asParam === "agent") {
        mirrorRegistry.setAgentConnection(sid, {
          ws: { send: sendRaw },
          wsIdentity: ws.raw,
        });
        connMeta.set(ws.raw, { role: "agent", sid });
        ws.send(JSON.stringify({ event: "mirror:agent_ready", sid }));
        return;
      }

      // Default: watcher
      const watcher: SessionWatcher = {
        ws: { send: sendRaw },
        wsIdentity: ws.raw,
        id: crypto.randomUUID(),
        tokenType: validation.type,
      };
      mirrorRegistry.addWatcher(sid, watcher);
      connMeta.set(ws.raw, { role: "watcher", sid, watcher });

      // Initial snapshot: session meta + full transcript
      const entry = validation.entry;
      ws.send(
        JSON.stringify({
          event: "mirror:init",
          sid,
          owner_agent: entry.ownerAgent,
          cwd: entry.cwd,
          created_at: entry.createdAt.toISOString(),
          last_event_at: entry.lastEventAt.toISOString(),
          closed_at: entry.closedAt ? entry.closedAt.toISOString() : null,
          transcript: entry.transcript.map((f) => ({
            uuid: f.uuid,
            kind: f.kind,
            ts: f.ts,
            payload: f.payload,
          })),
        }),
      );
    },

    message(ws: MirrorWs, rawData: unknown) {
      const meta = connMeta.get(ws.raw);
      if (!meta) return;
      if (meta.role !== "agent") return;

      const data =
        typeof rawData === "string" ? safeJsonParse(rawData) : rawData;
      if (!data || typeof data !== "object" || !("action" in data)) return;

      const frame = data as { action: string } & Record<string, unknown>;
      if (frame.action === "mirror_event" && frame.sid === meta.sid) {
        mirrorRegistry.recordEvent(
          meta.sid,
          frame as unknown as MirrorEventFrame,
        );
      }
    },

    close(ws: MirrorWs) {
      const meta = connMeta.get(ws.raw);
      if (!meta) return;
      connMeta.delete(ws.raw);
      if (meta.role === "agent") {
        mirrorRegistry.handleAgentDisconnect(ws.raw);
      } else if (meta.watcher) {
        mirrorRegistry.removeWatcher(meta.sid, meta.watcher);
      }
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS handler typing requires flexible return
  }) as any;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
