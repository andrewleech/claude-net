import sys; sys.path.insert(0,"/home/corona/claude-net-mpy/src/plugin-mpy/lib")
import asyncio, time, mpyws
URL=sys.argv[1]; MODE=sys.argv[2]
async def main():
    ctx=None
    if MODE=="wss":
        import tls; ctx=tls.SSLContext(tls.PROTOCOL_TLS_CLIENT); ctx.verify_mode=tls.CERT_NONE
    ws=await mpyws.connect(URL, ssl=ctx) if ctx else await mpyws.connect(URL)
    async def recvloop():
        try:
            while True: await ws.recv()
        except Exception as e: print("recv ended:",e)
    asyncio.create_task(recvloop())
    for _ in range(18):   # ~36s
        await asyncio.sleep(2)
        idle=time.ticks_diff(time.ticks_ms(), ws.last_recv_ms)
        print("idle_ms=%d" % idle)
        if idle>=31000: print("WATCHDOG-WOULD-FIRE"); break
asyncio.run(main())
