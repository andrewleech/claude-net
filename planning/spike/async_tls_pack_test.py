# Buffered-record hazard proof against the `pack` server mode.
#
# The server writes BOTH register-reply WS frames in ONE ssl.send() -> a single
# TLS record carrying two complete WS frames -> then goes completely SILENT (the
# `pack` mode starts no liveness pinger, so there is genuinely no further fd
# activity on the connection). We:
#   1. read frame 1 via the normal asyncio poll path,
#   2. immediately probe s.ioctl(MP_STREAM_POLL, POLLIN) (best-effort; the
#      SSLSocket does not expose ioctl() to Python on this build, so this is
#      informational only),
#   3. read frame 2 via the normal asyncio poll path and MEASURE its latency.
#
# Because the server is silent, the only way frame 2 can become readable is the
# C-level socket_ioctl(MP_STREAM_POLL) consulting mbedtls_ssl_check_pending() and
# reporting MP_STREAM_POLL_RD for the decrypted-but-unconsumed bytes. If that path
# were broken the queue_read() poll would block until the wait_for timeout. A
# small latency (well under 200 ms) with the server silent is therefore the
# authoritative proof that the buffered-record hazard is handled at the C level
# and no Python drain loop is required.
import asyncio
import sys
import time

from async_tls import make_ctx, wss_connect, buffered_poll_probe


async def main():
    port = int(sys.argv[1])
    ctx = make_ctx("none")
    ws, hs = await wss_connect("127.0.0.1", port, "/ws", ctx, "127.0.0.1")
    print("handshake+upgrade %d ms" % hs)

    await ws.send_json({"action": "register", "name": "pack:anl@host",
                        "requestId": "reg-1"})

    # Frame 1 (server sent both frames in one record before we read anything).
    f1 = await asyncio.wait_for(ws.recv_json(), 3)
    t_after_f1 = time.ticks_ms()
    print("FRAME1:", f1)

    # Best-effort direct probe of the tls object for buffered decrypted data.
    probe = buffered_poll_probe(ws)
    print("BUFFERED_PROBE ioctl(MP_STREAM_POLL,RD) readable:", probe)

    # Frame 2 must arrive purely from the mbedtls decrypt buffer, no new fd bytes.
    # Server is silent (no pinger in pack mode), so latency == time the poll loop
    # took to surface the already-buffered record.
    try:
        f2 = await asyncio.wait_for(ws.recv_json(), 3)
        dt = time.ticks_diff(time.ticks_ms(), t_after_f1)
        print("FRAME2:", f2)
        print("FRAME2_LATENCY_MS:", dt)
        if dt < 200:
            print("VERDICT: buffered second frame delivered in %d ms against a "
                  "SILENT server (no pinger, no new fd activity) -> mbedtls "
                  "check_pending surfaced via MP_STREAM_POLL at the C level; "
                  "hazard handled, no Python drain loop needed" % dt)
        else:
            print("VERDICT: frame 2 arrived but took %d ms (>=200) against a "
                  "silent server -> SUSPICIOUS: poll may have woken on something "
                  "other than check_pending; investigate" % dt)
    except asyncio.TimeoutError:
        print("VERDICT: TIMEOUT waiting for frame 2 against a silent server -> "
              "BUFFERED-RECORD HAZARD LIVE, poll loop did NOT surface the "
              "buffered decrypted data")

    await ws.close()


asyncio.run(main())
