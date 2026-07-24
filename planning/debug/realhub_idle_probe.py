import sys; sys.path.insert(0,"/home/corona/claude-net-mpy/src/plugin-mpy/lib")
import asyncio, time, json, mpyws
URL="wss://telie.story-kettle.ts.net:4815/ws"
async def main():
    with open("/home/corona/claude-net-mpy/src/plugin-mpy/isrg_root_x1.der","rb") as f: der=f.read()
    ws=await mpyws.connect(URL, cadata=der, server_hostname="telie.story-kettle.ts.net")
    # register as a throwaway probe so the hub treats us as a live agent + pings us
    await ws.send(json.dumps({"action":"register","name":"idle-probe:anl@LAP-AU-PF65PM2K",
        "channel_capable":False,"plugin_version":"0.2.0","cc_pid":99999,"cwd":"/tmp"}))
    closed=[False]
    async def recvloop():
        try:
            while True:
                m=await ws.recv()
        except Exception as e:
            closed[0]=True; print("CONN CLOSED:",e)
    asyncio.create_task(recvloop())
    for i in range(20):   # ~40s
        await asyncio.sleep(2)
        if closed[0]: print("stopped at %ds (connection closed)"%(i*2)); return
        idle=time.ticks_diff(time.ticks_ms(), ws.last_recv_ms)
        print("t=%02ds idle_ms=%d closed=%s"%(i*2, idle, ws.closed))
        if idle>=31000: print("WATCHDOG-WOULD-FIRE"); return
    print("SURVIVED 40s idle, connection healthy")
asyncio.run(main())
