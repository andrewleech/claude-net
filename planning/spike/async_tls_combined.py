# Proof: stdin readline (asyncio.StreamReader) and wss traffic interleave in ONE
# asyncio loop over TLS with ~0 idle CPU. Async-over-TLS port of combined.py.
#
# The wss connection (TLS handshake + post-handshake I/O) and stdin both suspend
# on the same select.poll in asyncio's IOQueue; when neither has activity the
# process blocks in poll() (zero CPU). The server's WS control PING ~1.5s in is
# answered with a PONG to show the socket half stays live while stdin is idle.
#
# argv: PORT [certmode] [ca_file]
import asyncio
import sys
import time

from async_tls import make_ctx, rss_kb
from ws import WSClient


async def ws_task(ws, stop):
    await ws.send_json({"action": "register", "name": "picolet:anl@host",
                        "requestId": "reg-1"})
    while not stop.is_set():
        try:
            msg = await asyncio.wait_for(ws.recv_json(), 1)
            if msg is None:
                print("WS: connection closed by peer")
                break
            print("WS<-", msg, "| rss=%dkB" % rss_kb())
        except asyncio.TimeoutError:
            continue
    await ws.close()


async def stdin_task(ws, stop):
    sr = asyncio.StreamReader(sys.stdin.buffer)
    while True:
        line = await sr.readline()
        if not line:
            print("STDIN: EOF -> shutting down")
            stop.set()
            break
        line = line.strip()
        if not line:
            continue
        print("STDIN-RPC:", line.decode(), "| rss=%dkB" % rss_kb())
        # forward each stdin line onto the live wss connection as a ping
        await ws.send_json({"action": "ping", "requestId": line.decode()})


async def main():
    port = int(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else "none"
    ca = sys.argv[3] if len(sys.argv) > 3 else None
    ctx = make_ctx(mode, ca)
    t0 = time.ticks_ms()
    ws = await WSClient.connect("127.0.0.1", port, "/ws",
                                ssl=ctx, server_hostname="127.0.0.1")
    print("MAIN: wss up in %d ms, rss=%dkB"
          % (time.ticks_diff(time.ticks_ms(), t0), rss_kb()))
    stop = asyncio.Event()
    wt = asyncio.create_task(ws_task(ws, stop))
    await stdin_task(ws, stop)
    await wt
    print("MAIN: done, rss=%dkB" % rss_kb())


asyncio.run(main())
