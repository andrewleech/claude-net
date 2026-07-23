# RFC6455 WebSocket client over ws:// for MicroPython (no ssl/hashlib).
# Uses asyncio streams (poll-integrated) for non-blocking framing.
import asyncio, os, struct, binascii, json

OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WSClient:
    def __init__(self, reader, writer):
        self.r = reader
        self.w = writer
        self.closed = False

    @classmethod
    async def connect(cls, host, port, path="/"):
        # asyncio.open_connection resolves via getaddrinfo internally.
        reader, writer = await asyncio.open_connection(host, port)
        key = binascii.b2a_base64(os.urandom(16)).strip().decode()
        req = (
            "GET {} HTTP/1.1\r\n"
            "Host: {}:{}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: {}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).format(path, host, port, key)
        writer.write(req.encode())
        await writer.drain()
        # Read the 101 response headers up to the blank line. We don't verify
        # Sec-WebSocket-Accept (would need SHA1, which isn't available).
        status = await reader.readline()
        if b"101" not in status:
            raise OSError("handshake failed: " + status.decode().strip())
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
        return cls(reader, writer)

    async def _send_frame(self, opcode, payload=b""):
        n = len(payload)
        hdr = bytearray()
        hdr.append(0x80 | opcode)  # FIN=1, opcode
        # client frames MUST be masked -> high bit of length byte set
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack("!H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack("!Q", n)
        mask = os.urandom(4)
        hdr += mask
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mask[i & 3]
        self.w.write(hdr)
        self.w.write(masked)
        await self.w.drain()

    async def send_text(self, s):
        await self._send_frame(OP_TEXT, s.encode())

    async def send_json(self, obj):
        await self.send_text(json.dumps(obj))

    async def _read_exact(self, n):
        if n == 0:
            return b""
        return await self.r.readexactly(n)

    async def _read_frame(self):
        """Return (opcode, payload) for one frame, or (None, None) on EOF.
        Control frames are handled internally (auto-PONG); this returns the
        raw frame so the caller can reassemble fragments."""
        b0b1 = await self._read_exact(2)
        b0, b1 = b0b1[0], b0b1[1]
        fin = b0 & 0x80
        opcode = b0 & 0x0F
        masked = b1 & 0x80          # server->client MUST be unmasked
        ln = b1 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", await self._read_exact(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", await self._read_exact(8))[0]
        if masked:
            mkey = await self._read_exact(4)
        payload = await self._read_exact(ln)
        if masked:
            pb = bytearray(payload)
            for i in range(ln):
                pb[i] ^= mkey[i & 3]
            payload = bytes(pb)
        return fin, opcode, payload

    async def recv(self):
        """Receive one application message (text/binary), transparently
        handling control frames (PING->PONG, CLOSE) and fragmentation.
        Returns bytes payload, or None if the connection closed."""
        frags = None
        msg_op = None
        while True:
            res = await self._read_frame()
            if res is None:
                return None
            fin, opcode, payload = res
            if opcode == OP_PING:
                await self._send_frame(OP_PONG, payload)   # echo payload
                print("CLIENT: <- PING, -> PONG (%d bytes)" % len(payload))
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
                print("CLIENT: <- CLOSE code=%s" % code)
                await self.close(echo=True)
                return None
            # data frame (possibly fragmented)
            if opcode in (OP_TEXT, OP_BIN):
                msg_op = opcode
                frags = bytearray(payload)
            elif opcode == OP_CONT and frags is not None:
                frags += payload
            if fin:
                return bytes(frags)

    async def recv_json(self):
        data = await self.recv()
        return None if data is None else json.loads(data)

    async def close(self, code=1000, echo=False):
        if self.closed:
            return
        self.closed = True
        try:
            if echo:
                await self._send_frame(OP_CLOSE, b"")
            else:
                await self._send_frame(OP_CLOSE, struct.pack("!H", code))
        except Exception:
            pass
        try:
            self.w.close()
            await self.w.wait_closed()
        except Exception:
            pass
