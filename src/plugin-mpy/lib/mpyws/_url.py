"""WebSocket URL parsing: `ws://`/`wss://` (and `http`/`https` aliases)."""

_SCHEME_MAP = {"ws": "ws", "wss": "wss", "http": "ws", "https": "wss"}
_DEFAULT_PORT = {"ws": 80, "wss": 443}


def parse_url(url):
    """Parse `url` into `(scheme, host, port, path)`.

    `scheme` is normalized to `"ws"` or `"wss"` (`http://`/`https://` are
    accepted and mapped onto the equivalent WS scheme, since that's the
    convention servers commonly advertise their WS endpoint under). `port`
    defaults to 80 (`ws`) / 443 (`wss`) when absent. `path` always starts
    with `/`; a bare `host[:port]` with no path component yields `"/"`.

    Raises `ValueError` on an unsupported scheme or a missing host.
    """
    sep = url.find("://")
    if sep == -1:
        raise ValueError("not a URL (missing '://'): %r" % (url,))
    raw_scheme = url[:sep].lower()
    scheme = _SCHEME_MAP.get(raw_scheme)
    if scheme is None:
        raise ValueError("unsupported scheme %r in %r" % (raw_scheme, url))
    rest = url[sep + 3:]

    slash = rest.find("/")
    if slash == -1:
        hostport, path = rest, "/"
    else:
        hostport, path = rest[:slash], rest[slash:]

    if not hostport:
        raise ValueError("missing host in URL: %r" % (url,))

    if hostport[0] == "[":
        # IPv6 literal: [::1]:8080
        end = hostport.find("]")
        if end == -1:
            raise ValueError("unterminated IPv6 literal in URL: %r" % (url,))
        host = hostport[1:end]
        remainder = hostport[end + 1:]
        port = int(remainder[1:]) if remainder[:1] == ":" else _DEFAULT_PORT[scheme]
    else:
        colon = hostport.rfind(":")
        if colon == -1:
            host, port = hostport, _DEFAULT_PORT[scheme]
        else:
            host, port = hostport[:colon], int(hostport[colon + 1:])

    return scheme, host, port, path
