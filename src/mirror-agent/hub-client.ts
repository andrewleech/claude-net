// Lightweight reconnecting WebSocket client used by the mirror-agent to
// stream a single session's events to the hub at /ws/mirror/:sid. Mirrors
// the reconnect backoff (1s → 30s) used by the plugin in src/plugin/plugin.ts.
//
// One instance per mirror session. The mirror-agent creates the hub session
// over REST first (to claim an owner token), then opens the WS with that
// token.

import WebSocket from "ws";

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// If we receive nothing from the hub for this long, treat the socket as
// dead and force-close it. Without this, a suspend/resume can leave the
// kernel TCP socket in a zombie ESTAB state — readyState stays OPEN, no
// close fires, and reconnect never runs.
const WATCHDOG_TIMEOUT_MS = 31_000;
// The hub only sends native pings on /ws (plugin) connections, not on
// /ws/mirror or /ws/host. So this client drives its own keepalive: it
// pings every PING_INTERVAL_MS and resets the watchdog on the auto-pong
// the server (Bun) sends back. Interval is well under the watchdog so a
// single missed pong does not trip it.
const PING_INTERVAL_MS = 5_000;

export interface HubClientOptions {
  url: string;
  /** Called on every received text frame. */
  onMessage?: (raw: string) => void;
  /** Called once the socket transitions to OPEN. */
  onOpen?: () => void;
  /** Called on every close, including the one that triggers reconnect. */
  onClose?: (code: number, reason: string) => void;
  /** Called on transport errors (logged; no action required). */
  onError?: (err: Error) => void;
  /** Log prefix for stderr messages. Defaults to "claude-net/mirror". */
  logPrefix?: string;
}

export class HubClient {
  private url: string;
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private pingIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private opts: HubClientOptions;

  constructor(opts: HubClientOptions) {
    this.opts = opts;
    this.url = opts.url;
  }

  start(): void {
    this.closing = false;
    this.openOnce();
  }

  stop(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    this.clearPingInterval();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(data: string): boolean {
    if (!this.isOpen()) return false;
    try {
      // biome-ignore lint/style/noNonNullAssertion: checked by isOpen()
      this.ws!.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private openOnce(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.logError(`WebSocket construct failed: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      this.resetWatchdog();
      this.startPingInterval();
      this.opts.onOpen?.();
    });

    this.ws.on("message", (data: Buffer) => {
      this.resetWatchdog();
      this.opts.onMessage?.(data.toString());
    });

    // /ws/mirror and /ws/host don't get hub-side pings, so this client
    // pings the hub itself; Bun's WebSocket auto-replies with a pong.
    this.ws.on("pong", () => {
      this.resetWatchdog();
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString?.() ?? "";
      this.clearWatchdog();
      this.clearPingInterval();
      this.opts.onClose?.(code, reasonStr);
      this.ws = null;
      if (!this.closing) this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.opts.onError?.(err);
      // close will fire after — reconnect is scheduled there.
    });
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      this.logError(
        `No hub traffic for ${WATCHDOG_TIMEOUT_MS}ms — terminating socket`,
      );
      // terminate() bypasses the close handshake and synthesizes the
      // close event locally, which drives scheduleReconnect.
      try {
        this.ws?.terminate();
      } catch {
        // ignore — the close handler will still run
      }
    }, WATCHDOG_TIMEOUT_MS);
    if (
      this.watchdogTimer &&
      typeof this.watchdogTimer === "object" &&
      "unref" in this.watchdogTimer
    ) {
      this.watchdogTimer.unref();
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private startPingInterval(): void {
    this.clearPingInterval();
    this.pingIntervalTimer = setInterval(() => {
      try {
        this.ws?.ping();
      } catch {
        // ignore — watchdog will catch a truly dead socket
      }
    }, PING_INTERVAL_MS);
    if (
      this.pingIntervalTimer &&
      typeof this.pingIntervalTimer === "object" &&
      "unref" in this.pingIntervalTimer
    ) {
      this.pingIntervalTimer.unref();
    }
  }

  private clearPingInterval(): void {
    if (this.pingIntervalTimer) {
      clearInterval(this.pingIntervalTimer);
      this.pingIntervalTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openOnce();
    }, delay);
    if (
      this.reconnectTimer &&
      typeof this.reconnectTimer === "object" &&
      "unref" in this.reconnectTimer
    ) {
      this.reconnectTimer.unref();
    }
  }

  private logError(msg: string): void {
    const prefix = this.opts.logPrefix ?? "claude-net/mirror";
    process.stderr.write(`[${prefix}] ${msg}\n`);
  }
}
