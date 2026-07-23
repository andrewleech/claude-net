# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///
"""CPython mock WebSocket server for proving `mpyws` end-to-end.

Extends the P1 spike's `planning/spike/mock_hub.py` register/ping shape
with a generic echo mode for `mpyws`'s own proof: echoes every text/binary
message back unchanged, answers three text commands specially, and can
serve either `ws://` or `wss://` (self-signed `localhost` cert, the same
TLS-serving pattern the P1 spike proved works under a single asyncio poll
loop on the client side).

Commands (as a text message; anything else is echoed verbatim):
  "PING_ME"          -> server sends a WS-level control PING (payload
                        b"hub-ping") and waits up to 5s for the client's
                        PONG, logging whether it arrived.
  "CLOSE:<code>:<reason>" -> server sends a Close frame with that code and
                        reason (a clean, server-initiated close).
  anything else       -> echoed back unchanged, same frame type
                        (text in -> text out, binary in -> binary out).

Usage: uv run mock_hub.py PORT [--tls]
"""
import asyncio
import os
import ssl
import subprocess
import sys

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(HERE, "localhost_cert.pem")
KEY = os.path.join(HERE, "localhost_key.pem")


def ensure_certs():
    """Generate the throwaway self-signed CN=localhost test cert/key on
    demand, alongside this file.

    Kept out of git: a private key -- even a disposable localhost-only
    one -- has no business being committed. Regenerated as needed, here
    and by `test_mpyws.py`'s DER export for `CERT_REQUIRED` verification.
    """
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", KEY, "-out", CERT,
            "-days", "3650", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def log(*a):
    print("HUB:", *a, flush=True)


async def handler(ws):
    log("client connected")
    try:
        async for raw in ws:
            if isinstance(raw, str) and raw == "PING_ME":
                log("sending WS control PING")
                try:
                    pong_waiter = await ws.ping(b"hub-ping")
                    await asyncio.wait_for(pong_waiter, timeout=5)
                    log("got PONG from client")
                    await ws.send("PONG_OK")
                except Exception as e:
                    log("no pong / ping failed:", repr(e))
                    await ws.send("PONG_FAIL:%r" % (e,))
                continue
            if isinstance(raw, str) and raw.startswith("CLOSE:"):
                _, code, reason = raw.split(":", 2)
                log("server-initiated close code=%s reason=%s" % (code, reason))
                await ws.close(code=int(code), reason=reason)
                continue
            # echo, preserving frame type
            log("echo %d bytes (%s)" % (len(raw), type(raw).__name__))
            await ws.send(raw)
    except websockets.ConnectionClosed as e:
        log("connection closed:", e)
    finally:
        log("handler done")


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
    use_tls = "--tls" in sys.argv[2:]
    ssl_ctx = None
    if use_tls:
        ensure_certs()
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(CERT, KEY)
    async with websockets.serve(
        handler, "127.0.0.1", port, ping_interval=None, ssl=ssl_ctx
    ):
        log("listening on 127.0.0.1:%d tls=%s" % (port, use_tls))
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
