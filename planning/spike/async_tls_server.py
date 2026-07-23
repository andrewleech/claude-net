# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Local CPython TLS/WSS mock server for the P1 async-TLS de-risking spike.

Uses raw blocking sockets + one thread per connection so we get exact control
over handshake *timing* (CPython asyncio's ssl transport does the handshake for
you and hides the stall we need). Speaks just enough RFC6455 to mirror the hub:
register -> two frames, ping -> two frames, plus a WS control PING ~2s in.

Modes (argv: PORT MODE [STALL_MS]):
  normal          TLS handshake immediately, full register/ping behaviour.
  stall           sleep STALL_MS after TCP accept BEFORE the TLS handshake, so
                  the ServerHello is withheld and the client handshake spins on
                  WANT_READ (EAGAIN) under its poll loop. Then proceed normally.
  pack            reply to `register` by writing BOTH reply frames in ONE
                  ssl.send() -> one TLS record carrying two complete WS frames,
                  then go completely silent. Exercises the buffered-record
                  hazard: frame 2 must become readable with no new fd activity.
  close_handshake accept TCP, read the ClientHello bytes, then close the socket
                  mid-handshake (no ServerHello). Client must error, not hang.
  abrupt          complete the TLS handshake + WS upgrade, reply to `register`
                  with frame 1 in full, then emit ONE byte of frame 2's header
                  and RST the TCP connection (SO_LINGER 0). No OP_CLOSE frame.
                  Exercises the graceful-EOF contract: the client reads frame 1,
                  then recv() must return None (not raise) on the mid-frame RST.

The server always presents the self-signed localhost cert. The "cert that fails
CERT_REQUIRED verification" case is driven entirely from the client side: point
the client at this server with verify_mode=CERT_REQUIRED and the ISRG CA and the
handshake must fail to verify.
"""
import os
import socket
import ssl
import struct
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(HERE, "localhost_cert.pem")
KEY = os.path.join(HERE, "localhost_key.pem")

OP_TEXT, OP_CLOSE, OP_PING, OP_PONG = 0x1, 0x8, 0x9, 0xA


def log(*a):
    print("HUB:", *a, flush=True)


def build_frame(payload, opcode=OP_TEXT):
    # server->client frames are NOT masked
    if isinstance(payload, str):
        payload = payload.encode()
    n = len(payload)
    hdr = bytearray([0x80 | opcode])
    if n < 126:
        hdr.append(n)
    elif n < 65536:
        hdr.append(126)
        hdr += struct.pack("!H", n)
    else:
        hdr.append(127)
        hdr += struct.pack("!Q", n)
    return bytes(hdr) + payload


def read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("eof, got %d/%d" % (len(buf), n))
        buf += chunk
    return buf


def read_client_frame(sock):
    b0 = read_exact(sock, 1)[0]
    b1 = read_exact(sock, 1)[0]
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    ln = b1 & 0x7F
    if ln == 126:
        ln = struct.unpack("!H", read_exact(sock, 2))[0]
    elif ln == 127:
        ln = struct.unpack("!Q", read_exact(sock, 8))[0]
    mkey = read_exact(sock, 4) if masked else b"\0\0\0\0"
    payload = read_exact(sock, ln) if ln else b""
    if masked:
        payload = bytes(payload[i] ^ mkey[i & 3] for i in range(ln))
    return opcode, payload


def do_ws_upgrade(sock):
    hdr = b""
    while b"\r\n\r\n" not in hdr:
        hdr += read_exact(sock, 1)
    # We skip the Sec-WebSocket-Accept hash (client doesn't verify it either;
    # SHA1 isn't in the runtime). A fixed accept token is enough for the spike.
    resp = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: c3Bpa2VfYWNjZXB0X3Rva2VuAA==\r\n"
        "\r\n"
    )
    sock.sendall(resp.encode())


def make_ctx():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    return ctx


def handle(raw, addr, mode, stall_ms):
    try:
        if mode == "close_handshake":
            # Read a little of the ClientHello then drop the connection.
            raw.settimeout(2.0)
            try:
                raw.recv(64)
            except Exception:
                pass
            log("close_handshake: closing mid-handshake", addr)
            raw.close()
            return

        if mode == "stall":
            log("stall: sleeping %d ms before TLS handshake" % stall_ms, addr)
            time.sleep(stall_ms / 1000.0)

        ctx = make_ctx()
        # Blocking handshake on the server side; the interesting non-blocking
        # behaviour is all on the client.
        tls_sock = ctx.wrap_socket(raw, server_side=True)
        log("TLS up", tls_sock.version(), addr)

        do_ws_upgrade(tls_sock)
        log("ws upgraded", addr)

        # WS control ping ~1.5s in (mirror the real hub liveness probe).
        # Deliberately NOT started in `pack` mode: that mode must fall completely
        # silent after emitting the packed TLS record, so the buffered-record test
        # proves frame 2 surfaces from mbedtls's internal decrypt buffer alone,
        # with zero new fd activity. A stray PING would supply fresh fd readiness
        # that could wake a broken poll path and mask the exact hazard under test.
        if mode != "pack":
            def pinger():
                time.sleep(1.5)
                try:
                    tls_sock.sendall(build_frame(b"hub-ping", OP_PING))
                    log("sent WS control PING")
                except Exception:
                    pass

            threading.Thread(target=pinger, daemon=True).start()

        while True:
            try:
                opcode, payload = read_client_frame(tls_sock)
            except Exception as e:
                log("recv end:", repr(e), addr)
                break
            if opcode == OP_CLOSE:
                log("client CLOSE", addr)
                try:
                    tls_sock.sendall(build_frame(b"", OP_CLOSE))
                except Exception:
                    pass
                break
            if opcode == OP_PONG:
                log("client PONG (alive)")
                continue
            if opcode == OP_PING:
                tls_sock.sendall(build_frame(payload, OP_PONG))
                continue
            if opcode != OP_TEXT:
                continue

            import json

            try:
                msg = json.loads(payload)
            except Exception:
                continue
            action = msg.get("action")
            rid = msg.get("requestId")
            name = msg.get("name")
            log("recv action=%s rid=%s" % (action, rid))

            if action == "register":
                f1 = build_frame(json.dumps(
                    {"event": "registered", "name": name, "full_name": name}))
                f2 = build_frame(json.dumps(
                    {"event": "response", "requestId": rid, "ok": True,
                     "data": {"name": name}}))
                if mode == "pack":
                    # BOTH frames in ONE ssl write -> one TLS record carrying two
                    # complete WS frames. Then stay silent: frame 2 must surface
                    # with zero new fd activity.
                    tls_sock.sendall(f1 + f2)
                    log("pack: sent 2 frames in ONE TLS record (%d bytes), "
                        "now silent" % (len(f1) + len(f2)))
                elif mode == "abrupt":
                    # Frame 1 in full, then ONE byte of a second frame header and
                    # an RST — no OP_CLOSE. The client must read frame 1, then get
                    # None (graceful) on the mid-frame transport drop. SO_LINGER 0
                    # makes close() send an RST rather than a clean FIN; it is set
                    # on tls_sock because ssl.wrap_socket() detaches the original
                    # raw fd (touching `raw` here would be EBADF). SSLSocket.close()
                    # does NOT emit a TLS close_notify (that needs unwrap()), so the
                    # client sees a pure transport EOF mid-frame.
                    tls_sock.sendall(f1)
                    tls_sock.sendall(b"\x81")  # partial frame-2 header, then die
                    tls_sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                                        struct.pack("ii", 1, 0))
                    log("abrupt: sent frame1 + 1 byte of frame2, RST now")
                    try:
                        tls_sock.close()
                    except Exception:
                        pass
                    return
                else:
                    tls_sock.sendall(f1)
                    tls_sock.sendall(f2)
            elif action == "ping":
                tls_sock.sendall(build_frame(json.dumps(
                    {"event": "message", "text": "hello from hub"})))
                tls_sock.sendall(build_frame(json.dumps(
                    {"event": "response", "requestId": rid, "ok": True,
                     "data": {"pong": True}})))
            else:
                tls_sock.sendall(build_frame(json.dumps(
                    {"event": "response", "requestId": rid, "ok": False,
                     "error": "unknown action"})))
        try:
            tls_sock.close()
        except Exception:
            pass
    except Exception as e:
        log("handler error:", repr(e), addr)
        try:
            raw.close()
        except Exception:
            pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    mode = sys.argv[2] if len(sys.argv) > 2 else "normal"
    stall_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 1500

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(5)
    log("listening on 127.0.0.1:%d mode=%s" % (port, mode))
    try:
        while True:
            raw, addr = srv.accept()
            t = threading.Thread(target=handle, args=(raw, addr, mode, stall_ms),
                                 daemon=True)
            t.start()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
