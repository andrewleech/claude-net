"""RFC6455 frame encode/decode primitives.

Pure functions with no `asyncio`/socket dependency, so the encode side is
exercisable with plain `struct`/`os`/`binascii` (no MicroPython-only
imports here) against hand-computed wire-byte vectors. The async read loop
in `_client.py` is the only caller of the decode-side helpers; it supplies
the bytes incrementally (a WebSocket stream can't be decoded from an
in-memory buffer alone without knowing how many bytes to read next).
"""

import os
import struct

from ._errors import WSProtocolError

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BIN = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

_VALID_OPCODES = (OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG)
_CONTROL_OPCODES = (OP_CLOSE, OP_PING, OP_PONG)

_RSV_MASK = 0x70
_MAX_CONTROL_PAYLOAD = 125
_MAX_UINT63 = 1 << 63


def xor_mask(payload, mkey):
    """Return `payload` XORed against the repeating 4-byte `mkey`."""
    out = bytearray(payload)
    for i in range(len(out)):
        out[i] ^= mkey[i & 3]
    return bytes(out)


def encode_frame(opcode, payload=b"", fin=True, mask=True, mask_key=None):
    """Build one complete RFC6455 frame as `bytes`.

    Client frames MUST be masked (`mask=True`, the default); `mask_key`
    lets callers (tests) pin the 4-byte mask instead of drawing it from
    `os.urandom`, so the resulting wire bytes are reproducible.
    """
    n = len(payload)
    hdr = bytearray()
    hdr.append((0x80 if fin else 0x00) | (opcode & 0x0F))
    mask_bit = 0x80 if mask else 0x00
    if n < 126:
        hdr.append(mask_bit | n)
    elif n < 65536:
        hdr.append(mask_bit | 126)
        hdr += struct.pack("!H", n)
    else:
        hdr.append(mask_bit | 127)
        hdr += struct.pack("!Q", n)
    if not mask:
        return bytes(hdr) + bytes(payload)
    mkey = mask_key if mask_key is not None else os.urandom(4)
    return bytes(hdr) + bytes(mkey) + xor_mask(payload, mkey)


def parse_basic_header(b0, b1):
    """Decompose the mandatory first two header bytes.

    Returns `(fin, rsv, opcode, masked, len7)`; `len7` is the raw 7-bit
    length field, still to be replaced by an extended length read by the
    caller when it is 126 or 127.
    """
    fin = bool(b0 & 0x80)
    rsv = b0 & _RSV_MASK
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    len7 = b1 & 0x7F
    return fin, rsv, opcode, masked, len7


def validate_header(fin, rsv, opcode, masked):
    """Raise `WSProtocolError` for any RFC6455 framing violation visible
    from the header alone, before the payload length has been resolved.

    Checked here: reserved (RSV) bits must be zero (no extension is
    negotiated), the opcode must be one of the six defined values, a
    server frame must never be masked (RFC6455 section 5.1: "a client
    MUST close the connection upon receiving a masked frame"), and a
    control frame must be unfragmented.
    """
    if rsv:
        raise WSProtocolError("reserved bits set: 0x%02x" % rsv)
    if opcode not in _VALID_OPCODES:
        raise WSProtocolError("invalid opcode: 0x%x" % opcode)
    if masked:
        raise WSProtocolError("server frame was masked")
    if opcode in _CONTROL_OPCODES and not fin:
        raise WSProtocolError("fragmented control frame (opcode 0x%x)" % opcode)


def validate_length(opcode, length, max_message_bytes):
    """Raise `WSProtocolError` once the full payload length is known."""
    if length >= _MAX_UINT63:
        raise WSProtocolError("length high bit set (invalid 64-bit length)")
    if opcode in _CONTROL_OPCODES and length > _MAX_CONTROL_PAYLOAD:
        raise WSProtocolError(
            "control frame payload too large: %d bytes" % length)
    if max_message_bytes is not None and length > max_message_bytes:
        raise WSProtocolError(
            "frame length %d exceeds max_message_bytes=%d"
            % (length, max_message_bytes), code=1009)
