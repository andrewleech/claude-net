# MicroPython wss client for the claude-net hub, driven by the TLS-enabled
# picolet runtime. Does TCP -> mbedtls TLS (SNI) -> RFC6455 upgrade ->
# masked register + ping frames. CERT mode chosen by argv[1].
import socket, tls, binascii, random, json, sys

HOST = "telie.story-kettle.ts.net"
PORT = 4815
PATH = "/ws"
CA_FILE = sys.argv[2] if len(sys.argv) > 2 else None
MODE = sys.argv[1] if len(sys.argv) > 1 else "none"

def rbytes(n):
    return bytes(random.getrandbits(8) for _ in range(n))

def readexactly(s, n):
    buf = b""
    while len(buf) < n:
        chunk = s.read(n - len(buf))
        if not chunk:
            raise OSError("eof, got %d/%d" % (len(buf), n))
        buf += chunk
    return buf

def ws_send_text(s, payload):
    data = payload.encode() if isinstance(payload, str) else payload
    n = len(data)
    hdr = bytearray()
    hdr.append(0x81)               # FIN + text
    if n < 126:
        hdr.append(0x80 | n)       # MASK bit + len
    elif n < 65536:
        hdr.append(0x80 | 126); hdr += n.to_bytes(2, "big")
    else:
        hdr.append(0x80 | 127); hdr += n.to_bytes(8, "big")
    mask = rbytes(4)
    hdr += mask
    masked = bytearray(n)
    for i in range(n):
        masked[i] = data[i] ^ mask[i & 3]
    s.write(bytes(hdr) + bytes(masked))

def ws_recv(s):
    b0 = readexactly(s, 1)[0]
    b1 = readexactly(s, 1)[0]
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    ln = b1 & 0x7F
    if ln == 126:
        ln = int.from_bytes(readexactly(s, 2), "big")
    elif ln == 127:
        ln = int.from_bytes(readexactly(s, 8), "big")
    if masked:
        m = readexactly(s, 4)
    payload = readexactly(s, ln) if ln else b""
    if masked:
        payload = bytes(payload[i] ^ m[i & 3] for i in range(ln))
    return opcode, payload

# --- TCP ---
ai = socket.getaddrinfo(HOST, PORT, 0, socket.SOCK_STREAM)[0]
sock = socket.socket(ai[0], ai[1], ai[2])
sock.connect(ai[-1])
print("[i] TCP connected to", HOST, PORT)

# --- TLS with SNI ---
ctx = tls.SSLContext(tls.PROTOCOL_TLS_CLIENT)
print("[i] mbedtls version:", tls.MBEDTLS_VERSION)
if MODE == "verify":
    ctx.verify_mode = tls.CERT_REQUIRED
    # Port's mbedtls has MBEDTLS_PEM_PARSE_C disabled -> DER only.
    with open(CA_FILE, "rb") as f:
        cadata = f.read()
    ctx.load_verify_locations(cadata)   # single positional; DER bytes
    print("[i] CERT_REQUIRED, CA (DER):", CA_FILE)
else:
    ctx.verify_mode = tls.CERT_NONE
    print("[i] CERT_NONE (no verification)")
s = ctx.wrap_socket(sock, server_hostname=HOST)
print("[i] TLS handshake OK (SNI=%s)" % HOST)

# --- RFC6455 upgrade ---
key = binascii.b2a_base64(rbytes(16)).strip().decode()
req = (
    "GET %s HTTP/1.1\r\n" % PATH +
    "Host: %s:%d\r\n" % (HOST, PORT) +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: %s\r\n" % key +
    "Sec-WebSocket-Version: 13\r\n\r\n"
)
s.write(req.encode())

# read status line + headers up to blank line
hdr = b""
while b"\r\n\r\n" not in hdr:
    hdr += readexactly(s, 1)
status = hdr.split(b"\r\n", 1)[0].decode()
print("[i] upgrade response:", status)
assert "101" in status, "expected 101 switching protocols"

# --- register ---
name = "picolet-tls-spike-%s:anl@LAP-AU-PF65PM2K" % binascii.hexlify(rbytes(4)).decode()
reg = {"action": "register", "name": name, "channel_capable": False,
       "plugin_version": "0.2.0",
       "requestId": binascii.hexlify(rbytes(8)).decode()}
print("\n>>> SEND register:\n" + json.dumps(reg))
ws_send_text(s, json.dumps(reg))
for i in range(2):
    op, pl = ws_recv(s)
    print("<<< RECV #%d (op=%d):\n%s" % (i + 1, op, pl.decode()))

# --- ping ---
pg = {"action": "ping", "requestId": binascii.hexlify(rbytes(8)).decode()}
print("\n>>> SEND ping:\n" + json.dumps(pg))
ws_send_text(s, json.dumps(pg))
for i in range(2):
    op, pl = ws_recv(s)
    print("<<< RECV #%d (op=%d):\n%s" % (i + 1, op, pl.decode()))

# --- RSS while TLS connection is live ---
try:
    with open("/proc/self/status") as f:
        for ln in f:
            if ln.startswith("VmRSS") or ln.startswith("VmHWM"):
                print("[rss]", ln.strip())
except Exception as e:
    print("[rss] unavailable:", e)

# --- clean close (opcode 0x8, masked, empty) ---
mask = rbytes(4)
s.write(bytes([0x88, 0x80]) + mask)
s.close()
print("\n[i] closed cleanly")
