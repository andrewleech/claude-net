# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///
"""Mock Claude-hub WebSocket server mirroring the real hub's frame shapes.

Extended from the original register/ping-only spike into the P7 parity
harness's scriptable fixture: every `action` the claude-net plugins (bun
or MicroPython) send is answered plausibly, collisions are scriptable via
`--collide N`, and one synthetic inbound `message` event is pushed to
each newly-registered agent a couple of seconds after registration (a
stand-in for another agent's `send_message`), so a driver script can
observe the plugin turning it into a `notifications/claude/channel`
frame without needing a second live client.

- ws:// only (no TLS) — sufficient for both plugins, which derive their
  hub URL by swapping `http`->`ws`.
- action=="register":
    - if `--collide N` was given and this is one of the first N distinct
      names seen, replies `{"event":"response",...,"ok":false,"error":
      "Name already registered"}` (matches the `/already registered/i`
      check both plugins make) instead of registering.
    - otherwise: {"event":"registered",...} then
      {"event":"response",...,"ok":true,"data":{"name","full_name"}}
      (with `"upgrade_hint"` added to `data` when `--upgrade-hint TEXT`
      was given), and schedules the synthetic inbound message described
      above.
- action=="update_channel_capable" -> ok:true, no side effects (the mock
  hub does not gate delivery on the flag).
- action in (send, send_team, join_team, leave_team, list_agents,
  list_teams, ping, query_events) -> a plausible ok:true response; `ping`
  additionally emits a `message` event first (the round-trip the real
  hub documents for the `ping` tool). Exception: when `--nak-action
  ACTION` names this action, replies ok:false with `--nak-error TEXT`
  instead (used to script an "offline"/"no-channel"/etc delivery NAK).
- `--hang-action ACTION`: frames with this action are logged but never
  answered (every other action still gets its normal reply) — used to
  put one request permanently in-flight, to test that a client rejects
  it locally on its own shutdown rather than waiting forever.
- unrecognised action -> ok:false, error:"unknown action".
- sends a WS-level control ping ~2s after connect to confirm the client
  PONGs (also exercises the watchdog's PING-resets-idle-timer path) —
  suppressed under `--silent`.
- `--silent`: never proactively sends anything (no control ping, no
  synthetic inbound message) and never replies to any received frame.
  Used to script a fully idle connection for watchdog testing: the
  client's own idle-timeout is the only thing that will ever close it.
- `--frame-log PATH`: every frame received from the client is appended
  to PATH as one JSON line `{"seq": N, "frame": {...}}`, for a driver
  script to read back and diff the wire traffic two plugin runtimes
  produced against their own (separate) mock hub instance.

Usage: uv run mock_hub.py PORT [--collide N] [--upgrade-hint TEXT]
       [--nak-action ACTION] [--nak-error TEXT] [--silent]
       [--frame-log PATH] [--hang-action ACTION]
"""
import asyncio
import json
import sys
import uuid

import websockets

COLLIDE_COUNT = 0
UPGRADE_HINT = None
NAK_ACTION = None
NAK_ERROR = "Simulated NAK"
SILENT = False
FRAME_LOG_PATH = None
HANG_ACTION = None
_frame_seq = 0
_seen_names = set()


def _log_frame(msg):
    global _frame_seq
    if not FRAME_LOG_PATH:
        return
    _frame_seq += 1
    with open(FRAME_LOG_PATH, "a") as f:
        f.write(json.dumps({"seq": _frame_seq, "frame": msg}) + "\n")


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


async def push_inbound_message(ws, to_full_name, delay=2.0):
    """Simulate another agent's `send_message` landing a couple of
    seconds after registration, so a driver script can observe the
    plugin turn it into a `notifications/claude/channel` frame."""
    await asyncio.sleep(delay)
    frame = {
        "event": "message",
        "message_id": str(uuid.uuid4()),
        "from": "tester:mock@hub",
        "to": to_full_name,
        "type": "message",
        "content": "Hello from the mock hub!",
        "timestamp": "2026-07-23T00:00:00Z",
    }
    print(f"HUB: pushing inbound message to {to_full_name}", flush=True)
    try:
        await ws.send(json.dumps(frame))
    except websockets.ConnectionClosed:
        pass


async def handler(ws):
    print("HUB: client connected", flush=True)
    tasks = []
    if not SILENT:
        tasks.append(asyncio.create_task(control_pinger(ws)))
    try:
        async for raw in ws:
            msg = json.loads(raw)
            _log_frame(msg)
            if SILENT:
                # Scripted total silence: read and log, never reply.
                continue
            action = msg.get("action")
            rid = msg.get("requestId")
            name = msg.get("name")
            full_name = msg.get("full_name", name)
            print(f"HUB: recv action={action} rid={rid} name={name}", flush=True)

            if HANG_ACTION and action == HANG_ACTION:
                continue
            if NAK_ACTION and action == NAK_ACTION:
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": False,
                    "error": NAK_ERROR}))
            elif action == "register":
                if name not in _seen_names and len(_seen_names) < COLLIDE_COUNT:
                    _seen_names.add(name)
                    await ws.send(json.dumps({
                        "event": "response", "requestId": rid, "ok": False,
                        "error": "Name already registered"}))
                    continue
                _seen_names.add(name)
                await ws.send(json.dumps({
                    "event": "registered", "name": name, "full_name": full_name}))
                data = {"name": name, "full_name": full_name}
                if UPGRADE_HINT:
                    data["upgrade_hint"] = UPGRADE_HINT
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": True,
                    "data": data}))
                tasks.append(asyncio.create_task(push_inbound_message(ws, full_name)))
            elif action == "update_channel_capable":
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": True,
                    "data": {"channel_capable": msg.get("channel_capable")}}))
            elif action == "ping":
                await ws.send(json.dumps({
                    "event": "message",
                    "message_id": str(uuid.uuid4()),
                    "from": "system@claude-net",
                    "to": full_name or "",
                    "type": "message",
                    "content": "pong",
                    "timestamp": "2026-07-23T00:00:00Z"}))
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": True,
                    "data": {"pong": True}}))
            elif action in (
                "send", "send_team", "join_team", "leave_team",
                "list_agents", "list_teams", "query_events",
            ):
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": True,
                    "data": {"action": action}}))
            else:
                await ws.send(json.dumps({
                    "event": "response", "requestId": rid, "ok": False,
                    "error": "unknown action"}))
    except websockets.ConnectionClosed:
        print("HUB: connection closed", flush=True)
    finally:
        for t in tasks:
            t.cancel()


async def main():
    global COLLIDE_COUNT, UPGRADE_HINT, NAK_ACTION, NAK_ERROR, SILENT, FRAME_LOG_PATH, HANG_ACTION
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    if "--collide" in sys.argv:
        COLLIDE_COUNT = int(sys.argv[sys.argv.index("--collide") + 1])
    if "--upgrade-hint" in sys.argv:
        UPGRADE_HINT = sys.argv[sys.argv.index("--upgrade-hint") + 1]
    if "--nak-action" in sys.argv:
        NAK_ACTION = sys.argv[sys.argv.index("--nak-action") + 1]
    if "--nak-error" in sys.argv:
        NAK_ERROR = sys.argv[sys.argv.index("--nak-error") + 1]
    if "--silent" in sys.argv:
        SILENT = True
    if "--frame-log" in sys.argv:
        FRAME_LOG_PATH = sys.argv[sys.argv.index("--frame-log") + 1]
    if "--hang-action" in sys.argv:
        HANG_ACTION = sys.argv[sys.argv.index("--hang-action") + 1]
    async with websockets.serve(handler, "127.0.0.1", port, ping_interval=None):
        print(f"HUB: listening on 127.0.0.1:{port}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
