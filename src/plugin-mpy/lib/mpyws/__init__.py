"""mpyws: a reusable async RFC6455 WebSocket client for MicroPython asyncio.

Handshake (with `Sec-WebSocket-Accept` verification), client-side masking,
7/16/64-bit frame lengths, fragmented-message reassembly with control
frames interleaved mid-fragment, transparent PING->PONG, and a clean close
handshake, for text and binary messages over plain TCP (`ws://`) or TLS
(`wss://`, via the `tls`-module async pattern `asyncio.open_connection`
already supports on this runtime).

Public API
----------

``await connect(url, *, ssl=None, cadata=None, server_hostname=None, headers=None, max_message_bytes=DEFAULT_MAX_MESSAGE_BYTES, handshake_timeout=None) -> WSClient``
    Opens the TCP/TLS connection and runs the opening HTTP Upgrade
    handshake. ``url`` is ``ws://host[:port][/path]`` or
    ``wss://host[:port][/path]`` (``http``/``https`` are accepted as
    aliases for ``ws``/``wss``, since servers commonly advertise their WS
    endpoint under the http(s) scheme). For `wss`, pass a pre-built
    ``tls.SSLContext`` as ``ssl``, or let ``connect()`` build one: `cadata`
    (DER-encoded CA bytes) turns on certificate verification
    (`CERT_REQUIRED`); with no `cadata`, verification is off
    (`CERT_NONE`). ``server_hostname`` overrides SNI (default: the URL's
    host). ``headers`` is an optional ``dict`` of extra request headers.
    ``max_message_bytes`` bounds both a single frame's declared length and
    a reassembled fragmented message's total size (default 1 MiB); pass
    ``None`` to disable the bound. ``handshake_timeout``, in seconds,
    bounds the opening handshake's request write and status-line/header
    read; left as ``None``, a stalled peer blocks ``connect()``
    indefinitely and the caller is expected to wrap the whole call
    (including the preceding TCP/TLS connect) in its own
    ``asyncio.wait_for()``. Raises ``WSHandshakeError`` on a non-101
    response, an ``Accept`` mismatch, or a response missing the
    ``Upgrade``/``Connection`` headers RFC6455 4.1 requires;
    ``WSHandshakeTimeout`` (a ``WSHandshakeError`` subclass) if
    ``handshake_timeout`` elapses first.

``await ws.recv() -> str | bytes``
    Returns the next complete application message: ``str`` for a text
    message, ``bytes`` for binary. Fragmented messages are reassembled
    transparently; ``PING`` frames are answered with a ``PONG`` echoing
    the same payload and never surfaced here; ``PONG`` frames are
    discarded. Raises ``WSClosedOK``, ``WSConnectionAborted``, or
    ``WSProtocolError`` when the connection ends (see "Close and error
    taxonomy" below) — there is no `None`-on-close return; the connection
    ending is always one of those three exceptions.

``await ws.send(data)``
    Sends `data` as one unfragmented frame: `str` becomes a text frame,
    `bytes`/`bytearray` becomes a binary frame.

``await ws.close(code=1000, reason="")``
    Sends a Close frame and ends the connection. Idempotent. ``reason`` is
    truncated on a UTF-8 boundary so the emitted frame's payload never
    exceeds RFC6455 5.5's 125-byte control-frame limit. Does not block
    waiting for the peer's Close echo (see `WSClient.close`'s docstring
    for why that's safe).

``ws.closed`` (property)
    `True` once the connection has ended, by any of the three routes.

``ws.last_recv_ms`` / ``ws.last_traffic_ms``
    `time.ticks_ms()` timestamps an app-layer watchdog can read directly
    (this library implements no watchdog policy itself). `last_recv_ms`
    updates on every inbound WebSocket frame, data or control — so a
    watchdog resets correctly on a transparently-handled `PING` the same
    way it would on an application message. `last_traffic_ms` updates on
    every inbound *or* outbound frame, for a watchdog that only cares
    whether the socket is idle in either direction.

Close and error taxonomy
-------------------------

Every way `recv()` (or a blocked `send()`/`close()`) can end is one of
three exception types, all importable from `mpyws`, so a caller drives
reconnect decisions off the type rather than a message string:

``WSClosedOK``
    A clean RFC6455 close handshake completed — the peer sent a Close
    frame and this client echoed it, this client called `close()` and
    the peer's echo was observed, or this client called `close()` and the
    transport ended before any echo arrived (the local side's own intent
    to close still makes this a clean close from its perspective). Carries
    `.code` / `.reason`.

``WSConnectionAborted``
    The transport ended (EOF or a reset such as `ECONNRESET`) with no
    Close frame exchanged on either side — a genuinely abrupt
    disconnection, not requested locally.

``WSProtocolError``
    The peer sent a frame violating RFC6455 framing: a reserved (RSV) bit
    set, an undefined opcode, a masked frame from the server, a
    fragmented control frame, an oversized control-frame payload, a
    continuation frame with no message in progress (or a new data frame
    arriving before a previous fragmented message finished), a length
    field's reserved high bit set, a Close frame carrying a code outside
    the RFC6455 7.4.1 allow-list (e.g. the reserved-for-local-use 1005,
    1006, 1015), invalid UTF-8 in a text message or close reason, or a
    frame/reassembled-message length beyond
    `max_message_bytes` (`.code` 1009, "message too big"; every other
    case defaults `.code` to 1002, "protocol error"). This client sends a
    Close frame carrying `.code` and tears the transport down itself
    before raising.

``WSHandshakeError``
    The opening HTTP Upgrade handshake failed: a non-101 status line, a
    `Sec-WebSocket-Accept` value that doesn't match the SHA1-derived
    value RFC6455 defines for the request's `Sec-WebSocket-Key`, or a
    response missing the RFC6455 4.1 `Upgrade: websocket` / `Connection:
    Upgrade` headers. Raised only from `connect()`, before any WebSocket
    frame has ever flowed; not a `WSConnectionClosed` subclass for that
    reason. `Accept` verification is attempted whenever `hashlib` is
    importable on the running binary (it is, on the target `mcp` variant)
    and silently skipped otherwise — see `_client._verify_accept`'s
    docstring for why that fallback is safe.

``WSHandshakeTimeout``
    A `WSHandshakeError` subclass: the opening handshake didn't complete
    within `connect()`'s `handshake_timeout`. Raised only when
    `handshake_timeout` is passed; otherwise a stalled peer leaves
    `connect()` blocked indefinitely (see `handshake_timeout`'s
    description above).

All names above (plus the common base `WSError` and
`WSConnectionClosed`) are exported from the package root.

Module layout
-------------

``_errors.py``
    The exception hierarchy described above.
``_url.py``
    `parse_url(url) -> (scheme, host, port, path)`.
``_frame.py``
    Pure encode/decode primitives (`encode_frame`, header/length
    validation) with no `asyncio` dependency — the encode side is
    exercisable from plain CPython against hand-computed wire-byte
    vectors.
``_client.py``
    `WSClient`: the handshake and the `asyncio`-driven read/write loop
    built on top of `_frame.py`.

Usage example
--------------

See `example_echo.py` alongside this package: an end-to-end echo client
against `mock_hub.py`'s WS/WSS echo mode, runnable directly on the
`picolet-runtime-*-mcp` binary.
"""

from ._client import DEFAULT_MAX_MESSAGE_BYTES, WSClient
from ._errors import (
    WSClosedOK,
    WSConnectionAborted,
    WSConnectionClosed,
    WSError,
    WSHandshakeError,
    WSHandshakeTimeout,
    WSProtocolError,
)

connect = WSClient.connect

__all__ = [
    "connect",
    "WSClient",
    "DEFAULT_MAX_MESSAGE_BYTES",
    "WSError",
    "WSHandshakeError",
    "WSHandshakeTimeout",
    "WSConnectionClosed",
    "WSClosedOK",
    "WSConnectionAborted",
    "WSProtocolError",
]
