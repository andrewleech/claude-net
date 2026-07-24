# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Raw-frame proof harness for mpyws's framing/fragmentation/error taxonomy.

Speaks RFC6455 by hand (no `websockets` library) so each scenario can put
exact, otherwise-hard-to-provoke bytes on the wire: a fragmented message
with a control frame interleaved mid-fragment, a reserved-bit violation,
an invalid opcode, an oversized control frame, and a bare RST with no
Close frame. For each scenario this script starts a one-shot raw asyncio
server, spawns the `mpyws`-using MicroPython driver script (see
`_DRIVER`) as a subprocess pointed at it, and prints the driver's
stdout verbatim (already asserts against the expected outcome and exits
0 on a mismatch --> nonzero would show as an assertion traceback below).

Usage: uv run proof_taxonomy.py [MPY_BIN]
"""
import asyncio
import base64
import hashlib
import os
import struct
import subprocess
import sys
import tempfile

MPY_BIN = (
    sys.argv[1] if len(sys.argv) > 1 else
    "/home/corona/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-mcp"
)
LIB_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


async def read_client_frame(reader):
    """Read one (client-masked) frame off `reader`; return `(opcode, fin,
    payload)` with the payload already unmasked. Shared by scenarios that
    need to inspect a frame the mpyws driver sends (a PONG echo, a CLOSE
    frame, ...)."""
    b0b1 = await reader.readexactly(2)
    opcode = b0b1[0] & 0x0F
    fin = bool(b0b1[0] & 0x80)
    masked = bool(b0b1[1] & 0x80)
    ln = b0b1[1] & 0x7F
    if ln == 126:
        ln = struct.unpack("!H", await reader.readexactly(2))[0]
    elif ln == 127:
        ln = struct.unpack("!Q", await reader.readexactly(8))[0]
    mkey = await reader.readexactly(4) if masked else None
    raw_payload = await reader.readexactly(ln)
    payload = (
        bytes(b ^ mkey[i & 3] for i, b in enumerate(raw_payload))
        if masked else raw_payload
    )
    return opcode, fin, payload


def frame(opcode, payload=b"", fin=True, rsv=0, mask=False):
    if isinstance(payload, str):
        payload = payload.encode()
    n = len(payload)
    b0 = (0x80 if fin else 0) | (rsv & 0x70) | (opcode & 0x0F)
    hdr = bytearray([b0])
    mbit = 0x80 if mask else 0
    if n < 126:
        hdr.append(mbit | n)
    elif n < 65536:
        hdr.append(mbit | 126)
        hdr += struct.pack("!H", n)
    else:
        hdr.append(mbit | 127)
        hdr += struct.pack("!Q", n)
    if mask:
        mkey = os.urandom(4)
        hdr += mkey
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mkey[i & 3]
        return bytes(hdr) + bytes(masked)
    return bytes(hdr) + bytes(payload)


async def do_handshake(reader, writer):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(4096)
        if not chunk:
            raise EOFError("client hung up during handshake")
        data += chunk
    key = None
    for line in data.decode(errors="replace").split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    resp = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n" % accept
    )
    writer.write(resp.encode())
    await writer.drain()


async def serve_once(port, on_connected):
    """Run a one-shot server on `port`: accept one connection, do the
    handshake, call `on_connected(reader, writer)`, then stop listening."""
    done = asyncio.Event()

    async def handle(reader, writer):
        try:
            await do_handshake(reader, writer)
            await on_connected(reader, writer)
        finally:
            try:
                writer.close()
            except Exception:
                pass
            done.set()

    server = await asyncio.start_server(handle, "127.0.0.1", port)
    async with server:
        await asyncio.wait_for(done.wait(), timeout=10)


_DRIVER = """
import sys
sys.path.insert(0, {lib_dir!r})
import asyncio
import mpyws

async def main():
    ws = await mpyws.connect("ws://127.0.0.1:{port}/")
    {body}

asyncio.run(main())
"""


def run_driver(port, body):
    """Write the driver script, run it against the running server, and
    return (stdout, stderr, returncode)."""
    src = _DRIVER.format(lib_dir=LIB_DIR, port=port, body=body)
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(src)
        path = f.name
    try:
        proc = subprocess.run([MPY_BIN, path], capture_output=True, text=True, timeout=15)
        return proc.stdout, proc.stderr, proc.returncode
    finally:
        os.unlink(path)


async def scenario_fragmentation(port):
    async def on_connected(reader, writer):
        # TEXT fragment 1 (fin=0) ...
        writer.write(frame(OP_TEXT, "Hello, ", fin=False))
        await writer.drain()
        # ... a PING interleaved mid-fragment ...
        writer.write(frame(OP_PING, "still-there", fin=True))
        await writer.drain()
        # client must PONG it before the CONT frame is readable to it.
        opcode, _fin, pong_payload = await read_client_frame(reader)
        assert opcode == OP_PONG, "expected PONG opcode, got 0x%x" % opcode
        assert pong_payload == b"still-there", pong_payload
        # ... then the terminating CONT fragment (fin=1).
        writer.write(frame(OP_CONT, "World!", fin=True))
        await writer.drain()

    body = (
        'msg = await ws.recv()\n'
        '    print("RESULT fragmentation:", repr(msg))\n'
        '    assert msg == "Hello, World!", msg\n'
        '    print("PASS fragmentation")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_rsv_bit(port):
    async def on_connected(reader, writer):
        writer.write(frame(OP_TEXT, "x", rsv=0x40))
        await writer.drain()

    body = (
        'try:\n'
        '        await ws.recv()\n'
        '        print("RESULT rsv_bit: no exception (FAIL)")\n'
        '    except mpyws.WSProtocolError as e:\n'
        '        print("RESULT rsv_bit: WSProtocolError code=%d %r" % (e.code, e.reason))\n'
        '        assert e.code == 1002\n'
        '        print("PASS rsv_bit")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_bad_opcode(port):
    async def on_connected(reader, writer):
        writer.write(frame(0x3, "x"))  # 0x3 is a reserved/undefined opcode
        await writer.drain()

    body = (
        'try:\n'
        '        await ws.recv()\n'
        '        print("RESULT bad_opcode: no exception (FAIL)")\n'
        '    except mpyws.WSProtocolError as e:\n'
        '        print("RESULT bad_opcode: WSProtocolError code=%d %r" % (e.code, e.reason))\n'
        '        print("PASS bad_opcode")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_oversized_control(port):
    async def on_connected(reader, writer):
        writer.write(frame(OP_PING, "x" * 200))  # control payload must be <=125
        await writer.drain()

    body = (
        'try:\n'
        '        await ws.recv()\n'
        '        print("RESULT oversized_control: no exception (FAIL)")\n'
        '    except mpyws.WSProtocolError as e:\n'
        '        print("RESULT oversized_control: WSProtocolError code=%d %r" % (e.code, e.reason))\n'
        '        print("PASS oversized_control")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_masked_server_frame(port):
    async def on_connected(reader, writer):
        writer.write(frame(OP_TEXT, "x", mask=True))  # servers MUST NOT mask
        await writer.drain()

    body = (
        'try:\n'
        '        await ws.recv()\n'
        '        print("RESULT masked_server_frame: no exception (FAIL)")\n'
        '    except mpyws.WSProtocolError as e:\n'
        '        print("RESULT masked_server_frame: WSProtocolError code=%d %r" % (e.code, e.reason))\n'
        '        print("PASS masked_server_frame")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_orphan_continuation(port):
    async def on_connected(reader, writer):
        writer.write(frame(OP_CONT, "orphan", fin=True))  # no message in progress
        await writer.drain()

    body = (
        'try:\n'
        '        await ws.recv()\n'
        '        print("RESULT orphan_continuation: no exception (FAIL)")\n'
        '    except mpyws.WSProtocolError as e:\n'
        '        print("RESULT orphan_continuation: WSProtocolError code=%d %r" % (e.code, e.reason))\n'
        '        print("PASS orphan_continuation")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_invalid_close_code(port):
    async def on_connected(reader, writer):
        # 1006 is reserved for local use to report "no Close frame at all"
        # and RFC6455 7.4.1 forbids it from ever appearing on the wire.
        writer.write(frame(OP_CLOSE, struct.pack("!H", 1006) + b"reserved"))
        await writer.drain()
        # The client must fail the connection with 1002, never echo 1006.
        opcode, _fin, payload = await read_client_frame(reader)
        assert opcode == OP_CLOSE, "expected CLOSE echo, got opcode 0x%x" % opcode
        code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
        assert code == 1002, "client must close with 1002, sent %r" % (code,)

    body = (
        'try:\n'
        '        await ws.recv()\n'
        '        print("RESULT invalid_close_code: no exception (FAIL)")\n'
        '    except mpyws.WSProtocolError as e:\n'
        '        print("RESULT invalid_close_code: WSProtocolError code=%d %r" % (e.code, e.reason))\n'
        '        assert e.code == 1002\n'
        '        print("PASS invalid_close_code")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_abrupt_rst(port):
    async def on_connected(reader, writer):
        writer.write(frame(OP_TEXT, "frame 1 complete"))
        await writer.drain()
        # Give the client a beat to actually consume frame 1 off the
        # socket before the RST arrives -- on localhost, sending the RST
        # immediately after `drain()` (which only confirms local kernel
        # buffering, not that the peer's application has read anything)
        # races the peer's own read and can make the kernel discard frame
        # 1's still-unread bytes as part of the reset, which would prove
        # nothing about mid-frame abort handling specifically.
        await asyncio.sleep(0.1)
        # one byte of a second frame's header, then hard RST (no Close frame)
        import socket
        sock = writer.get_extra_info("socket")
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        writer.write(bytes([0x82]))
        await writer.drain()

    body = (
        'msg1 = await ws.recv()\n'
        '    print("RESULT abrupt_rst frame1:", repr(msg1))\n'
        '    assert msg1 == "frame 1 complete"\n'
        '    try:\n'
        '        await ws.recv()\n'
        '        print("RESULT abrupt_rst: no exception (FAIL)")\n'
        '    except mpyws.WSConnectionAborted as e:\n'
        '        print("RESULT abrupt_rst: WSConnectionAborted %r" % (e,))\n'
        '        print("PASS abrupt_rst")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_oversized_outgoing_close(port):
    """A `close()` reason long enough to blow the 125-byte control-frame
    limit on its own must come out truncated -- an oversized *outgoing*
    CLOSE would itself be an RFC6455 5.5 violation."""
    async def on_connected(reader, writer):
        opcode, _fin, payload = await read_client_frame(reader)
        assert opcode == OP_CLOSE, "expected CLOSE, got opcode 0x%x" % opcode
        assert len(payload) <= 125, (
            "emitted CLOSE payload %d bytes exceeds the 125-byte limit"
            % len(payload))

    body = (
        'long_reason = "r" * 300\n'
        '    await ws.close(1000, long_reason)\n'
        '    print("RESULT oversized_outgoing_close: sent close with a 300-char reason")\n'
        '    print("PASS oversized_outgoing_close")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def scenario_ping_flood(port):
    """A flood of PINGs must all be answered with PONGs, and a data frame
    sent afterwards must still be delivered -- the transparent PING/PONG
    handling in `recv()`'s loop must not starve or drop the eventual
    application message."""
    n_pings = 20

    async def on_connected(reader, writer):
        for i in range(n_pings):
            payload = ("poke-%d" % i).encode()
            writer.write(frame(OP_PING, payload, fin=True))
            await writer.drain()
            opcode, _fin, pong_payload = await read_client_frame(reader)
            assert opcode == OP_PONG, (
                "expected PONG for ping %d, got opcode 0x%x" % (i, opcode))
            assert pong_payload == payload, (i, pong_payload)
        writer.write(frame(OP_TEXT, "after-flood"))
        await writer.drain()

    body = (
        'msg = await ws.recv()\n'
        '    print("RESULT ping_flood:", repr(msg))\n'
        '    assert msg == "after-flood", msg\n'
        '    print("PASS ping_flood")\n'
    )
    return await _run_scenario(port, on_connected, body)


async def do_handshake_missing_upgrade(reader, writer):
    """Respond 101 + a correct `Sec-WebSocket-Accept`, but omit the
    `Upgrade`/`Connection` headers RFC6455 4.1 also requires."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(4096)
        if not chunk:
            raise EOFError("client hung up during handshake")
        data += chunk
    key = None
    for line in data.decode(errors="replace").split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    resp = "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: %s\r\n\r\n" % accept
    writer.write(resp.encode())
    await writer.drain()


async def do_handshake_slow_drip(reader, writer):
    """Read the request, then dribble one line of the 101 response before
    stalling well past any reasonable `handshake_timeout` -- the rest of
    the response (the blank line that terminates the header block) never
    arrives."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(4096)
        if not chunk:
            raise EOFError("client hung up during handshake")
        data += chunk
    writer.write(b"HTTP/1.1 101 Switching Protocols\r\n")
    await writer.drain()
    await asyncio.sleep(5)


_DRIVER_HANDSHAKE_ERROR = """
import sys
sys.path.insert(0, {lib_dir!r})
import asyncio
import mpyws

async def main():
    try:
        ws = await mpyws.connect("ws://127.0.0.1:{port}/"{connect_kwargs})
        print("RESULT {label}: no exception (FAIL)")
    except mpyws.WSHandshakeError as e:
        print("RESULT {label}: %s %r" % (type(e).__name__, e))
        assert type(e).__name__ == {expect_type!r}, type(e).__name__
        print("PASS {label}")

asyncio.run(main())
"""


def run_driver_handshake_error(port, label, connect_kwargs="", expect_type="WSHandshakeError"):
    """Like `run_driver`, but for scenarios where `mpyws.connect()` itself
    is expected to raise a `WSHandshakeError` (or a named subclass) before
    a `WSClient` ever exists."""
    src = _DRIVER_HANDSHAKE_ERROR.format(
        lib_dir=LIB_DIR, port=port, label=label,
        connect_kwargs=connect_kwargs, expect_type=expect_type)
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(src)
        path = f.name
    try:
        proc = subprocess.run([MPY_BIN, path], capture_output=True, text=True, timeout=15)
        return proc.stdout, proc.stderr, proc.returncode
    finally:
        os.unlink(path)


async def serve_once_custom(port, handshake_and_body):
    """Like `serve_once`, but the callback owns the entire connection
    including the handshake itself -- for scenarios that must send a
    non-standard or deliberately-stalled handshake response rather than
    the well-formed `do_handshake` every other scenario builds on."""
    done = asyncio.Event()

    async def handle(reader, writer):
        try:
            await handshake_and_body(reader, writer)
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass
            done.set()

    server = await asyncio.start_server(handle, "127.0.0.1", port)
    async with server:
        await asyncio.wait_for(done.wait(), timeout=15)


async def scenario_missing_upgrade_header(port):
    return await _drive_scenario(
        serve_once_custom(port, do_handshake_missing_upgrade),
        lambda: run_driver_handshake_error(port, "missing_upgrade_header"),
    )


async def scenario_slow_drip_handshake_timeout(port):
    return await _drive_scenario(
        serve_once_custom(port, do_handshake_slow_drip),
        lambda: run_driver_handshake_error(
            port, "slow_drip_handshake_timeout",
            connect_kwargs=", handshake_timeout=0.3",
            expect_type="WSHandshakeTimeout",
        ),
    )


async def _drive_scenario(server_coro, driver_call):
    """Run `server_coro` as a background task, run `driver_call` (a
    zero-arg callable returning `(stdout, stderr, returncode)`) in a
    thread, print the driver's captured output, and report pass/fail."""
    server_task = asyncio.create_task(server_coro)
    await asyncio.sleep(0.05)  # let the server start listening
    loop = asyncio.get_event_loop()
    stdout, stderr, rc = await loop.run_in_executor(None, driver_call)
    await server_task
    print(stdout.strip())
    if stderr.strip():
        print("--- stderr ---")
        print(stderr.strip())
    return rc == 0 and "PASS" in stdout


async def _run_scenario(port, on_connected, body):
    return await _drive_scenario(
        serve_once(port, on_connected),
        lambda: run_driver(port, body),
    )


async def main():
    scenarios = [
        ("fragmentation + interleaved control frame", scenario_fragmentation, 8801),
        ("RSV bit set -> protocol error", scenario_rsv_bit, 8802),
        ("invalid opcode -> protocol error", scenario_bad_opcode, 8803),
        ("oversized control frame -> protocol error", scenario_oversized_control, 8804),
        ("masked server frame -> protocol error", scenario_masked_server_frame, 8806),
        ("orphan continuation frame -> protocol error", scenario_orphan_continuation, 8807),
        ("invalid close code -> protocol error", scenario_invalid_close_code, 8808),
        ("abrupt RST mid-frame -> WSConnectionAborted", scenario_abrupt_rst, 8805),
        ("oversized outgoing close reason -> truncated to 125 bytes",
         scenario_oversized_outgoing_close, 8809),
        ("ping flood -> all answered, data frame still delivered",
         scenario_ping_flood, 8810),
        ("handshake missing Upgrade/Connection -> WSHandshakeError",
         scenario_missing_upgrade_header, 8811),
        ("slow-drip handshake with handshake_timeout -> WSHandshakeTimeout",
         scenario_slow_drip_handshake_timeout, 8812),
    ]
    results = []
    for name, fn, port in scenarios:
        print("=== %s ===" % name)
        ok = await fn(port)
        results.append((name, ok))
        print()

    print("=== SUMMARY ===")
    all_ok = True
    for name, ok in results:
        print("%-55s %s" % (name, "PASS" if ok else "FAIL"))
        all_ok = all_ok and ok
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
