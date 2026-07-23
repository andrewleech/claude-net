# Part C: stdin JSON-RPC reader + WS client in ONE asyncio loop (plugin shape).
import asyncio, sys, json
from ws import WSClient

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


def rss_mb():
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024.0
    except Exception:
        return -1


async def ws_task(ws, stop):
    # Service the socket: reply to control frames, print server pushes,
    # stay alive until stdin closes.
    await ws.send_json({"action": "register", "requestId": "r0",
                        "name": "picolet:andrew@host",
                        "full_name": "picolet:andrew@host"})
    while not stop.is_set():
        try:
            msg = await asyncio.wait_for(ws.recv_json(), 1)
            if msg is None:
                break
            print("WS<-", msg)
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
        try:
            req = json.loads(line)
        except Exception as e:
            print("STDIN: bad json:", e)
            continue
        print("STDIN-RPC:", req, "| rss=%.1fMB" % rss_mb())
        # forward the stdin request onto the live ws connection
        await ws.send_json({"action": "ping", "requestId": req.get("id")})


async def main():
    ws = await WSClient.connect("127.0.0.1", PORT, "/")
    print("MAIN: ws connected, rss=%.1fMB" % rss_mb())
    stop = asyncio.Event()
    wt = asyncio.create_task(ws_task(ws, stop))
    await stdin_task(ws, stop)
    await wt
    print("MAIN: done, rss=%.1fMB" % rss_mb())


asyncio.run(main())
