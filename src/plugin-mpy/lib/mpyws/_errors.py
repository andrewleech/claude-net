"""Exception hierarchy for mpyws.

Every exception a caller can observe out of `WSClient` is one of these
types (or `WSHandshakeError`, which is not a `WSConnectionClosed` since it
happens before any WebSocket frame has ever flowed). A caller drives
reconnect logic off the exception *type*, never off a message string:

    try:
        msg = await ws.recv()
    except WSClosedOK:
        ...       # peer or local side completed a clean close handshake
    except WSConnectionAborted:
        ...       # transport dropped with no close handshake
    except WSProtocolError:
        ...       # peer violated RFC6455 framing; client closed on it
    except WSHandshakeError:
        ...       # the opening HTTP Upgrade handshake itself failed
"""


class WSError(Exception):
    """Base class for every exception `mpyws` raises."""


class WSHandshakeError(WSError):
    """The opening HTTP Upgrade handshake failed.

    Covers a non-101 status line, a missing/malformed
    `Sec-WebSocket-Accept` header, an `Accept` value that does not match
    the SHA1-derived value computed from the request's
    `Sec-WebSocket-Key`, and a response missing the RFC6455 4.1
    `Upgrade: websocket` / `Connection: Upgrade` headers. No WebSocket
    frame has been exchanged yet when this is raised.
    """


class WSHandshakeTimeout(WSHandshakeError):
    """The opening handshake did not complete within `handshake_timeout`.

    Raised only when `connect()` is called with `handshake_timeout` set;
    without it, a stalled peer leaves `connect()` blocked indefinitely and
    the caller is expected to wrap the call in its own
    `asyncio.wait_for()`.
    """


class WSConnectionClosed(WSError):
    """Base class for the two ways an established connection ends.

    `code` and `reason` carry the RFC6455 close code / UTF-8 reason
    string when known (`None` / `""` when the connection dropped without
    ever producing them, e.g. an abortive close).
    """

    def __init__(self, code=None, reason="", message=None):
        self.code = code
        self.reason = reason
        super().__init__(message or "%s(code=%r, reason=%r)" % (
            type(self).__name__, code, reason))


class WSClosedOK(WSConnectionClosed):
    """The connection ended via a clean RFC6455 close handshake.

    Raised whether the peer initiated the close (client echoed it) or the
    local side called `WSClient.close()` (regardless of whether the
    peer's echo was actually observed before the transport went away —
    the local side's own intent to close makes this a clean close from
    its perspective).
    """


class WSConnectionAborted(WSConnectionClosed):
    """The transport ended with no close handshake on either side.

    Covers a bare TCP FIN/EOF or a reset (e.g. `ECONNRESET`) observed
    while neither side had sent a Close frame — the shape a network
    failure or an ungraceful peer eviction takes.
    """


class WSProtocolError(WSConnectionClosed):
    """The peer sent a frame violating RFC6455 framing rules.

    `code` defaults to 1002 ("protocol error"); a resource-guard
    violation (a declared or reassembled message size beyond the
    client's configured limit) uses 1009 ("message too big") instead.
    The client sends a Close frame carrying `code` and closes the
    transport itself before this is raised to the caller.
    """

    def __init__(self, reason="", code=1002):
        super().__init__(code, reason)
