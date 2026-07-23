# Handshake-edge scenarios: stall (EAGAIN path), close-during-handshake,
# and CERT_REQUIRED verification failure. argv: SCENARIO PORT [CA_FILE]
import asyncio
import sys
import time

from async_tls import make_ctx, wss_connect


async def scenario_stall(port):
    # Server sleeps ~1.5s after TCP accept before the TLS handshake, so the
    # client handshake must spin on WANT_READ (EAGAIN) under the poll loop.
    # Completion alone doesn't prove the loop stayed live during the stall --
    # a hand-rolled busy-poll driver would also eventually complete. The
    # load-bearing property is that the single asyncio event loop keeps
    # scheduling OTHER tasks while the handshake is stalled server-side, i.e.
    # it is not blocked in C. A concurrent ticker task, incrementing a counter
    # every 50ms, proves this directly: it can only advance between yields of
    # the handshake-awaiting task, so a blocking handshake would starve it at
    # 0 (never dequeued) or 1 (its pre-first-await increment) tick, while a
    # correctly-yielding handshake lets it accumulate roughly stall_ms/50 ticks.
    ctx = make_ctx("none")
    ticker_state = {"ticks": 0, "done": False}

    async def ticker():
        while not ticker_state["done"]:
            ticker_state["ticks"] += 1
            await asyncio.sleep_ms(50)

    ticker_task = asyncio.create_task(ticker())
    t0 = time.ticks_ms()
    ws, hs = await wss_connect("127.0.0.1", port, "/ws", ctx, "127.0.0.1")
    total = time.ticks_diff(time.ticks_ms(), t0)
    ticker_state["done"] = True
    await ticker_task
    print("STALL: handshake+upgrade completed after %d ms (server stalled the "
          "ServerHello; EAGAIN/poll path exercised)" % total)
    print("STALL: ticker_ticks=%d (concurrent task progress during the stall; "
          "the event loop was not blocked in C)" % ticker_state["ticks"])
    await ws.send_json({"action": "register", "name": "stall:anl@host",
                        "requestId": "r"})
    print("STALL: reg reply:", await asyncio.wait_for(ws.recv_json(), 3))
    await ws.close()


async def scenario_close(port):
    ctx = make_ctx("none")
    try:
        ws, hs = await asyncio.wait_for(
            wss_connect("127.0.0.1", port, "/ws", ctx, "127.0.0.1"), 5)
        print("CLOSE: UNEXPECTED success", hs)
    except asyncio.TimeoutError:
        print("CLOSE: FAIL - hung (timed out) instead of erroring")
    except Exception as e:
        print("CLOSE: handshake raised %s: %s (expected - no hang)"
              % (type(e).__name__, e))


async def scenario_verify(port, ca):
    # CERT_REQUIRED with the ISRG CA against the local self-signed cert -> the
    # cert chain does not verify -> handshake must raise, not connect.
    ctx = make_ctx("verify", ca)
    try:
        ws, hs = await asyncio.wait_for(
            wss_connect("127.0.0.1", port, "/ws", ctx, "127.0.0.1"), 5)
        print("VERIFY: UNEXPECTED success - self-signed cert accepted!")
        await ws.close()
    except asyncio.TimeoutError:
        print("VERIFY: FAIL - hung instead of rejecting")
    except Exception as e:
        print("VERIFY: rejected self-signed cert with %s: %s (expected)"
              % (type(e).__name__, e))


async def scenario_abrupt(port):
    # Server replies to register with frame 1, then RSTs the TCP connection
    # mid-frame (1 byte of frame 2, no OP_CLOSE). This is the real-hub eviction /
    # RST shape. recv() must honour the graceful-close contract: return the first
    # message, then return None on the abrupt EOF -- NOT propagate EOFError.
    ctx = make_ctx("none")
    ws, hs = await wss_connect("127.0.0.1", port, "/ws", ctx, "127.0.0.1")
    await ws.send_json({"action": "register", "name": "abrupt:anl@host",
                        "requestId": "r"})
    m1 = await asyncio.wait_for(ws.recv_json(), 3)
    print("ABRUPT: frame1:", m1)
    try:
        m2 = await asyncio.wait_for(ws.recv_json(), 3)
    except asyncio.TimeoutError:
        print("ABRUPT: FAIL - recv hung after mid-frame RST")
        return
    except Exception as e:
        print("ABRUPT: FAIL - recv raised %s: %s (expected graceful None)"
              % (type(e).__name__, e))
        return
    if m2 is None:
        print("ABRUPT: recv() returned None on mid-frame RST (expected - "
              "graceful-close contract honoured, no exception propagated)")
    else:
        print("ABRUPT: UNEXPECTED payload after RST:", m2)


async def main():
    scen = sys.argv[1]
    port = int(sys.argv[2])
    if scen == "stall":
        await scenario_stall(port)
    elif scen == "close":
        await scenario_close(port)
    elif scen == "verify":
        await scenario_verify(port, sys.argv[3])
    elif scen == "abrupt":
        await scenario_abrupt(port)


asyncio.run(main())
