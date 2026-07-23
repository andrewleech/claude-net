"""mpyws: a reusable async RFC6455 WebSocket client for MicroPython asyncio.

Provides handshake, client-side masking, 7/16/64-bit frame lengths,
fragmentation reassembly, transparent control PING/PONG handling, and a
clean close handshake, for text and binary frames over plain TCP or TLS.

# Phase P3 — not yet implemented
"""
