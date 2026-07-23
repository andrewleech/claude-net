# /// script
# requires-python = ">=3.9"
# dependencies = ["websocket-client"]
# ///
import json, os, socket, uuid, sys
from websocket import create_connection

URL = "wss://telie.story-kettle.ts.net:4815/ws"
user = os.environ.get("USER") or "spikeuser"
host = socket.gethostname()
name = f"picolet-spike-{uuid.uuid4().hex[:8]}:{user}@{host}"
print(f"[i] connecting to {URL}")
print(f"[i] register name: {name}")

ws = create_connection(URL, timeout=10)
print("[i] TCP+TLS+WS handshake OK")

reg = {"action": "register", "name": name,
       "channel_capable": False, "plugin_version": "0.0.0-spike",
       "cc_pid": os.getpid(), "cwd": os.getcwd(),
       "requestId": str(uuid.uuid4())}
print("\n>>> SEND register:\n" + json.dumps(reg))
ws.send(json.dumps(reg))

# register produces (registered frame) + (response frame); read 2
for i in range(2):
    ws.settimeout(5)
    print(f"<<< RECV #{i+1}:\n" + ws.recv())

ping = {"action": "ping", "requestId": str(uuid.uuid4())}
print("\n>>> SEND ping:\n" + json.dumps(ping))
ws.send(json.dumps(ping))
# ping produces (message inbound echo) + (response pong); read 2
for i in range(2):
    ws.settimeout(5)
    print(f"<<< RECV #{i+1}:\n" + ws.recv())

ws.close()
print("\n[i] closed cleanly")
