// Delayed-inject scheduler for dashboard-queued prompts.
//
// The dashboard lets a user long-press Transmit and pick a delay ("send
// in 1h 30m"). That request lands here: the hub holds the prompt in
// memory and fires it into the session's mirror-agent when the delay
// elapses. Deliberately in-memory only — a hub restart drops the queue,
// which the dashboard surfaces as a non-durable "queued" strip. Adding
// disk persistence would be a separate, larger change (see the design
// notes on boot-recovery and cross-restart at-most-once semantics).
//
// Firing goes through `fireInject`, injected by the hub so this module
// stays decoupled from MirrorRegistry. If the target is offline at fire
// time (session gone, agent disconnected, transport error) the item is
// retried with a fixed backoff until a deadline measured from its
// fireAt, then marked `failed`. Each state change is reported via
// `notify` so the owning session's watchers (and the event log) can
// reflect it live.

import type {
  ScheduledInjectInfo,
  ScheduledInjectStatus,
} from "@/shared/types";

const DEFAULT_RETRY_DEADLINE_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_BACKOFF_MS = 10_000;
// How long a terminal item (sent/failed/cancelled) lingers in the list
// so a just-attached dashboard can still see the outcome before it's
// pruned from memory.
const DEFAULT_RETAIN_MS = 60_000;
// Upper bound on a delay. This queue is non-durable, so a multi-day
// timer would almost certainly be lost to a deploy-restart before it
// fired — reject it rather than pretend it will survive.
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

export interface InjectAttempt {
  ok: boolean;
  error?: string;
}

export type InjectFn = (
  sid: string,
  text: string,
  watcher: string,
  host: string | undefined,
) => InjectAttempt;

export type ScheduleNotifyFn = (
  action: ScheduledInjectStatus | "added",
  item: ScheduledInjectInfo,
) => void;

interface Item extends ScheduledInjectInfo {
  timer: ReturnType<typeof setTimeout> | null;
  pruneTimer: ReturnType<typeof setTimeout> | null;
}

export interface SchedulerOptions {
  fireInject: InjectFn;
  /** Window after fireAt within which an offline target is retried. */
  retryDeadlineMs?: number;
  /** Backoff between offline retries. */
  retryBackoffMs?: number;
  /** How long terminal items are retained for UI visibility. */
  retainMs?: number;
  /** Clock injection point for tests. */
  now?: () => number;
}

export type ScheduleResult =
  | { ok: true; item: ScheduledInjectInfo }
  | { ok: false; error: string };

export class Scheduler {
  private items = new Map<string, Item>();
  private fireInject: InjectFn;
  private retryDeadlineMs: number;
  private retryBackoffMs: number;
  private retainMs: number;
  private now: () => number;
  private notify: ScheduleNotifyFn = () => {};

  constructor(opts: SchedulerOptions) {
    this.fireInject = opts.fireInject;
    this.retryDeadlineMs = opts.retryDeadlineMs ?? DEFAULT_RETRY_DEADLINE_MS;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Wire the per-transition callback (watcher fan-out + event log). */
  setNotify(fn: ScheduleNotifyFn): void {
    this.notify = fn;
  }

  /** Largest accepted delay, exposed so the API layer can validate. */
  get maxDelayMs(): number {
    return MAX_DELAY_MS;
  }

  schedule(params: {
    sid: string;
    host?: string;
    text: string;
    watcher: string;
    delayMs: number;
  }): ScheduleResult {
    const delay = Math.floor(params.delayMs);
    if (!Number.isFinite(delay) || delay <= 0) {
      return { ok: false, error: "delayMs must be a positive number." };
    }
    if (delay > MAX_DELAY_MS) {
      return {
        ok: false,
        error: `delayMs exceeds the ${MAX_DELAY_MS}ms (24h) maximum.`,
      };
    }
    const nowMs = this.now();
    const id = crypto.randomUUID();
    const item: Item = {
      id,
      sid: params.sid,
      ...(params.host ? { host: params.host } : {}),
      text: params.text,
      watcher: params.watcher,
      fireAt: nowMs + delay,
      createdAt: nowMs,
      status: "pending",
      attempts: 0,
      timer: null,
      pruneTimer: null,
    };
    this.items.set(id, item);
    item.timer = this.arm(id, delay);
    this.emit("added", item);
    return { ok: true, item: publicView(item) };
  }

  cancel(id: string): { ok: true } | { ok: false; error: string } {
    const item = this.items.get(id);
    if (!item) return { ok: false, error: "Scheduled inject not found." };
    if (item.status !== "pending") {
      return { ok: false, error: `Cannot cancel a ${item.status} inject.` };
    }
    if (item.timer) clearTimeout(item.timer);
    item.timer = null;
    item.status = "cancelled";
    this.emit("cancelled", item);
    this.schedulePrune(item);
    return { ok: true };
  }

  /** List items, optionally filtered to one session. Pending first, then
   *  most-recently-created. */
  list(sid?: string): ScheduledInjectInfo[] {
    const out: ScheduledInjectInfo[] = [];
    for (const item of this.items.values()) {
      if (sid && item.sid !== sid) continue;
      out.push(publicView(item));
    }
    out.sort((a, b) => {
      const ap = a.status === "pending" ? 0 : 1;
      const bp = b.status === "pending" ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (ap === 0) return a.fireAt - b.fireAt;
      return b.createdAt - a.createdAt;
    });
    return out;
  }

  /** Clear every timer. Called on hub shutdown so the process can exit. */
  stop(): void {
    for (const item of this.items.values()) {
      if (item.timer) clearTimeout(item.timer);
      if (item.pruneTimer) clearTimeout(item.pruneTimer);
      item.timer = null;
      item.pruneTimer = null;
    }
    this.items.clear();
  }

  private arm(id: string, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => this.attempt(id), Math.max(0, ms));
    unref(t);
    return t;
  }

  private attempt(id: string): void {
    const item = this.items.get(id);
    if (!item || item.status !== "pending") return;
    item.timer = null;
    item.attempts++;

    let result: InjectAttempt;
    try {
      result = this.fireInject(item.sid, item.text, item.watcher, item.host);
    } catch (err) {
      result = { ok: false, error: String(err) };
    }

    if (result.ok) {
      item.status = "sent";
      item.lastError = undefined;
      this.emit("sent", item);
      this.schedulePrune(item);
      return;
    }

    item.lastError = result.error ?? "delivery failed";
    // Retry until the deadline, measured from the original fireAt so a
    // long-offline target doesn't retry forever.
    if (this.now() < item.fireAt + this.retryDeadlineMs) {
      item.timer = this.arm(id, this.retryBackoffMs);
      // Still pending, but attempts/lastError changed — upsert the row.
      this.emit("added", item);
      return;
    }
    item.status = "failed";
    this.emit("failed", item);
    this.schedulePrune(item);
  }

  private schedulePrune(item: Item): void {
    if (item.pruneTimer) clearTimeout(item.pruneTimer);
    item.pruneTimer = setTimeout(() => {
      this.items.delete(item.id);
    }, this.retainMs);
    unref(item.pruneTimer);
  }

  private emit(action: ScheduledInjectStatus | "added", item: Item): void {
    try {
      this.notify(action, publicView(item));
    } catch {
      // A misbehaving notifier must not break scheduling.
    }
  }
}

function publicView(item: Item): ScheduledInjectInfo {
  return {
    id: item.id,
    sid: item.sid,
    ...(item.host ? { host: item.host } : {}),
    text: item.text,
    watcher: item.watcher,
    fireAt: item.fireAt,
    createdAt: item.createdAt,
    status: item.status,
    attempts: item.attempts,
    ...(item.lastError ? { lastError: item.lastError } : {}),
  };
}

function unref(t: ReturnType<typeof setTimeout>): void {
  if (t && typeof t === "object" && "unref" in t) {
    (t as { unref(): void }).unref();
  }
}
