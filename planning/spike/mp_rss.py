# Connect + register + hold live wss, then read own VmRSS from /proc.
import socket, tls, binascii, random, json
HOST="telie.story-kettle.ts.net"; PORT=4815
def rb(n): return bytes(random.getrandbits(8) for _ in range(n))
def rex(s,n):
    b=b""
    while len(b)<n:
        c=s.read(n-len(b))
        if not c: raise OSError("eof")
        b+=c
    return b
def send(s,p):
    d=p.encode(); n=len(d); h=bytearray([0x81,0x80|n]); m=rb(4); h+=m
    s.write(bytes(h)+bytes(d[i]^m[i&3] for i in range(n)))
def recv(s):
    b0=rex(s,1)[0]; l=rex(s,1)[0]&0x7F
    if l==126: l=int.from_bytes(rex(s,2),"big")
    return rex(s,l) if l else b""
def rss():
    with open("/proc/self/status") as f:
        for ln in f:
            if ln.startswith("VmRSS"): return ln.strip()
    return "n/a"
ai=socket.getaddrinfo(HOST,PORT,0,socket.SOCK_STREAM)[0]
sk=socket.socket(ai[0],ai[1],ai[2]); sk.connect(ai[-1])
ctx=tls.SSLContext(tls.PROTOCOL_TLS_CLIENT); ctx.verify_mode=tls.CERT_NONE
s=ctx.wrap_socket(sk,server_hostname=HOST)
key=binascii.b2a_base64(rb(16)).strip().decode()
s.write(("GET /ws HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"%(HOST,PORT,key)).encode())
h=b""
while b"\r\n\r\n" not in h: h+=rex(s,1)
name="picolet-tls-spike-rss-%s:anl@LAP-AU-PF65PM2K"%binascii.hexlify(rb(4)).decode()
send(s,json.dumps({"action":"register","name":name,"channel_capable":False,"plugin_version":"0.2.0","requestId":binascii.hexlify(rb(8)).decode()}))
recv(s); recv(s)
print("[LIVE wss connection]", rss())
s.write(bytes([0x88,0x80])+rb(4)); s.close()
