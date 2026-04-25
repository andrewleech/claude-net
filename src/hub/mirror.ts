import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import type {
  DashboardEvent,
  MirrorEventBroadcastEvent,
  MirrorEventFrame,
  MirrorHistoryRequestFrame,
  MirrorInjectFrame,
  MirrorListCommandsFrame,
  MirrorPasteFrame,
  MirrorSessionSummary,
  MirrorStopFrame,
} from "@/shared/types";

interface SlashCommand {
  name: string;
  description?: string;
  source: string;
}
import { Elysia } from "elysia";
import { type MirrorStore, NullStore } from "./mirror-store";
import { RateLimiter } from "./rate-limit";

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_TRANSCRIPT_RING = 2000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * A session is considered "orphaned" when no daemon-agent WS has been
 * bound AND no events have arrived for this long. The sweeper closes
 * such sessions so stale entries from ungracefully-exited claude
 * processes, hub restarts that weren't matched by daemon recovery, and
 * /clear'd sessions whose underlying tmux was killed don't linger.
 *
 * Set to 0 to disable.
 */
const DEFAULT_ORPHAN_CLOSE_MS = 30 * 60 * 1000;
const ORPHAN_SWEEP_INTERVAL_MS = 60 * 1000;

// ── Entry types ───────────────────────────────────────────────────────────

export interface SessionWatcher {
  ws: { send(data: string): void };
  wsIdentity: object;
  id: string;
  close?: () => void;
}

export interface AgentConnection {
  ws: { send(data: string): void };
  wsIdentity: object;
  close?: () => void;
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
  nextInjectSeq: number;
  closedAt: Date | null;
  retentionTimerId: ReturnType<typeof setTimeout> | null;
}

export interface MirrorRegistryOptions {
  transcriptRing?: number;
  retentionMs?: number;
  /** Opt-in durable store. Defaults to NullStore (in-memory only). */
  store?: MirrorStore;
  /**
   * Close sessions whose daemon-agent WS has been unbound and which
   * have seen no events for this long. 0 disables. Default 30 min.
   */
  orphanCloseMs?: number;
}

// ── MirrorRegistry ────────────────────────────────────────────────────────

interface PendingPaste {
  resolve: (path: string) => void;
  reject: (error: { status: number; message: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingCommandsList {
  resolve: (commands: SlashCommand[]) => void;
  reject: (error: { status: number; message: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingHistoryRequest {
  resolve: (chunk: {
    frames: MirrorEventFrame[];
    exhausted: boolean;
  }) => void;
  reject: (error: { status: number; message: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MirrorRegistry {
  readonly sessions = new Map<string, MirrorSessionEntry>();
  private transcriptRing: number;
  private retentionMs: number;
  private orphanCloseMs: number;
  private orphanSweepTimer: ReturnType<typeof setInterval> | null = null;
  private dashboardBroadcast: (event: DashboardEvent) => void = () => {};
  private sessionClosedHooks: Array<(sid: string) => void> = [];
  readonly store: MirrorStore;
  /** Key: `${sid}:${requestId}` — awaiting MirrorPasteDoneFrame from agent. */
  private pendingPastes = new Map<string, PendingPaste>();
  /** Key: `${sid}:${requestId}` — awaiting MirrorCommandsDoneFrame. */
  private pendingCommandsLists = new Map<string, PendingCommandsList>();
  /** Key: `${sid}:${requestId}` — awaiting MirrorHistoryChunkFrame. */
  private pendingHistoryRequests = new Map<string, PendingHistoryRequest>();

  constructor(options?: MirrorRegistryOptions) {
    this.transcriptRing = options?.transcriptRing ?? DEFAULT_TRANSCRIPT_RING;
    this.retentionMs = options?.retentionMs ?? DEFAULT_RETENTION_MS;
    this.orphanCloseMs = options?.orphanCloseMs ?? DEFAULT_ORPHAN_CLOSE_MS;
    this.store = options?.store ?? new NullStore();
    if (this.orphanCloseMs > 0) {
      this.orphanSweepTimer = setInterval(
        () => this.sweepOrphans(),
        ORPHAN_SWEEP_INTERVAL_MS,
      );
      if (
        this.orphanSweepTimer &&
        typeof this.orphanSweepTimer === "object" &&
        "unref" in this.orphanSweepTimer
      ) {
        this.orphanSweepTimer.unref();
      }
    }
  }

  /**
   * Close sessions whose daemon-agent WS is absent AND whose last event
   * is older than orphanCloseMs. Runs on a timer.
   */
  private sweepOrphans(): void {
    const cutoff = Date.now() - this.orphanCloseMs;
    const victims: string[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.closedAt) continue;
      if (entry.agent) continue;
      if (entry.lastEventAt.getTime() > cutoff) continue;
      victims.push(entry.sid);
    }
    for (const sid of victims) {
      this.closeSession(sid, "agent_timeout");
    }
  }

  /** Stop background timers. Only needed when the hub is torn down in tests. */
  stop(): void {
    if (this.orphanSweepTimer) {
      clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = null;
    }
  }

  setDashboardBroadcast(fn: (event: DashboardEvent) => void): void {
    this.dashboardBroadcast = fn;
  }

  /** Register a callback to run when any session is closed. Used by the
   *  uploads registry to purge per-session files. */
  onSessionClosed(fn: (sid: string) => void): void {
    this.sessionClosedHooks.push(fn);
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
    | { ok: true; entry: MirrorSessionEntry; restored: boolean }
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
        // Re-open a closed session when the same owner comes back with
        // the same sid. Happens after mirror-agent restarts where the
        // old agent's shutdown sent a /close before the new agent had
        // the chance to reclaim the session. Preserving sid keeps the
        // transcript continuous; we just clear closedAt and cancel the
        // retention timer (if scheduled).
        existing.closedAt = null;
        if (existing.retentionTimerId) {
          clearTimeout(existing.retentionTimerId);
          existing.retentionTimerId = null;
        }
      }
      return {
        ok: true,
        entry: existing,
        restored: true,
      };
    }

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
      nextInjectSeq: 0,
      closedAt: null,
      retentionTimerId: null,
    };
    this.sessions.set(actualSid, entry);

    this.store.recordOpen({
      sid: actualSid,
      owner_agent: ownerAgent,
      cwd,
      created_at: now.toISOString(),
    });

    this.dashboardBroadcast({
      event: "mirror:session_started",
      sid: actualSid,
      owner_agent: ownerAgent,
      cwd,
      created_at: now.toISOString(),
    });

    return { ok: true, entry, restored: false };
  }

  getSession(
    sid: string,
  ):
    | { ok: true; entry: MirrorSessionEntry }
    | { ok: false; error: string; status: number } {
    const entry = this.sessions.get(sid);
    if (!entry)
      return { ok: false, error: `Session '${sid}' not found.`, status: 404 };
    return { ok: true, entry };
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

    // Durable write-through. NullStore is a no-op.
    try {
      this.store.appendEvent(sid, frame);
    } catch (err) {
      process.stderr.write(
        `[claude-net/mirror] store.appendEvent failed for ${sid}: ${String(err)}\n`,
      );
    }

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

    // Lightweight activity ping to the dashboard socket — no payload, so we
    // don't flood every dashboard with every tool-result blob. Dashboards
    // use this to bump last_event_at and re-sort the sidebar.
    this.dashboardBroadcast({
      event: "mirror:activity",
      sid,
      ts: frame.ts,
    });

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

    try {
      this.store.recordClose(sid, entry.closedAt.toISOString());
    } catch (err) {
      process.stderr.write(
        `[claude-net/mirror] store.recordClose failed for ${sid}: ${String(err)}\n`,
      );
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

    for (const fn of this.sessionClosedHooks) {
      try {
        fn(sid);
      } catch (err) {
        process.stderr.write(
          `[claude-net/mirror] sessionClosed hook threw for ${sid}: ${String(err)}\n`,
        );
      }
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

  /**
   * Return a summary of every active session. The hub runs on a trusted
   * network, so no extra auth gates this listing.
   */
  listAll(): MirrorSessionSummary[] {
    const result: MirrorSessionSummary[] = [];
    for (const entry of this.sessions.values()) {
      result.push(toSummary(entry));
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
   * Rewrite ownerAgent on every session currently owned by `oldName` to
   * `newName`. Returns the list of affected sids. Broadcasts a single
   * `mirror:owner_renamed` event so dashboards can update their sidebars
   * without a full refresh.
   *
   * Called from the MCP register handler when the hub detects that an
   * already-connected ws has chosen a different name. When two mirror
   * sessions share the same ownerAgent (fork sessions in the same cwd)
   * both rename together — the sid suffix on each sidebar row keeps
   * them visually distinct.
   */
  renameOwner(oldName: string, newName: string): string[] {
    if (!oldName || !newName || oldName === newName) return [];
    const affected: string[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.ownerAgent === oldName) {
        entry.ownerAgent = newName;
        affected.push(entry.sid);
      }
    }
    if (affected.length > 0) {
      this.dashboardBroadcast({
        event: "mirror:owner_renamed",
        old_owner: oldName,
        new_owner: newName,
        sids: affected,
      });
    }
    return affected;
  }

  /**
   * Rename exactly one session's owner_agent. Unlike renameOwner this
   * does NOT touch sibling sessions that share the old name. Used by
   * the POST /:sid/rename endpoint where the user is being explicit
   * about which row to relabel.
   */
  renameSession(
    sid: string,
    newName: string,
  ):
    | { ok: true; old_owner: string; new_owner: string }
    | { ok: false; error: string; status: number } {
    const entry = this.sessions.get(sid);
    if (!entry)
      return { ok: false, error: `Session '${sid}' not found.`, status: 404 };
    const oldName = entry.ownerAgent;
    if (oldName === newName) {
      return { ok: true, old_owner: oldName, new_owner: newName };
    }
    entry.ownerAgent = newName;
    this.dashboardBroadcast({
      event: "mirror:owner_renamed",
      old_owner: oldName,
      new_owner: newName,
      sids: [sid],
    });
    return { ok: true, old_owner: oldName, new_owner: newName };
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

  /** Relay a "stop" (Esc) signal to the session's agent. Fire and
   *  forget — no correlated ack. */
  relayStop(
    sid: string,
    watcher: string,
  ): { ok: true } | { ok: false; error: string; status: number } {
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
    const frame: MirrorStopFrame = {
      event: "mirror_stop",
      sid,
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
    return { ok: true };
  }

  /**
   * Stash a blob too large for tmux inject as a file on the agent's host.
   * Sends a MirrorPasteFrame and awaits the agent's MirrorPasteDoneFrame
   * reply. Resolves with the path the agent wrote, or rejects with a
   * status-bearing error for the HTTP endpoint to surface.
   */
  relayPaste(
    sid: string,
    text: string,
    watcher: string,
    timeoutMs: number,
  ): Promise<
    { ok: true; path: string } | { ok: false; error: string; status: number }
  > {
    const entry = this.sessions.get(sid);
    if (!entry)
      return Promise.resolve({
        ok: false,
        error: `Session '${sid}' not found.`,
        status: 404,
      });
    if (entry.closedAt)
      return Promise.resolve({
        ok: false,
        error: "Session is closed.",
        status: 409,
      });
    if (!entry.agent)
      return Promise.resolve({
        ok: false,
        error: "Mirror-agent is not connected for this session.",
        status: 503,
      });

    const requestId = crypto.randomUUID();
    const key = `${sid}:${requestId}`;
    const frame: MirrorPasteFrame = {
      event: "mirror_paste",
      sid,
      requestId,
      text,
      origin: { watcher, ts: Date.now() },
    };

    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pendingPastes.delete(key);
        resolvePromise({
          ok: false,
          error: `Mirror-agent did not respond within ${timeoutMs}ms.`,
          status: 504,
        });
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();

      this.pendingPastes.set(key, {
        resolve: (path) => {
          clearTimeout(timer);
          this.pendingPastes.delete(key);
          resolvePromise({ ok: true, path });
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingPastes.delete(key);
          resolvePromise({
            ok: false,
            error: err.message,
            status: err.status,
          });
        },
        timer,
      });

      try {
        // biome-ignore lint/style/noNonNullAssertion: null-checked above
        entry.agent!.ws.send(JSON.stringify(frame));
      } catch (err) {
        const pending = this.pendingPastes.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingPastes.delete(key);
        }
        resolvePromise({
          ok: false,
          error: `Failed to relay to mirror-agent: ${String(err)}`,
          status: 502,
        });
      }
    });
  }

  /**
   * Called from ws-mirror-plugin when the agent sends back a
   * MirrorPasteDoneFrame. Settles the pending promise from relayPaste.
   */
  resolvePaste(
    sid: string,
    requestId: string,
    result: { path?: string; error?: string },
  ): void {
    const key = `${sid}:${requestId}`;
    const pending = this.pendingPastes.get(key);
    if (!pending) return;
    if (result.path) {
      pending.resolve(result.path);
    } else {
      pending.reject({
        status: 502,
        message: result.error ?? "mirror-agent reported an unknown error",
      });
    }
  }

  /**
   * Ask the session's mirror-agent for the slash commands available to
   * its Claude Code. Same request/response WS pattern as relayPaste.
   */
  relayListCommands(
    sid: string,
    timeoutMs: number,
  ): Promise<
    | { ok: true; commands: SlashCommand[] }
    | { ok: false; error: string; status: number }
  > {
    const entry = this.sessions.get(sid);
    if (!entry)
      return Promise.resolve({
        ok: false,
        error: `Session '${sid}' not found.`,
        status: 404,
      });
    if (!entry.agent)
      return Promise.resolve({
        ok: false,
        error: "Mirror-agent is not connected for this session.",
        status: 503,
      });

    const requestId = crypto.randomUUID();
    const key = `${sid}:${requestId}`;
    const frame: MirrorListCommandsFrame = {
      event: "mirror_list_commands",
      sid,
      requestId,
    };

    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pendingCommandsLists.delete(key);
        resolvePromise({
          ok: false,
          error: `Mirror-agent did not respond within ${timeoutMs}ms.`,
          status: 504,
        });
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();

      this.pendingCommandsLists.set(key, {
        resolve: (commands) => {
          clearTimeout(timer);
          this.pendingCommandsLists.delete(key);
          resolvePromise({ ok: true, commands });
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingCommandsLists.delete(key);
          resolvePromise({
            ok: false,
            error: err.message,
            status: err.status,
          });
        },
        timer,
      });

      try {
        // biome-ignore lint/style/noNonNullAssertion: null-checked above
        entry.agent!.ws.send(JSON.stringify(frame));
      } catch (err) {
        const pending = this.pendingCommandsLists.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCommandsLists.delete(key);
        }
        resolvePromise({
          ok: false,
          error: `Failed to relay to mirror-agent: ${String(err)}`,
          status: 502,
        });
      }
    });
  }

  /** Called from ws-mirror-plugin when the agent sends back a
   *  MirrorCommandsDoneFrame. */
  resolveListCommands(
    sid: string,
    requestId: string,
    result: { commands?: SlashCommand[]; error?: string },
  ): void {
    const key = `${sid}:${requestId}`;
    const pending = this.pendingCommandsLists.get(key);
    if (!pending) return;
    if (result.commands) {
      pending.resolve(result.commands);
    } else {
      pending.reject({
        status: 502,
        message: result.error ?? "mirror-agent reported an unknown error",
      });
    }
  }

  /**
   * Ask the session's mirror-agent to read history from its on-disk JSONL
   * preceding `beforeUuid` (or from EOF if null). Same request/response
   * WS pattern as relayPaste / relayListCommands.
   */
  relayHistoryRequest(
    sid: string,
    beforeUuid: string | null,
    limit: number,
    timeoutMs: number,
  ): Promise<
    | { ok: true; frames: MirrorEventFrame[]; exhausted: boolean }
    | { ok: false; error: string; status: number }
  > {
    const entry = this.sessions.get(sid);
    if (!entry)
      return Promise.resolve({
        ok: false,
        error: `Session '${sid}' not found.`,
        status: 404,
      });
    if (!entry.agent)
      return Promise.resolve({
        ok: false,
        error: "Mirror-agent is not connected for this session.",
        status: 503,
      });

    const requestId = crypto.randomUUID();
    const key = `${sid}:${requestId}`;
    const frame: MirrorHistoryRequestFrame = {
      event: "mirror_history_request",
      sid,
      requestId,
      before_uuid: beforeUuid,
      limit,
    };

    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pendingHistoryRequests.delete(key);
        resolvePromise({
          ok: false,
          error: `Mirror-agent did not respond within ${timeoutMs}ms.`,
          status: 504,
        });
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();

      this.pendingHistoryRequests.set(key, {
        resolve: (chunk) => {
          clearTimeout(timer);
          this.pendingHistoryRequests.delete(key);
          resolvePromise({
            ok: true,
            frames: chunk.frames,
            exhausted: chunk.exhausted,
          });
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingHistoryRequests.delete(key);
          resolvePromise({ ok: false, error: err.message, status: err.status });
        },
        timer,
      });

      try {
        // biome-ignore lint/style/noNonNullAssertion: null-checked above
        entry.agent!.ws.send(JSON.stringify(frame));
      } catch (err) {
        const pending = this.pendingHistoryRequests.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingHistoryRequests.delete(key);
        }
        resolvePromise({
          ok: false,
          error: `Failed to relay to mirror-agent: ${String(err)}`,
          status: 502,
        });
      }
    });
  }

  /** Called from ws-mirror-plugin when the agent sends back a
   *  MirrorHistoryChunkFrame. */
  resolveHistoryChunk(
    sid: string,
    requestId: string,
    result: {
      frames?: MirrorEventFrame[];
      exhausted?: boolean;
      error?: string;
    },
  ): void {
    const key = `${sid}:${requestId}`;
    const pending = this.pendingHistoryRequests.get(key);
    if (!pending) return;
    if (result.error && (!result.frames || result.frames.length === 0)) {
      pending.reject({
        status: 502,
        message: result.error,
      });
      return;
    }
    pending.resolve({
      frames: Array.isArray(result.frames) ? result.frames : [],
      exhausted: Boolean(result.exhausted),
    });
  }

  /** Broadcast an ephemeral thinking-status update to a session's
   *  watchers. Not stored in the transcript; purely live-view signal. */
  broadcastThinking(
    sid: string,
    payload: { active: boolean; startedAt?: number; tool?: string | null },
  ): void {
    const entry = this.sessions.get(sid);
    if (!entry) return;
    const msg = JSON.stringify({
      event: "mirror:thinking",
      sid,
      active: payload.active,
      ...(typeof payload.startedAt === "number"
        ? { startedAt: payload.startedAt }
        : {}),
      ...(payload.tool !== undefined ? { tool: payload.tool } : {}),
    });
    for (const w of entry.watchers) {
      try {
        w.ws.send(msg);
      } catch {
        // ignore per-watcher send failures
      }
    }
  }
}

function toSummary(entry: MirrorSessionEntry): MirrorSessionSummary {
  return {
    sid: entry.sid,
    owner_agent: entry.ownerAgent,
    cwd: entry.cwd,
    created_at: entry.createdAt.toISOString(),
    last_event_at: entry.lastEventAt.toISOString(),
    closed_at: entry.closedAt ? entry.closedAt.toISOString() : null,
    watcher_count: entry.watchers.size,
    transcript_len: entry.transcript.length,
  };
}

// ── Elysia plugin (REST /api/mirror/*) ────────────────────────────────────

export interface MirrorPluginDeps {
  mirrorRegistry: MirrorRegistry;
}

export function mirrorPlugin(deps: MirrorPluginDeps): Elysia {
  const { mirrorRegistry } = deps;

  return (
    new Elysia({ prefix: "/api/mirror" })
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
        const remote = remoteKeyFor(request);
        if (!sessionCreateLimiter.allow(remote)) {
          const waitMs = sessionCreateLimiter.retryAfterMs(remote);
          set.status = 429;
          set.headers["retry-after"] = String(
            Math.max(1, Math.ceil(waitMs / 1000)),
          );
          return { error: "Rate limit: too many session creations." };
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
        return {
          sid: result.entry.sid,
          restored: result.restored,
        };
      })

      .get("/sessions/all", () => {
        // All live mirror sessions. The hub sits on a trusted network
        // (LAN / Tailscale / reverse-proxy with auth), so this listing is
        // not further gated.
        return mirrorRegistry.listAll();
      })

      .get("/sessions", ({ query, set }) => {
        const owner = (query as Record<string, string | undefined>).owner;
        if (!owner) {
          set.status = 400;
          return { error: "Missing required query: owner" };
        }
        return mirrorRegistry.listOwnedBy(owner);
      })

      .get("/:sid/transcript", ({ params, set }) => {
        const found = mirrorRegistry.getSession(params.sid);
        if (!found.ok) {
          set.status = found.status;
          return { error: found.error };
        }
        const entry = found.entry;
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

      .post("/:sid/close", ({ params, set }) => {
        const found = mirrorRegistry.getSession(params.sid);
        if (!found.ok) {
          set.status = found.status;
          return { error: found.error };
        }
        mirrorRegistry.closeSession(params.sid, "exit");
        return { closed: true };
      })

      /**
       * POST /:sid/rename — explicit rename of a SINGLE session's owner_agent.
       * Scoped to this sid only. Fork sessions sharing the same cwd
       * (and thus the same owner_agent) each need their own call —
       * otherwise renaming one sibling's MCP would misattribute the
       * others. Broadcasts mirror:owner_renamed so open dashboards
       * update the row in place.
       */
      .post("/:sid/rename", ({ params, body, set }) => {
        const payload = body as { owner_agent?: string };
        const next = payload.owner_agent;
        if (!next || typeof next !== "string" || next.trim().length === 0) {
          set.status = 400;
          return { error: "Missing required field: owner_agent" };
        }
        const result = mirrorRegistry.renameSession(params.sid, next);
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return { ok: true, sid: params.sid, owner_agent: next };
      })

      .get("/archive/:sid", ({ params, set }) => {
        // Archive lookup reads directly from the persistence store. The hub
        // runs on a trusted network so no further auth is applied.
        const archived = mirrorRegistry.store.loadArchived(params.sid);
        if (!archived) {
          set.status = 404;
          return { error: "Archive not found." };
        }
        return archived;
      })

      .post("/:sid/inject", ({ params, body, set, request }) => {
        const found = mirrorRegistry.getSession(params.sid);
        if (!found.ok) {
          set.status = found.status;
          return { error: found.error };
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
        // Two-tier rate limit: a burst floor (one call per 250ms) plus an
        // hourly ceiling (CLAUDE_NET_MIRROR_INJECT_RPM per minute, default 20).
        if (!injectBurstLimiter.allow(params.sid)) {
          set.status = 429;
          set.headers["retry-after"] = "1";
          return { error: "Rate limit: bursts under 250ms rejected." };
        }
        if (!injectMinuteLimiter.allow(params.sid)) {
          const waitMs = injectMinuteLimiter.retryAfterMs(params.sid);
          set.status = 429;
          set.headers["retry-after"] = String(
            Math.max(1, Math.ceil(waitMs / 1000)),
          );
          return {
            error: `Rate limit: ${INJECT_RPM} injects per minute.`,
          };
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
      })

      /**
       * POST /:sid/paste — oversized-prompt path. The web compose box falls back
       * to this when the payload exceeds the inject cap: hub relays the blob to
       * the mirror-agent, which writes it to a local temp file; hub then injects
       * `@<path>` via the existing tmux path so the user's Claude picks it up
       * with the Read tool.
       */
      .post("/:sid/paste", async ({ params, body, set, request }) => {
        const found = mirrorRegistry.getSession(params.sid);
        if (!found.ok) {
          set.status = found.status;
          return { error: found.error };
        }
        const payload = body as { text?: string; watcher?: string };
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text.trim().length === 0) {
          set.status = 400;
          return { error: "Empty paste." };
        }
        if (Buffer.byteLength(text, "utf8") > MAX_PASTE_BYTES) {
          set.status = 413;
          return {
            error: `Paste exceeds ${MAX_PASTE_BYTES} bytes (cap: ${Math.floor(MAX_PASTE_BYTES / (1024 * 1024))} MB).`,
          };
        }
        if (!injectBurstLimiter.allow(params.sid)) {
          set.status = 429;
          set.headers["retry-after"] = "1";
          return { error: "Rate limit: bursts under 250ms rejected." };
        }
        if (!injectMinuteLimiter.allow(params.sid)) {
          const waitMs = injectMinuteLimiter.retryAfterMs(params.sid);
          set.status = 429;
          set.headers["retry-after"] = String(
            Math.max(1, Math.ceil(waitMs / 1000)),
          );
          return {
            error: `Rate limit: ${INJECT_RPM} injects per minute.`,
          };
        }
        const watcher = sanitizeWatcher(
          payload.watcher ?? request.headers.get("user-agent") ?? "unknown",
        );
        const pasted = await mirrorRegistry.relayPaste(
          params.sid,
          text,
          watcher,
          PASTE_TIMEOUT_MS,
        );
        if (!pasted.ok) {
          set.status = pasted.status;
          return { error: pasted.error };
        }
        // Auto-inject `@<path>` so Claude reads the file immediately.
        const reference = `@${pasted.path}`;
        const relay = mirrorRegistry.relayInject(
          params.sid,
          reference,
          watcher,
        );
        if (!relay.ok) {
          // File is written but inject failed — surface both.
          set.status = relay.status;
          return {
            error: `Paste saved to ${pasted.path} but inject failed: ${relay.error}`,
            path: pasted.path,
          };
        }
        return {
          accepted: true,
          path: pasted.path,
          reference,
          bytes: Buffer.byteLength(text, "utf8"),
          seq: relay.seq,
        };
      })

      /**
       * GET /config — client hints so the dashboard can size-check before POST.
       * Public (no session needed) because it's just limits, not data.
       */
      .get("/config", () => ({
        inject_max_kb: Math.floor(MAX_INJECT_BYTES / 1024),
        paste_max_mb: Math.floor(MAX_PASTE_BYTES / (1024 * 1024)),
        inject_rpm: INJECT_RPM,
      }))

      /**
       * POST /:sid/stop — send Escape to the session's tmux pane.
       * Fire-and-forget; response is just confirmation that the frame
       * was relayed.
       */
      .post("/:sid/stop", ({ params, set, request }) => {
        const found = mirrorRegistry.getSession(params.sid);
        if (!found.ok) {
          set.status = found.status;
          return { error: found.error };
        }
        if (!injectBurstLimiter.allow(params.sid)) {
          set.status = 429;
          set.headers["retry-after"] = "1";
          return { error: "Rate limit: bursts under 250ms rejected." };
        }
        const watcher = sanitizeWatcher(
          request.headers.get("user-agent") ?? "unknown",
        );
        const result = mirrorRegistry.relayStop(params.sid, watcher);
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return { accepted: true };
      })

      /**
       * GET /:sid/commands — list slash commands available to this
       * session's Claude Code (built-ins + user/project/plugin commands
       * on the agent's host). The response is agent-scoped and can leak
       * plugin names from the user's install — trusted-network only.
       */
      .get("/:sid/commands", async ({ params, set }) => {
        const found = mirrorRegistry.getSession(params.sid);
        if (!found.ok) {
          set.status = found.status;
          return { error: found.error };
        }
        const result = await mirrorRegistry.relayListCommands(
          params.sid,
          COMMANDS_TIMEOUT_MS,
        );
        if (!result.ok) {
          set.status = result.status;
          return { error: result.error };
        }
        return { commands: result.commands };
      })
  );
}

// ── Inject limits & helpers ───────────────────────────────────────────────

const MAX_INJECT_BYTES = (() => {
  const raw = Number(process.env.CLAUDE_NET_MIRROR_INJECT_MAX_KB);
  const kb = Number.isFinite(raw) && raw > 0 ? raw : 512;
  return kb * 1024;
})();

const INJECT_RPM = (() => {
  const raw = Number(process.env.CLAUDE_NET_MIRROR_INJECT_RPM);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
})();

/** Oversized-paste cap. Default 64 MB — arbitrary but DoS-safe. */
const MAX_PASTE_BYTES = (() => {
  const raw = Number(process.env.CLAUDE_NET_MIRROR_PASTE_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 64;
  return mb * 1024 * 1024;
})();

/** Timeout for the agent to ack a paste write. */
const PASTE_TIMEOUT_MS = 10_000;

/** Timeout for the agent to return its slash-command catalog. */
const COMMANDS_TIMEOUT_MS = 5_000;

// One inject per 250ms (burst control) AND at most INJECT_RPM per minute.
const injectBurstLimiter = new RateLimiter({ max: 1, windowMs: 250 });
const injectMinuteLimiter = new RateLimiter({
  max: INJECT_RPM,
  windowMs: 60_000,
});

// 30 session creations per 5 minutes per remote IP.
const sessionCreateLimiter = new RateLimiter({
  max: 30,
  windowMs: 5 * 60_000,
});

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

function remoteKeyFor(request: Request): string {
  // Best-effort remote identifier for rate-limit keying. X-Forwarded-For wins
  // when the hub is behind a reverse proxy; otherwise fall back to host.
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("host") ?? "unknown";
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
      const asParam = q.as;

      const found = mirrorRegistry.getSession(sid);
      if (!found.ok) {
        ws.send(JSON.stringify({ event: "error", message: found.error }));
        ws.close(1008, found.error);
        return;
      }
      const entry = found.entry;

      const sendRaw = (data: string): void => {
        ws.send(data);
      };

      if (asParam === "agent") {
        mirrorRegistry.setAgentConnection(sid, {
          ws: { send: sendRaw },
          wsIdentity: ws.raw,
          close: () => {
            try {
              ws.close();
            } catch {
              // ignore
            }
          },
        });
        connMeta.set(ws.raw, { role: "agent", sid });
        ws.send(JSON.stringify({ event: "mirror:agent_ready", sid }));
        return;
      }

      const watcher: SessionWatcher = {
        ws: { send: sendRaw },
        wsIdentity: ws.raw,
        id: crypto.randomUUID(),
        close: () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      };
      mirrorRegistry.addWatcher(sid, watcher);
      connMeta.set(ws.raw, { role: "watcher", sid, watcher });

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

      const data =
        typeof rawData === "string" ? safeJsonParse(rawData) : rawData;
      if (!data || typeof data !== "object") return;

      // Watcher (dashboard) inbound: only `request_history` is recognized
      // today. Reply goes only to this watcher's WS so multiple dashboards
      // viewing the same session don't get cross-routed history.
      if (meta.role === "watcher" && "action" in data) {
        const frame = data as { action: string } & Record<string, unknown>;
        if (frame.action === "request_history") {
          const beforeUuid =
            typeof frame.before_uuid === "string" ? frame.before_uuid : null;
          const limit =
            typeof frame.limit === "number" && Number.isFinite(frame.limit)
              ? Math.max(1, Math.min(1000, Math.floor(frame.limit)))
              : 200;
          mirrorRegistry
            .relayHistoryRequest(meta.sid, beforeUuid, limit, 15_000)
            .then((res) => {
              if (res.ok) {
                ws.send(
                  JSON.stringify({
                    event: "mirror:history_chunk",
                    sid: meta.sid,
                    frames: res.frames,
                    exhausted: res.exhausted,
                  }),
                );
              } else {
                ws.send(
                  JSON.stringify({
                    event: "mirror:history_error",
                    sid: meta.sid,
                    error: res.error,
                  }),
                );
              }
            })
            .catch((err: unknown) => {
              ws.send(
                JSON.stringify({
                  event: "mirror:history_error",
                  sid: meta.sid,
                  error: String(err),
                }),
              );
            });
        }
        return;
      }

      if (meta.role !== "agent") return;
      if (!("action" in data)) return;

      const frame = data as { action: string } & Record<string, unknown>;
      if (frame.action === "mirror_event" && frame.sid === meta.sid) {
        mirrorRegistry.recordEvent(
          meta.sid,
          frame as unknown as MirrorEventFrame,
        );
      } else if (
        frame.action === "mirror_paste_done" &&
        frame.sid === meta.sid &&
        typeof frame.requestId === "string"
      ) {
        mirrorRegistry.resolvePaste(meta.sid, frame.requestId, {
          path: typeof frame.path === "string" ? frame.path : undefined,
          error: typeof frame.error === "string" ? frame.error : undefined,
        });
      } else if (
        frame.action === "mirror_commands_done" &&
        frame.sid === meta.sid &&
        typeof frame.requestId === "string"
      ) {
        mirrorRegistry.resolveListCommands(meta.sid, frame.requestId, {
          commands: Array.isArray(frame.commands)
            ? (frame.commands as SlashCommand[])
            : undefined,
          error: typeof frame.error === "string" ? frame.error : undefined,
        });
      } else if (
        frame.action === "mirror_history_chunk" &&
        frame.sid === meta.sid &&
        typeof frame.requestId === "string"
      ) {
        mirrorRegistry.resolveHistoryChunk(meta.sid, frame.requestId, {
          frames: Array.isArray(frame.frames)
            ? (frame.frames as MirrorEventFrame[])
            : undefined,
          exhausted:
            typeof frame.exhausted === "boolean" ? frame.exhausted : undefined,
          error: typeof frame.error === "string" ? frame.error : undefined,
        });
      } else if (frame.action === "mirror_thinking" && frame.sid === meta.sid) {
        mirrorRegistry.broadcastThinking(meta.sid, {
          active: Boolean(frame.active),
          startedAt:
            typeof frame.startedAt === "number" ? frame.startedAt : undefined,
          tool: typeof frame.tool === "string" ? frame.tool : null,
        });
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
