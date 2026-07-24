"""HubClient: the WebSocket transport half of the claude-net plugin.

Owns the connection lifecycle to the hub (`plugin.ts:1306-1385`): URL
derivation, connect/reconnect with exponential backoff, the per-connection
idle watchdog, outbound request/response correlation, and the inbound
frame classification (`response` / `message` / `registered` / `error`).
Identity, registration policy, channel-capability, and the nudge queue are
the application's concern (`plugin.py`) and are wired in via the
`on_open`/`on_frame`/`on_close` callbacks rather than living here — this
class only knows about the wire protocol.

Composes `mpyws` (the WebSocket client) exactly as documented in its own
package docstring; no WebSocket framing or handshake logic is duplicated
here.
"""

import json
import os
import time

import mpyws

from _identity import uuid4

# Bundled ISRG Root X1 CA (DER), used as `cadata` on every `wss://` connect
# so the hub's Let's-Encrypt-via-`tailscale cert` certificate verifies
# under `tls.CERT_REQUIRED` (Q2, DECIDED — see
# planning/DECISIONS.md and planning/tickets/p7_plugin-parity.md). Loaded
# once at import time; `mpyws.connect()` is the sanctioned place cert
# handling lives (via its `cadata` parameter) — this module never builds
# its own `tls.SSLContext`.
_CA_DER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "isrg_root_x1.der")
with open(_CA_DER_PATH, "rb") as _f:
    _CA_DER = _f.read()

# Explicit opt-out for certificate verification (falls back to
# `tls.CERT_NONE`, e.g. for a self-signed dev hub over the tailnet).
# Unset or any value other than "1" keeps the CERT_REQUIRED default.
INSECURE_TLS_ENV_VAR = "CLAUDE_NET_TLS_INSECURE"

RECONNECT_INITIAL_S = 1.0
RECONNECT_MAX_S = 30.0
# The hub pings every 5s and evicts after 30s of silence; this threshold
# sits just past that so the hub gets first shot at a clean close (see
# plugin.ts:68-74 for the underlying rationale: a suspend/resume can
# otherwise leave a zombie ESTAB socket that never surfaces a close).
WATCHDOG_TIMEOUT_MS = 31_000
WATCHDOG_POLL_S = 1.0
REQUEST_TIMEOUT_S = 10.0


class HubError(Exception):
    """A hub request failed: not connected, remote error, or timed out.
    `str(exc)` is the message a tool result surfaces to the caller."""


def derive_ws_url(hub_env_url):
    """`CLAUDE_NET_HUB` (an `http(s)://` URL) -> the hub's `/ws` endpoint:
    swap the `http` prefix for `ws`, strip a trailing slash, append
    `/ws`. Returns `""` for a falsy input (hubless mode)."""
    if not hub_env_url:
        return ""
    url = hub_env_url
    if url.startswith("http"):
        url = "ws" + url[len("http"):]
    if url.endswith("/"):
        url = url[:-1]
    return url + "/ws"


class _Pending:
    __slots__ = ("event", "data", "error")

    def __init__(self, event):
        self.event = event
        self.data = None
        self.error = None


class HubClient:
    """WebSocket transport to the claude-net hub.

    `on_open()` fires once the connection is up (before the receive loop
    starts). `on_frame(frame)` fires for every parsed inbound frame that
    isn't a `response` to an outbound request (i.e. `message`,
    `registered`, `error`). `on_close()` fires once the connection ends,
    for any reason (clean close, abort, protocol error, or the watchdog
    forcing a close), before the reconnect backoff sleep. All three are
    plain callables — `plugin.py` supplies the closures.
    """

    def __init__(self, hub_env_url, on_open, on_frame, on_close, log, error=None):
        self.ws_url = derive_ws_url(hub_env_url)
        self._on_open = on_open
        self._on_frame = on_frame
        self._on_close = on_close
        self._log = log
        # Error-level sink; falls back to the info log if not supplied so the
        # class stays usable standalone.
        self._error = error or log
        self._ws = None
        self._pending = {}
        self._reconnect_delay_s = RECONNECT_INITIAL_S
        self._closing = False
        self._closing_event = None  # lazily bound to the running loop
        self._send_lock = None  # lazily bound to the running loop

    @property
    def configured(self):
        return bool(self.ws_url)

    def is_connected(self):
        return self._ws is not None and not self._ws.closed

    def _ensure_loop_bound(self):
        # asyncio.Event/Lock must be constructed once the event loop is
        # running on this port; HubClient itself is constructed earlier
        # (before `asyncio.run()`), so bind lazily on first use inside
        # `run()` rather than in `__init__`.
        import asyncio

        if self._closing_event is None:
            self._closing_event = asyncio.Event()
        if self._send_lock is None:
            self._send_lock = asyncio.Lock()

    # ── Connection lifecycle ────────────────────────────────────────

    async def run(self):
        """Connect, serve, and reconnect-with-backoff forever, until
        `shutdown()` is called. Intended to be run as a background task
        for the plugin's lifetime."""
        import asyncio

        self._ensure_loop_bound()
        while not self._closing:
            try:
                self._log("Connecting to %s" % self.ws_url)
                cadata = None if os.getenv(INSECURE_TLS_ENV_VAR) == "1" else _CA_DER
                self._ws = await mpyws.connect(
                    self.ws_url, cadata=cadata, handshake_timeout=15.0
                )
            except Exception as exc:
                self._error("Connect failed: %s" % exc)
                await self._sleep_backoff()
                continue

            self._log("Connected to hub")
            self._reconnect_delay_s = RECONNECT_INITIAL_S
            try:
                self._on_open()
            except Exception as exc:
                self._error("on_open callback failed: %s" % exc)

            watchdog_task = asyncio.create_task(self._watchdog(self._ws))
            try:
                await self._recv_loop(self._ws)
            finally:
                watchdog_task.cancel()
                await asyncio.gather(watchdog_task, return_exceptions=True)

            self._log("Disconnected from hub")
            self._ws = None
            try:
                self._on_close()
            except Exception as exc:
                self._error("on_close callback failed: %s" % exc)

            if self._closing:
                break
            await self._sleep_backoff()

    async def _recv_loop(self, ws):
        while True:
            try:
                raw = await ws.recv()
            except (
                mpyws.WSClosedOK,
                mpyws.WSConnectionAborted,
                mpyws.WSProtocolError,
            ):
                return
            self._handle_frame(raw)

    async def _watchdog(self, ws):
        import asyncio

        while True:
            await asyncio.sleep(WATCHDOG_POLL_S)
            if ws.closed:
                return
            # Inbound-only, matching plugin.ts's watchdog reset on
            # `message`/`ping` events (plugin.ts:1324/1331): an outbound
            # send on a zombie socket must not suppress the watchdog, so
            # this reads `last_recv_ms` (set only in mpyws's inbound frame
            # path), not `last_traffic_ms` (which also updates on send).
            idle_ms = time.ticks_diff(time.ticks_ms(), ws.last_recv_ms)
            if idle_ms >= WATCHDOG_TIMEOUT_MS:
                self._log(
                    "No hub traffic for %dms — closing socket" % WATCHDOG_TIMEOUT_MS
                )
                await ws.close(1000, "watchdog: no traffic")
                return

    async def _sleep_backoff(self):
        import asyncio

        self._log("Reconnecting in %.0fms" % (self._reconnect_delay_s * 1000))
        try:
            await asyncio.wait_for(
                self._closing_event.wait(), self._reconnect_delay_s
            )
        except asyncio.TimeoutError:
            pass
        self._reconnect_delay_s = min(self._reconnect_delay_s * 2, RECONNECT_MAX_S)

    # ── Inbound frame classification ────────────────────────────────

    def _handle_frame(self, raw):
        try:
            frame = json.loads(raw)
        except ValueError:
            self._error("Invalid JSON from hub: %s" % raw)
            return
        event = frame.get("event")
        if event == "response":
            pending = self._pending.get(frame.get("requestId"))
            if pending is not None:
                if frame.get("ok"):
                    pending.data = frame.get("data")
                else:
                    pending.error = frame.get("error") or "Unknown error"
                pending.event.set()
            return
        if event == "registered":
            self._log("Registered as %s" % frame.get("full_name"))
        elif event == "error":
            self._error("Hub error: %s" % frame.get("message"))
        if self._on_frame:
            self._on_frame(frame)

    # ── Outbound requests ────────────────────────────────────────────

    async def request(self, frame, timeout_s=REQUEST_TIMEOUT_S):
        """Send `frame` (a dict without `requestId`) and await the
        correlated `response` frame. Returns the response `data` on
        success. Raises `HubError` if not connected, if the hub replies
        with `ok: false`, or if no response arrives within `timeout_s`.
        """
        import asyncio

        self._ensure_loop_bound()
        if not self.is_connected():
            raise HubError("Not connected to hub")
        req_id = uuid4()
        obj = dict(frame)
        obj["requestId"] = req_id
        pending = _Pending(asyncio.Event())
        self._pending[req_id] = pending
        try:
            async with self._send_lock:
                await self._ws.send(json.dumps(obj))
        except Exception as exc:
            self._pending.pop(req_id, None)
            raise HubError(str(exc))
        try:
            await asyncio.wait_for(pending.event.wait(), timeout_s)
        except asyncio.TimeoutError:
            raise HubError("Request timed out after %d seconds" % int(timeout_s))
        finally:
            self._pending.pop(req_id, None)
        if pending.error is not None:
            raise HubError(pending.error)
        return pending.data

    # ── Shutdown ──────────────────────────────────────────────────────

    async def shutdown(self):
        """Stop reconnecting, close the current connection if any, and
        reject every in-flight request with `HubError("Shutting
        down")`. Idempotent."""
        self._ensure_loop_bound()
        if self._closing:
            return
        self._closing = True
        self._closing_event.set()
        if self._ws is not None and not self._ws.closed:
            try:
                await self._ws.close(1000, "shutting down")
            except Exception:
                pass
        for req_id, pending in list(self._pending.items()):
            pending.error = "Shutting down"
            pending.event.set()
        self._pending.clear()
