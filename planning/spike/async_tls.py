# Async-TLS wss client core for the picolet runtime (P1 de-risking).
#
# PATH VERDICT (see report): path (a) works. MicroPython asyncio's
# extmod/asyncio/stream.py open_connection() accepts ssl= and server_hostname=;
# it wraps the already-non-blocking socket with do_handshake_on_connect=False and
# the handshake is then driven entirely by the poll loop on the first read/write.
# No hand-rolled handshake driver (path b) is needed on this binary.
#
# BUFFERED-RECORD VERDICT: handled at the C level, NO Python drain loop required.
# extmod/modtls_mbedtls.c socket_ioctl(MP_STREAM_POLL) calls
# mbedtls_ssl_check_pending() and reports MP_STREAM_POLL_RD when mbedtls holds
# decrypted-but-unconsumed application data, even with nothing on the raw fd. The
# asyncio IOQueue poll therefore wakes the reader and the second WS frame in a
# packed TLS record is delivered without any new fd activity. Proven via the
# asyncio path in async_tls_pack_test.py: the `pack` server writes both frames in
# ONE TLS record then goes COMPLETELY SILENT (that mode starts no liveness
# pinger), and frame 2 is still delivered in ~3 ms. The silence is load-bearing -
# with no fd activity to wake poll, a small measured latency can only come from
# check_pending; a broken path would hang until the wait_for timeout. Note: the
# SSLSocket does NOT surface ioctl() to Python on this build, so the C
# MP_STREAM_POLL path is only reachable through the stream protocol select.poll
# uses internally - i.e. exactly the path asyncio drives. A direct Python ioctl
# probe is therefore not possible; the timed behavioural test is the authority.
#
# Import-time note: `tls` is the module name on this runtime (not `ssl`); CA data
# must be DER (PEM parsing is compiled out); SNI (server_hostname) is mandatory.
import asyncio
import sys
import time
import tls

from ws import WSClient

# py/stream.h constants, for the direct buffered-data ioctl probe.
MP_STREAM_POLL = 3
MP_STREAM_POLL_RD = 0x0001


def make_ctx(mode, ca_file=None):
    """Build a tls.SSLContext. mode: 'none' (CERT_NONE) or 'verify'
    (CERT_REQUIRED, requires ca_file as DER bytes on disk)."""
    ctx = tls.SSLContext(tls.PROTOCOL_TLS_CLIENT)
    if mode == "verify":
        ctx.verify_mode = tls.CERT_REQUIRED
        with open(ca_file, "rb") as f:
            ctx.load_verify_locations(f.read())  # DER bytes, single positional
    else:
        ctx.verify_mode = tls.CERT_NONE
    return ctx


def rss_kb():
    try:
        with open("/proc/self/status") as f:
            for ln in f:
                if ln.startswith("VmRSS"):
                    return int(ln.split()[1])
    except Exception:
        pass
    return -1


async def wss_connect(host, port, path, ctx, server_hostname):
    """Connect + TLS handshake + RFC6455 upgrade, all under the poll loop.
    Returns (WSClient, handshake_ms)."""
    t0 = time.ticks_ms()
    ws = await WSClient.connect(
        host, port, path, ssl=ctx, server_hostname=server_hostname)
    dt = time.ticks_diff(time.ticks_ms(), t0)
    return ws, dt


def buffered_poll_probe(ws):
    """Directly ask the tls object whether it holds buffered decrypted data with
    nothing on the fd. Returns True if ioctl(MP_STREAM_POLL, POLLIN) reports
    readable purely from mbedtls_ssl_check_pending()."""
    tls_obj = ws.r.s
    try:
        r = tls_obj.ioctl(MP_STREAM_POLL, MP_STREAM_POLL_RD)
        return bool(r & MP_STREAM_POLL_RD)
    except Exception as e:
        return "ioctl-unavailable: %r" % (e,)


async def register_and_ping(ws, name):
    reg = {"action": "register", "name": name, "channel_capable": False,
           "plugin_version": "0.2.0-async", "requestId": "reg-1"}
    await ws.send_json(reg)
    r1 = await ws.recv_json()
    r2 = await ws.recv_json()
    print("REG frame1:", r1)
    print("REG frame2:", r2)

    await ws.send_json({"action": "ping", "requestId": "ping-1"})
    p1 = await ws.recv_json()
    p2 = await ws.recv_json()
    print("PING frame1:", p1)
    print("PING frame2:", p2)
    return (r1, r2, p1, p2)


async def main():
    # argv: HOST PORT MODE [CA_FILE] [SNI]
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8766
    mode = sys.argv[3] if len(sys.argv) > 3 else "none"
    ca = sys.argv[4] if len(sys.argv) > 4 else None
    sni = sys.argv[5] if len(sys.argv) > 5 else host

    print("CONNECT host=%s port=%d certmode=%s sni=%s rss=%dkB"
          % (host, port, mode, sni, rss_kb()))
    ctx = make_ctx(mode, ca)
    ws, hs_ms = await wss_connect(host, port, "/ws", ctx, sni)
    print("HANDSHAKE+UPGRADE ok in %d ms, rss=%dkB" % (hs_ms, rss_kb()))

    name = "picolet-async-tls:anl@LAP-AU-PF65PM2K"
    await register_and_ping(ws, name)
    print("LIVE rss=%dkB" % rss_kb())
    await ws.close()
    print("closed cleanly, rss=%dkB" % rss_kb())


if __name__ == "__main__":
    asyncio.run(main())
