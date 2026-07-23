# Hold a live wss session to the real hub for ~12s under the async loop, so the
# hub's ~5s control PING is received and auto-PONGed by WSClient.recv (proving
# post-handshake control-frame liveness works over async TLS). Measures idle CPU.
import asyncio
import sys

from async_tls import make_ctx, rss_kb
from ws import WSClient

H = "telie.story-kettle.ts.net"


async def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
    ca = "isrg_root_x1.der" if mode == "verify" else None
    ws = await WSClient.connect(H, 4815, "/ws", ssl=make_ctx(mode, ca),
                                server_hostname=H)
    await ws.send_json({"action": "register", "name": "picolet-hold:anl@host",
                        "requestId": "r"})
    print("reg1:", await ws.recv_json())
    print("reg2:", await ws.recv_json())
    print("holding ~12s to catch hub control PING(s), rss=%dkB" % rss_kb())
    stop = asyncio.Event()

    async def reader():
        # recv() auto-PONGs control PINGs; returns app messages / None on close.
        while not stop.is_set():
            try:
                m = await asyncio.wait_for(ws.recv(), 2)
            except asyncio.TimeoutError:
                continue
            if m is None:
                print("closed by hub")
                return
            print("app msg:", m[:120])

    t = asyncio.create_task(reader())
    await asyncio.sleep(12)
    stop.set()
    t.cancel()
    print("survived hold (no eviction), rss=%dkB" % rss_kb())
    await ws.close()


asyncio.run(main())
