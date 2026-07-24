# Offline diagnostics for the mpy plugin

Repros used to investigate the ~31s hub-WS reconnect loop + residual idle CPU
(2026-07-24). Run on a native Linux host where strace/ptrace work (WSL blocks
ptrace, so these could only be measured indirectly there).

- `realhub_idle_probe.py` — bare mpyws → real hub, idle. HEALTHY baseline
  (idle_ms <5s, 0.2% CPU). Proves mpyws↔hub keepalive works alone.
- `concurrent_idle.py` — mpyws hub + a JsonRpcPeer(StdinLineShim) idle stdin.
  Also measured healthy in isolation — yet the FULL plugin loops. The gap
  between this and plugin.py is what to root-cause.
- `idle_ping_server.py` / `idle_ping_client.py` — controlled ws/wss server
  sending only periodic PINGs; client tracks last_recv_ms.
- `stdin_repro.py` / `stdin_repro_driver.py` — the original read(n) 2nd-wait
  defect repro (runtime-fixed via extmod/vfs_posix_file read1).
- `build_mcp_integration.sh` — native mcp-variant build from the integration
  branch.

OPEN BUG: the full plugin.py (fixed binary) does NOT process the hub's 5s
keepalive pings when running the whole stack (_hub + mpyfastmcp + stdin shim),
so the 31s watchdog fires -> reconnect loop, and it idles at ~3.5% CPU. A bare
mpyws client does. Root-cause on carbon with strace: run plugin.py idle, trace
which fd/syscall the loop services vs the hub socket.
