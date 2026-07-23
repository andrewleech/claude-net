# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///
"""Mock Claude-hub WebSocket server mirroring register/ping shapes.

- accepts ws:// connection
- action=="register" -> {"event":"registered",...} then {"event":"response",requestId,ok,data}
- action=="ping"     -> {"event":"message",...}    then {"event":"response",requestId,ok,data:{pong:true}}
- sends a WS-level control ping ~2s after connect to confirm the client PONGs
"""
import asyncio
import json
import sys

import websockets


async def control_pinger(ws):
    # WS-level control ping a couple seconds in; if the client doesn't PONG,
    # websockets closes the connection on ping_timeout (default 20s).
    await asyncio.sleep(2)
    try:
        print("HUB: sending WS control ping", flush=True)
        pong_waiter = await ws.ping(b"hub-ping")
        await asyncio.wait_for(pong_waiter, timeout=5)
        print("HUB: got PONG from client (client alive)", flush=True)
    except Exception as e:
        print(f"HUB: no pong / ping failed: {e!r}", flush=True)


async def handler(ws):
    print("HUB: client connected", flush=True)
    pinger = asyncio.create_task(control_pinger(ws))
    try:
        async for raw in ws:
            msg = json.loads(raw)
            action = msg.get("action")
            rid = msg.get("requestId")
            name = msg.get("name")
            full_name = msg.get("full_name", name)
            print(f"HUB: recv action={action} rid={rid} name={name}", flush=True)
            if action == "register":
                await ws.send(json.dumps({
                    "event": "registered", "name": name, "full_name": full_name}))
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": True,
                    "data": {"name": name, "full_name": full_name}}))
            elif action == "ping":
                await ws.send(json.dumps({
                    "event": "message", "text": "hello from hub"}))
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": True,
                    "data": {"pong": True}}))
            else:
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": False,
                    "error": "unknown action"}))
    except websockets.ConnectionClosed:
        print("HUB: connection closed", flush=True)
    finally:
        pinger.cancel()


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    async with websockets.serve(handler, "127.0.0.1", port, ping_interval=None):
        print(f"HUB: listening on 127.0.0.1:{port}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
