"""mpyjsonrpc: a reusable async newline-delimited JSON-RPC 2.0 peer over stdio.

Serves requests via a method dispatcher, emits server-to-client
notifications, correlates outbound client-to-server requests, and exposes a
stderr logging helper plus an EOF-to-shutdown hook.

# Phase P4 — not yet implemented
"""
