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
// A socket that never completes its handshake (TCP accepted but the
// upgrade response never arrives — suspend/resume, a black-holed route,
// a half-dead proxy) sits in CONNECTING forever: `ws` has no handshake
// timeout and the kernel has nothing to retransmit, so no error and no
// close ever fire. Give the handshake a deadline of its own.
const CONNECT_TIMEOUT_MS = 20_000;

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
  /** Handshake deadline override. Defaults to CONNECT_TIMEOUT_MS; tests
   *  use a short value to exercise the stalled-handshake path. */
  connectTimeoutMs?: number;
}

export class HubClient {
  private url: string;
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private pingIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.retireCurrent();
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
    // Retire any socket still held. The handler guards below keep a stale
    // socket from interfering, but nothing else would ever close it, so
    // without this an extra start() would strand an ESTAB connection and
    // its fd for the life of the process.
    this.retireCurrent();
    let sock: WebSocket;
    try {
      sock = new WebSocket(this.url);
    } catch (err) {
      this.logError(`WebSocket construct failed: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = sock;

    // Handshake deadline. Cleared on open; on expiry the socket is
    // abandoned and a reconnect scheduled.
    const connectTimeoutMs = this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.logError(
        `Handshake did not complete within ${connectTimeoutMs}ms — abandoning socket`,
      );
      this.abandon(sock, 1006, "connect timeout");
    }, connectTimeoutMs);
    unrefTimer(this.connectTimer);

    // Every handler ignores sockets that are no longer `this.ws`: an
    // abandoned socket can still emit late events, and acting on them
    // would clobber the live socket's timers.
    sock.on("open", () => {
      if (this.ws !== sock) return;
      this.clearConnectTimeout();
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      this.resetWatchdog();
      this.startPingInterval();
      this.opts.onOpen?.();
    });

    sock.on("message", (data: Buffer) => {
      if (this.ws !== sock) return;
      this.resetWatchdog();
      this.opts.onMessage?.(data.toString());
    });

    // /ws/mirror and /ws/host don't get hub-side pings, so this client
    // pings the hub itself; Bun's WebSocket auto-replies with a pong.
    sock.on("pong", () => {
      if (this.ws !== sock) return;
      this.resetWatchdog();
    });

    sock.on("close", (code: number, reason: Buffer) => {
      this.abandon(sock, code, reason?.toString?.() ?? "");
    });

    sock.on("error", (err: Error) => {
      this.opts.onError?.(err);
      // close follows for an open socket; a socket that fails mid-handshake
      // may not emit one at all — the connect deadline covers that.
    });
  }

  /**
   * Retire `sock`, report the close, and queue the next connect attempt.
   * Every failure path funnels through here, including the ones where the
   * socket itself never emits a close (stalled handshake, zombie ESTAB).
   * That guarantee is what keeps a session from silently losing its hub
   * binding until the hub's orphan sweep ends it as `agent_timeout`.
   */
  private abandon(sock: WebSocket, code: number, reason: string): void {
    if (this.ws !== sock) return;
    this.ws = null;
    this.clearConnectTimeout();
    this.clearWatchdog();
    this.clearPingInterval();
    try {
      sock.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      sock.terminate();
    } catch {
      // ignore
    }
    this.opts.onClose?.(code, reason);
    if (!this.closing) this.scheduleReconnect();
  }

  /**
   * Drop the current socket without reporting a close or scheduling a
   * reconnect. Used where the caller is about to replace it (openOnce) or
   * is shutting down (stop).
   */
  private retireCurrent(): void {
    const sock = this.ws;
    if (!sock) return;
    this.ws = null;
    this.clearConnectTimeout();
    this.clearWatchdog();
    this.clearPingInterval();
    try {
      sock.removeAllListeners();
      // Graceful close only makes sense once the handshake is done; a
      // socket still connecting would linger in CLOSING forever.
      if (sock.readyState === WebSocket.OPEN) sock.close();
      else sock.terminate();
    } catch {
      // ignore
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      this.logError(
        `No hub traffic for ${WATCHDOG_TIMEOUT_MS}ms — terminating socket`,
      );
      const sock = this.ws;
      if (sock) this.abandon(sock, 1006, "watchdog timeout");
    }, WATCHDOG_TIMEOUT_MS);
    unrefTimer(this.watchdogTimer);
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
    unrefTimer(this.pingIntervalTimer);
  }

  private clearPingInterval(): void {
    if (this.pingIntervalTimer) {
      clearInterval(this.pingIntervalTimer);
      this.pingIntervalTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openOnce();
    }, delay);
    unrefTimer(this.reconnectTimer);
  }

  private logError(msg: string): void {
    const prefix = this.opts.logPrefix ?? "claude-net/mirror";
    process.stderr.write(`[${prefix}] ${msg}\n`);
  }
}

/** unref a timer where the runtime supports it, so it can't hold the process open. */
function unrefTimer(timer: unknown): void {
  if (timer && typeof timer === "object" && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
}
