import sys; sys.path.insert(0,"/home/anl/claude-net-mpy/src/plugin-mpy/lib")
sys.path.insert(0,"/home/anl/claude-net-mpy/src/plugin-mpy")
import asyncio, time, json, mpyws
from mpyjsonrpc import JsonRpcPeer
from _stdin_shim import StdinLineShim
async def main():
    with open("/home/anl/claude-net-mpy/src/plugin-mpy/isrg_root_x1.der","rb") as f: der=f.read()
    ws=await mpyws.connect("wss://telie.story-kettle.ts.net:4815/ws", cadata=der, server_hostname="telie.story-kettle.ts.net")
    await ws.send(json.dumps({"action":"register","name":"idle-probe2:anl@LAP-AU-PF65PM2K","channel_capable":False,"plugin_version":"0.2.0","cc_pid":99998,"cwd":"/tmp"}))
    async def hubrecv():
        try:
            while True: await ws.recv()
        except Exception as e: print("hub closed:",e)
    asyncio.create_task(hubrecv())
    # concurrent MCP stdio serving (idle: no stdin input) — the plugin's real condition
    peer=JsonRpcPeer(stdin=StdinLineShim(sys.stdin.buffer))
    asyncio.create_task(peer.serve())
    for i in range(16):
        await asyncio.sleep(2)
        idle=time.ticks_diff(time.ticks_ms(), ws.last_recv_ms)
        print("t=%02ds hub_idle_ms=%d"%(i*2, idle))
        if idle>=31000: print("STARVED — watchdog would fire (ROOT CAUSE CONFIRMED)"); return
    print("healthy (not starved)")
asyncio.run(main())
