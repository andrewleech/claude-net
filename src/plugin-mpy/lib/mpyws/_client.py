"""`WSClient`: the connected-socket half of mpyws (handshake + framing loop)."""

import asyncio
import binascii
import os
import struct
import time

from ._errors import (
    WSClosedOK,
    WSConnectionAborted,
    WSHandshakeError,
    WSHandshakeTimeout,
    WSProtocolError,
)
from ._frame import (
    OP_BIN,
    OP_CLOSE,
    OP_CONT,
    OP_PING,
    OP_PONG,
    OP_TEXT,
    encode_frame,
    parse_basic_header,
    validate_header,
    validate_length,
)
from ._url import parse_url

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
DEFAULT_MAX_MESSAGE_BYTES = 1 * 1024 * 1024


def _verify_accept(key, accept_got):
    """Raise `WSHandshakeError` if `accept_got` doesn't match the SHA1
    digest RFC6455 defines for `key`.

    Silently skipped (not raised, not even attempted) when `hashlib` isn't
    importable on the running binary: the TCP connection and the 101
    status line already establish that *some* peer accepted the upgrade,
    so verification is defense-in-depth for a client, never load-bearing
    for the connection to function. On a binary that does have `hashlib`
    (as the target `mcp` variant does), this check always runs.
    """
    try:
        import hashlib
    except ImportError:
        return
    digest = hashlib.sha1((key + _GUID).encode()).digest()
    expected = binascii.b2a_base64(digest).strip().decode()
    if accept_got != expected:
        raise WSHandshakeError(
            "Sec-WebSocket-Accept mismatch: got %r, want %r"
            % (accept_got, expected)
        )


def _verify_upgrade_headers(resp_headers):
    """Raise `WSHandshakeError` unless the 101 response carries RFC6455
    4.1's `Upgrade: websocket` and `Connection: Upgrade` headers.

    Both checks are case-insensitive; `Connection` may legally be a
    comma-separated list of tokens (e.g. `keep-alive, Upgrade`), so it's
    matched by membership rather than exact equality.
    """
    upgrade = resp_headers.get("upgrade", "")
    if upgrade.lower() != "websocket":
        raise WSHandshakeError(
            "missing/invalid Upgrade header: %r" % (upgrade,))
    connection = resp_headers.get("connection", "")
    tokens = [t.strip().lower() for t in connection.split(",")]
    if "upgrade" not in tokens:
        raise WSHandshakeError(
            "missing 'upgrade' token in Connection header: %r" % (connection,))


# RFC6455 7.4.1: codes a peer may legally place on the wire. 1004-1006 and
# 1015 are reserved for local use only and must never appear in a CLOSE
# frame; 1012-1014 are unassigned; 3000-3999 are library/framework use,
# 4000-4999 are private use.
_VALID_CLOSE_CODES = (1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011)


def _close_code_is_valid(code):
    return code in _VALID_CLOSE_CODES or 3000 <= code <= 4999


_MAX_CLOSE_PAYLOAD = 125
_MAX_CLOSE_REASON_BYTES = _MAX_CLOSE_PAYLOAD - 2  # 2-byte code prefix


def _truncate_close_reason(reason_bytes):
    """Truncate `reason_bytes` so a CLOSE frame's payload (2-byte code +
    reason) fits the RFC6455 5.5 125-byte control-frame limit, without
    splitting a multibyte UTF-8 character.

    A cut lands mid-character iff the byte immediately after it is a UTF-8
    continuation byte (`0b10xxxxxx`); back off one byte at a time until
    that's no longer true.
    """
    if len(reason_bytes) <= _MAX_CLOSE_REASON_BYTES:
        return reason_bytes
    cut = _MAX_CLOSE_REASON_BYTES
    while cut > 0 and (reason_bytes[cut] & 0xC0) == 0x80:
        cut -= 1
    return reason_bytes[:cut]


def _parse_close_payload(payload):
    """Return `(code, reason)` from a CLOSE frame's payload.

    An empty payload means the peer sent no status code at all; RFC6455
    reserves 1005 for reporting that condition locally (1005 must never
    itself appear on the wire). A 1-byte payload can't hold a 2-byte code
    and is a protocol violation. A 2-byte code outside the RFC6455
    allow-list is also a protocol violation — the caller must fail the
    connection with 1002 rather than treat it as a clean close.
    """
    if not payload:
        return 1005, ""
    if len(payload) == 1:
        raise WSProtocolError("close frame with a 1-byte payload")
    code = struct.unpack("!H", payload[:2])[0]
    if not _close_code_is_valid(code):
        raise WSProtocolError("invalid close code: %d" % code)
    try:
        reason = payload[2:].decode()
    except Exception:
        raise WSProtocolError("invalid UTF-8 in close reason")
    return code, reason


class WSClient:
    """A connected RFC6455 WebSocket client. Construct via `connect()`."""

    def __init__(self, reader, writer, max_message_bytes=DEFAULT_MAX_MESSAGE_BYTES):
        self._r = reader
        self._w = writer
        self._max_message_bytes = max_message_bytes
        self._closed = False
        self._close_exc = None
        self._local_close_requested = False
        self._local_close_code = 1000
        self._local_close_reason = ""
        now = time.ticks_ms()
        self.last_recv_ms = now
        self.last_traffic_ms = now

    @property
    def closed(self):
        """`True` once the connection has ended (any of the three ways)."""
        return self._closed

    @classmethod
    async def connect(cls, url, *, ssl=None, cadata=None, server_hostname=None,
                       headers=None, max_message_bytes=DEFAULT_MAX_MESSAGE_BYTES,
                       handshake_timeout=None):
        """Open a TCP (or TLS, for `wss://`) connection to `url` and run the
        RFC6455 opening handshake. Returns a ready-to-use `WSClient`.

        `ssl`, when given, is a pre-built `tls.SSLContext` used as-is
        (`server_hostname` still controls SNI). Otherwise, for a `wss://`
        URL, a context is built here: `cadata` (DER-encoded CA bytes) turns
        on `CERT_REQUIRED`; with no `cadata`, `CERT_NONE` is used. Building
        a context and importing `tls` is skipped entirely for `ws://`
        URLs, so a plain-TCP caller never needs the `tls` module to be
        present.

        `handshake_timeout`, in seconds, bounds the request write plus the
        status-line/header read that make up the opening handshake (not
        the preceding TCP/TLS connect). Left as `None` (the default), a
        peer that stalls mid-handshake blocks `connect()` indefinitely; a
        caller that wants to bound the whole call, including the
        TCP/TLS connect, should wrap it in its own
        `asyncio.wait_for(connect(...), timeout)` instead.

        Raises `WSHandshakeError` on a non-101 status line, an
        `Sec-WebSocket-Accept` mismatch, or a response missing the
        `Upgrade`/`Connection` headers RFC6455 4.1 requires;
        `WSHandshakeTimeout` (a `WSHandshakeError` subclass) if
        `handshake_timeout` elapses first. On any exception during the
        handshake, the underlying socket/writer is closed before
        re-raising, so a failed handshake never leaks the file
        descriptor.
        """
        scheme, host, port, path = parse_url(url)
        ctx = ssl
        if scheme == "wss" and ctx is None:
            import tls
            ctx = tls.SSLContext(tls.PROTOCOL_TLS_CLIENT)
            if cadata is not None:
                ctx.verify_mode = tls.CERT_REQUIRED
                ctx.load_verify_locations(cadata)
            else:
                ctx.verify_mode = tls.CERT_NONE
        sni = (server_hostname or host) if ctx is not None else None

        reader, writer = await asyncio.open_connection(
            host, port, ssl=ctx, server_hostname=sni)

        async def _do_handshake():
            key = binascii.b2a_base64(os.urandom(16)).strip().decode()
            req_lines = [
                "GET %s HTTP/1.1" % path,
                "Host: %s:%d" % (host, port),
                "Upgrade: websocket",
                "Connection: Upgrade",
                "Sec-WebSocket-Key: %s" % key,
                "Sec-WebSocket-Version: 13",
            ]
            if headers:
                for hk, hv in headers.items():
                    req_lines.append("%s: %s" % (hk, hv))
            writer.write(("\r\n".join(req_lines) + "\r\n\r\n").encode())
            await writer.drain()

            status = await reader.readline()
            parts = status.split()
            if len(parts) < 2 or parts[1] != b"101":
                raise WSHandshakeError(
                    "handshake failed, status line: %r" % (status,))

            resp_headers = {}
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                if b":" not in line:
                    continue
                hk, _, hv = line.partition(b":")
                resp_headers[hk.strip().lower().decode()] = hv.strip().decode()

            _verify_accept(key, resp_headers.get("sec-websocket-accept"))
            _verify_upgrade_headers(resp_headers)

        try:
            if handshake_timeout is not None:
                try:
                    await asyncio.wait_for(_do_handshake(), handshake_timeout)
                except asyncio.TimeoutError:
                    raise WSHandshakeTimeout(
                        "opening handshake exceeded handshake_timeout=%r s"
                        % (handshake_timeout,))
            else:
                await _do_handshake()
        except Exception:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
            raise

        return cls(reader, writer, max_message_bytes=max_message_bytes)

    # ── Sending ──────────────────────────────────────────────────────

    async def send(self, data):
        """Send `data` as one unfragmented frame: `str` -> text frame,
        `bytes`/`bytearray` -> binary frame. Raises the stored close
        exception (see the module docstring's taxonomy) if the connection
        has already ended, or a fresh one (`WSConnectionAborted`, ordinarily)
        if the write itself fails."""
        if self._closed:
            raise self._close_exc
        if isinstance(data, str):
            opcode, payload = OP_TEXT, data.encode()
        elif isinstance(data, (bytes, bytearray)):
            opcode, payload = OP_BIN, bytes(data)
        else:
            raise TypeError(
                "WSClient.send() expects str or bytes, got %s" % type(data))
        try:
            await self._send_frame(opcode, payload)
        except (EOFError, OSError) as exc:
            raise await self._on_transport_error(exc)

    async def _send_frame(self, opcode, payload=b""):
        self._w.write(encode_frame(opcode, payload, fin=True, mask=True))
        await self._w.drain()
        self.last_traffic_ms = time.ticks_ms()

    # ── Closing ──────────────────────────────────────────────────────

    async def close(self, code=1000, reason=""):
        """Send a Close frame carrying `code`/`reason`, then end the
        connection. Idempotent — a second call is a no-op.

        `reason` is truncated (on a UTF-8 character boundary) so the
        emitted frame's payload — the 2-byte code plus the reason bytes —
        never exceeds RFC6455 5.5's 125-byte control-frame limit; the
        truncated form is also what `.reason` reads as afterwards, since
        it's what actually went on the wire.

        Does not block waiting for the peer's Close echo: it marks the
        close as locally intended and tears the transport down
        immediately. Any `recv()` that unblocks because of that teardown
        (whether already in flight or called afterwards) observes the
        same `WSClosedOK` this call finalizes with, rather than
        `WSConnectionAborted` — the local intent to close is what makes
        this a clean close.
        """
        if self._closed:
            return
        reason_bytes = _truncate_close_reason(reason.encode())
        reason = reason_bytes.decode()
        self._local_close_requested = True
        self._local_close_code = code
        self._local_close_reason = reason
        try:
            await self._send_frame(OP_CLOSE, struct.pack("!H", code) + reason_bytes)
        except Exception:
            pass
        await self._finalize(WSClosedOK(code, reason))

    async def _finalize(self, exc):
        if self._closed:
            return
        self._closed = True
        self._close_exc = exc
        try:
            self._w.close()
        except Exception:
            pass
        try:
            await self._w.wait_closed()
        except Exception:
            pass

    async def _fail_protocol(self, exc):
        if self._closed:
            return
        try:
            await self._send_frame(OP_CLOSE, struct.pack("!H", exc.code))
        except Exception:
            pass
        await self._finalize(exc)

    # ── Receiving ────────────────────────────────────────────────────

    async def _read_exact(self, n):
        if n == 0:
            return b""
        return await self._r.readexactly(n)

    async def _read_frame(self):
        """Read exactly one frame. Never returns on failure: a transport
        error or a framing violation is turned into the matching typed
        exception, the connection is finalized, and the exception is
        raised from here."""
        try:
            b0, b1 = (await self._read_exact(2))
        except (EOFError, OSError) as exc:
            raise await self._on_transport_error(exc)
        fin, rsv, opcode, masked, len7 = parse_basic_header(b0, b1)
        try:
            validate_header(fin, rsv, opcode, masked)
            length = len7
            if length == 126:
                length = struct.unpack("!H", await self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await self._read_exact(8))[0]
            validate_length(opcode, length, self._max_message_bytes)
            payload = await self._read_exact(length)
        except WSProtocolError as exc:
            await self._fail_protocol(exc)
            raise
        except (EOFError, OSError) as exc:
            raise await self._on_transport_error(exc)
        self.last_recv_ms = time.ticks_ms()
        self.last_traffic_ms = self.last_recv_ms
        return fin, opcode, payload

    async def _on_transport_error(self, exc):
        """Finalize on a raw transport failure and return the exception to
        raise (returned, not raised, so callers keep a single `raise`
        call site and a clean traceback)."""
        if self._closed:
            return self._close_exc
        if self._local_close_requested:
            result = WSClosedOK(self._local_close_code, self._local_close_reason)
        else:
            result = WSConnectionAborted(
                message="transport closed: %r" % (exc,))
        await self._finalize(result)
        return result

    async def recv(self):
        """Receive one complete application message: `str` for a text
        message, `bytes` for binary. Transparently reassembles fragmented
        messages and answers control frames (PING -> PONG echo; CLOSE ->
        echo + finalize) without ever surfacing them here.

        Raises `WSClosedOK` (clean close), `WSConnectionAborted`
        (transport dropped with no close handshake), or `WSProtocolError`
        (peer violated RFC6455 framing) — see the module docstring.
        """
        if self._closed:
            raise self._close_exc
        frags = None
        msg_op = None
        while True:
            fin, opcode, payload = await self._read_frame()

            if opcode == OP_PING:
                try:
                    await self._send_frame(OP_PONG, payload)
                except (EOFError, OSError) as exc:
                    raise await self._on_transport_error(exc)
                continue
            if opcode == OP_PONG:
                continue

            if opcode == OP_CLOSE:
                try:
                    code, reason = _parse_close_payload(payload)
                except WSProtocolError as exc:
                    await self._fail_protocol(exc)
                    raise
                exc = WSClosedOK(code, reason)
                if not self._local_close_requested:
                    try:
                        await self._send_frame(OP_CLOSE, payload)
                    except Exception:
                        pass
                await self._finalize(exc)
                raise exc

            if opcode in (OP_TEXT, OP_BIN):
                if frags is not None:
                    exc = WSProtocolError(
                        "data frame received before previous fragmented "
                        "message finished")
                    await self._fail_protocol(exc)
                    raise exc
                msg_op = opcode
                frags = bytearray(payload)
            elif opcode == OP_CONT:
                if frags is None:
                    exc = WSProtocolError(
                        "continuation frame with no message in progress")
                    await self._fail_protocol(exc)
                    raise exc
                if (self._max_message_bytes is not None
                        and len(frags) + len(payload) > self._max_message_bytes):
                    # Checked against the *projected* total before appending:
                    # appending first would transiently double-allocate (the
                    # existing `frags` buffer plus its bytearray-growth copy)
                    # for a message this guard is about to reject anyway, letting
                    # a hostile peer force ~2x the configured memory ceiling one
                    # CONT frame at a time.
                    exc = WSProtocolError(
                        "reassembled message exceeds max_message_bytes=%d"
                        % self._max_message_bytes, code=1009)
                    await self._fail_protocol(exc)
                    raise exc
                frags += payload

            if fin:
                data = bytes(frags)
                if msg_op == OP_TEXT:
                    try:
                        return data.decode()
                    except Exception:
                        exc = WSProtocolError("invalid UTF-8 in text message")
                        await self._fail_protocol(exc)
                        raise exc
                return data
