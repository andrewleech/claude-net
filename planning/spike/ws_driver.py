# Drive the WS client against the mock hub.
import asyncio, sys
from ws import WSClient

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


async def main():
    ws = await WSClient.connect("127.0.0.1", PORT, "/")
    print("CLIENT: connected + upgraded")

    # register (name in session:user@host shape)
    await ws.send_json({
        "action": "register",
        "requestId": "req-1",
        "name": "picolet:andrew@host",
        "full_name": "picolet:andrew@host",
    })
    print("CLIENT: reg frame 1:", await ws.recv_json())
    print("CLIENT: reg frame 2:", await ws.recv_json())

    # ping
    await ws.send_json({"action": "ping", "requestId": "req-2"})
    print("CLIENT: ping frame 1:", await ws.recv_json())
    print("CLIENT: ping frame 2:", await ws.recv_json())

    # Keep the connection alive long enough for the hub's WS control ping
    # (~2s in) to arrive and be PONGed. Drain any frames during the wait.
    print("CLIENT: idling 4s to catch server control-ping...")
    try:
        while True:
            msg = await asyncio.wait_for(ws.recv_json(), 4)
            print("CLIENT: extra frame:", msg)
    except asyncio.TimeoutError:
        pass

    await ws.close()
    print("CLIENT: closed cleanly")


asyncio.run(main())
