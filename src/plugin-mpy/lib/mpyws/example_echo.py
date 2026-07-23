"""mpyws usage example: an echo client against `mock_hub.py`.

Run the server first (from the CPython side):

    uv run mpyws/mock_hub.py 8767          # plain ws://
    uv run mpyws/mock_hub.py 8768 --tls    # wss:// (self-signed localhost cert)

Then, against the picolet `mcp` variant binary:

    picolet-runtime-linux-x64-mcp example_echo.py ws://127.0.0.1:8767/
    picolet-runtime-linux-x64-mcp example_echo.py wss://127.0.0.1:8768/

A `wss://` URL with no `--insecure` builds a `CERT_NONE` context (the
server's self-signed cert has no chain to verify against here); pass a DER
CA file as a 3rd argument to exercise `CERT_REQUIRED` instead.
"""
import os
import sys

# Run directly from within the `mpyws/` directory, so its own parent (the
# `lib/` tree everything else in this package assumes is already on
# `sys.path`) isn't there yet; add it before importing the package.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_here))

import mpyws


async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8767/"
    cadata = None
    if len(sys.argv) > 2:
        with open(sys.argv[2], "rb") as f:
            cadata = f.read()

    print("connecting to", url)
    ws = await mpyws.connect(url, cadata=cadata)
    print("connected, closed=", ws.closed)

    await ws.send("hello")
    reply = await ws.recv()
    print("text echo:", repr(reply))
    assert reply == "hello"

    await ws.send(b"\x00\x01\xff binary payload")
    reply = await ws.recv()
    print("binary echo:", repr(reply))
    assert isinstance(reply, bytes)

    await ws.send("PING_ME")
    reply = await ws.recv()
    print("ping check:", reply)
    assert reply == "PONG_OK"

    print("last_recv_ms=%d last_traffic_ms=%d" % (ws.last_recv_ms, ws.last_traffic_ms))

    await ws.close(1000, "bye")
    print("closed cleanly, ws.closed =", ws.closed)

    try:
        await ws.recv()
    except mpyws.WSClosedOK as exc:
        print("post-close recv raised WSClosedOK:", exc.code, repr(exc.reason))


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
