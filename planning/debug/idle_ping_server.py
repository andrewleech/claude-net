import socket, ssl, sys, hashlib, base64, threading, time, os
PORT=int(sys.argv[1]); MODE=sys.argv[2]; INTERVAL=float(sys.argv[3]); DUR=float(sys.argv[4])
GUID="258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
def handshake(conn):
    data=b""
    while b"\r\n\r\n" not in data: data+=conn.recv(1024)
    key=None
    for line in data.decode(errors="ignore").split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"): key=line.split(":",1)[1].strip()
    acc=base64.b64encode(hashlib.sha1((key+GUID).encode()).digest()).decode()
    conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept:%s\r\n\r\n"%acc).encode())
def serve(conn):
    handshake(conn)
    t0=time.time()
    while time.time()-t0 < DUR:
        time.sleep(INTERVAL)
        try: conn.sendall(bytes([0x89,0x00]))  # server PING, unmasked, empty payload
        except OSError: return
srv=socket.socket(socket.AF_INET,socket.SOCK_STREAM); srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
srv.bind(("127.0.0.1",PORT)); srv.listen(1)
if MODE=="wss":
    HERE=os.path.dirname(os.path.abspath(__file__))
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(HERE+"/localhost_cert.pem",HERE+"/localhost_key.pem")
print("SERVER-READY",flush=True)
conn,_=srv.accept()
if MODE=="wss": conn=ctx.wrap_socket(conn,server_side=True)
serve(conn)
