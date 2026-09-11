// Keep-cache-warm timer for mirror sessions.
//
// Claude Code's API prompt cache for a session expires after roughly an
// hour without a request. A session left idle close to that long pays a
// full cache write on its next real message instead of a cheap cache
// read. This module watches each opted-in session's idle time and, once
// it crosses the configured interval, sends a tiny prompt through the
// same inject relay the delayed-inject scheduler uses, so Claude Code
// makes one API call and the cache is refreshed.
//
// Two safeguards keep this from becoming a runaway loop. A ping floor
// (`recheckMs`) enforced both at enable time and on every check stops a
// disable/enable toggle from injecting again right after a ping already
// fired. A consecutive-ping cap (`maxConsecutivePings`) disables a
// session no real user prompt has touched across that many pings in a
// row, so an abandoned session doesn't get pinged forever.
//
// Modeled on scheduler.ts: state lives in memory only, timers are
// unref'd so they never hold the process open, and every transition is
// reported through `notify` rather than acted on directly, so the
// caller decides what a transition means for the registry and the
// event log. Unlike the scheduler, an entry here is keyed by (host,
// sid) rather than a generated id, and re-arms itself indefinitely
// instead of reaching a terminal state.

import { Buffer } from "node:buffer";
import type { MirrorActivityState } from "@/shared/types";
import type { InjectAttempt, InjectFn } from "./scheduler";

const DEFAULT_INTERVAL_MINUTES = 50;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
export const DEFAULT_TEXT =
  "Keep-warm ping: reply with one word and take no other action.";
// Re-check delay used when a session is idle long enough but not in a
// state that allows a ping (busy, awaiting a permission prompt, the
// mirror-agent detached, or the previous ping being too recent).
const RECHECK_MS = 5 * 60 * 1000;
// Consecutive pings a session can receive with no real user prompt in
// between before the timer gives up on it.
const DEFAULT_MAX_CONSECUTIVE_PINGS = 12;

/**
 * Same cap `POST /inject` enforces (`CLAUDE_NET_MIRROR_INJECT_MAX_KB`).
 * Duplicated rather than imported from mirror.ts: mirror.ts imports
 * `KEEP_WARM_INTERVAL_MS` from this file, and importing back would make
 * the two modules circular.
 */
export const MAX_INJECT_BYTES = (() => {
  const raw = Number(process.env.CLAUDE_NET_MIRROR_INJECT_MAX_KB);
  const kb = Number.isFinite(raw) && raw > 0 ? raw : 512;
  return kb * 1024;
})();

/**
 * Parse `CLAUDE_NET_KEEP_WARM_MINUTES`. Blank or unparsable input falls
 * back to the default instead of the 1-minute clamp floor, so a typo in
 * the env var degrades to the default cadence rather than pinging every
 * session almost continuously. A parsed value is clamped to
 * [MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES].
 */
export function parseKeepWarmMinutes(raw: string | undefined): number {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) return DEFAULT_INTERVAL_MINUTES;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, parsed));
}

export const KEEP_WARM_INTERVAL_MS =
  parseKeepWarmMinutes(process.env.CLAUDE_NET_KEEP_WARM_MINUTES) * 60 * 1000;

/**
 * Sanitize `CLAUDE_NET_KEEP_WARM_TEXT`. Internal whitespace runs
 * (including newlines) collapse to single spaces and the result is
 * trimmed. Falls back to the default when empty, over
 * `MAX_INJECT_BYTES`, or starting with "/" or "!" - either would run a
 * slash command or a shell command in the Claude Code prompt instead of
 * starting an ordinary chat turn.
 */
export function sanitizeKeepWarmText(raw: string | undefined): string {
  const collapsed =
    typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (collapsed.length === 0) return DEFAULT_TEXT;
  if (Buffer.byteLength(collapsed, "utf8") > MAX_INJECT_BYTES) {
    return DEFAULT_TEXT;
  }
  if (collapsed.startsWith("/") || collapsed.startsWith("!")) {
    return DEFAULT_TEXT;
  }
  return collapsed;
}

export const KEEP_WARM_TEXT = sanitizeKeepWarmText(
  process.env.CLAUDE_NET_KEEP_WARM_TEXT,
);

export interface KeepWarmSessionState {
  /** Epoch ms of the session's last recorded mirror event. */
  lastEventAt: number;
  activity: MirrorActivityState;
  /** True when a permission prompt is pending. */
  awaitingUser: boolean;
  /** False once the session has closed. */
  open: boolean;
  /** True while a mirror-agent WebSocket is bound to the session. */
  attached: boolean;
  /** Epoch ms of the most recent real user prompt (not the keep-warm
   *  ping's own turn); 0 when none. Used to tell an idle-but-watched
   *  session apart from one nobody has touched in days. */
  lastUserPromptAt: number;
}

export type KeepWarmAction =
  | "enabled"
  | "disabled"
  | "fired"
  | "skipped"
  | "failed";

export type KeepWarmSkipReason =
  | "busy"
  | "awaiting_user"
  | "detached"
  | "not_idle"
  | "recently_pinged"
  | "abandoned";

export interface KeepWarmInfo {
  sid: string;
  host?: string;
  /** Epoch ms the timer is next due to check. */
  nextCheckAt: number;
  /** Why the last check did not ping, when it did not. */
  lastSkipReason?: KeepWarmSkipReason;
  lastError?: string;
}

export type KeepWarmNotifyFn = (
  action: KeepWarmAction,
  info: KeepWarmInfo,
) => void;

export interface KeepWarmOptions {
  fireInject: InjectFn;
  getState: (sid: string, host?: string) => KeepWarmSessionState | null;
  /** Idle interval before a ping. Defaults to the env-configured value. */
  intervalMs?: number;
  /** Re-check delay used when a check can't ping, and the floor between
   *  two pings of the same session. Defaults to RECHECK_MS. */
  recheckMs?: number;
  /** Prompt text sent on each ping. Defaults to the env-configured value. */
  text?: string;
  /** Consecutive pings with no real user prompt before a session is
   *  disabled as abandoned. Defaults to DEFAULT_MAX_CONSECUTIVE_PINGS. */
  maxConsecutivePings?: number;
  /** Clock injection point for tests. */
  now?: () => number;
}

export type KeepWarmEnableResult =
  | { ok: true; info: KeepWarmInfo }
  | { ok: false; error: string; status: 404 | 409 };

interface Item extends KeepWarmInfo {
  timer: ReturnType<typeof setTimeout> | null;
}

/** The registry supports the same sid on two hosts, so entries are
 *  keyed by (host, sid) rather than sid alone. */
function keyFor(sid: string, host: string | undefined): string {
  return `${host ?? ""}|${sid}`;
}

/** Inverse of keyFor: the sid half of a composite key. */
function sidOfKey(key: string): string {
  const i = key.indexOf("|");
  return i >= 0 ? key.slice(i + 1) : key;
}

export class KeepWarm {
  private items = new Map<string, Item>();
  // Survives a plain disable(): the ping floor needs to remember the
  // last ping across a toggle, not just while a session is enabled.
  // disable(sid, host, { forget: true }) drops the entry instead, for
  // the session-closed path where no future re-enable should inherit
  // it.
  private lastPingAt = new Map<string, number>();
  private consecutivePings = new Map<string, number>();
  private fireInject: InjectFn;
  private getState: (sid: string, host?: string) => KeepWarmSessionState | null;
  private _intervalMs: number;
  private recheckMs: number;
  private _text: string;
  private maxConsecutivePings: number;
  private now: () => number;
  private notify: KeepWarmNotifyFn = () => {};
  private stopped = false;

  constructor(opts: KeepWarmOptions) {
    this.fireInject = opts.fireInject;
    this.getState = opts.getState;
    this._intervalMs = opts.intervalMs ?? KEEP_WARM_INTERVAL_MS;
    this.recheckMs = opts.recheckMs ?? RECHECK_MS;
    this._text = opts.text ?? KEEP_WARM_TEXT;
    this.maxConsecutivePings =
      opts.maxConsecutivePings ?? DEFAULT_MAX_CONSECUTIVE_PINGS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Set the per-transition callback (registry mirror + event log). */
  setNotify(fn: KeepWarmNotifyFn): void {
    this.notify = fn;
  }

  get intervalMs(): number {
    return this._intervalMs;
  }

  /** The resolved ping text (env-configured default unless overridden
   *  via KeepWarmOptions.text), so a caller that needs to recognize the
   *  ping's own reply reads the same value this instance actually
   *  sends rather than re-resolving the env var itself. */
  get text(): string {
    return this._text;
  }

  enable(sid: string, host?: string): KeepWarmEnableResult {
    if (this.stopped) {
      return { ok: false, error: "Keep-warm is shut down.", status: 409 };
    }
    const key = keyFor(sid, host);
    const existing = this.items.get(key);
    if (existing) {
      return { ok: true, info: publicView(existing) };
    }
    const state = this.getState(sid, host);
    if (!state) {
      return { ok: false, error: `Session '${sid}' not found.`, status: 404 };
    }
    if (!state.open) {
      return { ok: false, error: "Session is closed.", status: 409 };
    }
    const nowMs = this.now();
    const lastPingAt = this.lastPingAt.get(key) ?? Number.NEGATIVE_INFINITY;
    const dueIn = Math.max(
      0,
      state.lastEventAt + this._intervalMs - nowMs,
      lastPingAt + this.recheckMs - nowMs,
    );
    const item: Item = {
      sid,
      ...(host ? { host } : {}),
      nextCheckAt: nowMs + dueIn,
      timer: null,
    };
    item.timer = this.arm(key, dueIn);
    this.items.set(key, item);
    this.emit("enabled", item);
    return { ok: true, info: publicView(item) };
  }

  /** Disables the session at `host` when given, otherwise every host it
   *  is enabled on. Returns false when nothing was enabled to begin
   *  with. `forget`, when true, also drops the ping-floor timestamp for
   *  this (host, sid) - or every host, when host is omitted - so a
   *  session that reopens under the same sid doesn't inherit a stale
   *  floor from before it closed. Pass it from the session-closed path
   *  only; a plain user-initiated toggle-off should keep the floor. */
  disable(sid: string, host?: string, opts?: { forget?: boolean }): boolean {
    const keys: string[] = [];
    if (host !== undefined) {
      const key = keyFor(sid, host);
      if (this.items.has(key)) keys.push(key);
    } else {
      for (const [key, item] of this.items) {
        if (item.sid === sid) keys.push(key);
      }
    }
    for (const key of keys) {
      const item = this.items.get(key);
      if (item) this.removeItem(key, item, undefined);
    }
    if (opts?.forget) {
      if (host !== undefined) {
        this.lastPingAt.delete(keyFor(sid, host));
      } else {
        for (const key of Array.from(this.lastPingAt.keys())) {
          if (sidOfKey(key) === sid) this.lastPingAt.delete(key);
        }
      }
    }
    return keys.length > 0;
  }

  /** Same (host, sid) lookup rule as `disable`: with a host, checks
   *  that one entry; without, whether any host has it enabled. */
  isEnabled(sid: string, host?: string): boolean {
    if (host !== undefined) return this.items.has(keyFor(sid, host));
    for (const item of this.items.values()) {
      if (item.sid === sid) return true;
    }
    return false;
  }

  /** Clear every timer and refuse further enable() calls. Called on hub
   *  shutdown so the process can exit. Emits "disabled" for each item
   *  it clears so the registry flag and dashboards reset instead of
   *  showing a toggle the timer no longer backs. */
  stop(): void {
    this.stopped = true;
    for (const [key, item] of Array.from(this.items.entries())) {
      this.removeItem(key, item, undefined);
    }
  }

  private arm(key: string, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => this.check(key), Math.max(0, ms));
    unref(t);
    return t;
  }

  private rearm(item: Item, ms: number): void {
    const delay = Math.max(0, ms);
    item.nextCheckAt = this.now() + delay;
    item.timer = this.arm(keyFor(item.sid, item.host), delay);
  }

  private check(key: string): void {
    const item = this.items.get(key);
    if (!item) return;
    item.timer = null;
    item.lastSkipReason = undefined;
    item.lastError = undefined;

    const state = this.getState(item.sid, item.host);
    if (!state || !state.open) {
      this.removeItem(key, item, undefined);
      return;
    }

    const nowMs = this.now();
    const elapsed = nowMs - state.lastEventAt;
    if (elapsed < this._intervalMs) {
      // Normal quiet path: the session is still active. Re-arm for the
      // remainder without emitting, so a live session doesn't spam the
      // event log on every check.
      item.lastSkipReason = "not_idle";
      this.rearm(item, this._intervalMs - elapsed);
      return;
    }

    const lastPingAt = this.lastPingAt.get(key) ?? Number.NEGATIVE_INFINITY;
    const sincePing = nowMs - lastPingAt;
    if (sincePing < this.recheckMs) {
      // A ping already fired more recently than the floor allows (an
      // enable/disable/enable cycle can land here). Re-arm for the
      // remainder rather than pinging again immediately.
      item.lastSkipReason = "recently_pinged";
      this.rearm(item, this.recheckMs - sincePing);
      return;
    }

    if (!state.attached) {
      item.lastSkipReason = "detached";
      this.rearm(item, this.recheckMs);
      this.emit("skipped", item);
      return;
    }

    // "background" is not a skip: Claude Code is at its prompt, the
    // injection is accepted, and the cache is exactly what needs
    // keeping warm while the background work runs.
    if (state.activity === "busy") {
      item.lastSkipReason = "busy";
      this.rearm(item, this.recheckMs);
      this.emit("skipped", item);
      return;
    }

    // A permission prompt is a real block on the user: injecting sends
    // text plus Enter into the pane, and Enter here would answer the
    // prompt instead of the intended keep-warm ping.
    if (state.awaitingUser) {
      item.lastSkipReason = "awaiting_user";
      this.rearm(item, this.recheckMs);
      this.emit("skipped", item);
      return;
    }

    // A real user prompt more recent than the last ping means someone
    // is actually using the session; that resets the streak. Otherwise
    // this ping would be one more with nobody around to see the reply.
    let count = this.consecutivePings.get(key) ?? 0;
    if (state.lastUserPromptAt > lastPingAt) count = 0;
    if (count + 1 > this.maxConsecutivePings) {
      this.consecutivePings.delete(key);
      this.removeItem(key, item, "abandoned");
      return;
    }

    let result: InjectAttempt;
    try {
      result = this.fireInject(item.sid, this.text, "keep-warm", item.host);
    } catch (err) {
      result = { ok: false, error: String(err) };
    }

    if (result.ok) {
      this.lastPingAt.set(key, nowMs);
      this.consecutivePings.set(key, count + 1);
      this.rearm(item, this._intervalMs);
      this.emit("fired", item);
      return;
    }

    item.lastError = result.error ?? "delivery failed";
    this.rearm(item, this.recheckMs);
    this.emit("failed", item);
  }

  /** Clears the timer, removes the item and its ping-streak counter,
   *  and emits "disabled". `reason`, when given, is the skip reason the
   *  emitted info reports (used for the abandoned-cap disable); a plain
   *  disable passes undefined so no stale reason lingers on the event. */
  private removeItem(
    key: string,
    item: Item,
    reason: KeepWarmSkipReason | undefined,
  ): void {
    if (item.timer) clearTimeout(item.timer);
    item.timer = null;
    item.lastSkipReason = reason;
    item.lastError = undefined;
    this.items.delete(key);
    this.consecutivePings.delete(key);
    this.emit("disabled", item);
  }

  private emit(action: KeepWarmAction, item: Item): void {
    try {
      this.notify(action, publicView(item));
    } catch {
      // A misbehaving notifier must not break the timer.
    }
  }
}

function publicView(item: Item): KeepWarmInfo {
  return {
    sid: item.sid,
    ...(item.host ? { host: item.host } : {}),
    nextCheckAt: item.nextCheckAt,
    ...(item.lastSkipReason ? { lastSkipReason: item.lastSkipReason } : {}),
    ...(item.lastError ? { lastError: item.lastError } : {}),
  };
}

function unref(t: ReturnType<typeof setTimeout>): void {
  if (t && typeof t === "object" && "unref" in t) {
    (t as { unref(): void }).unref();
  }
}
