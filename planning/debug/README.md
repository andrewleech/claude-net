# Idle-CPU / reconnect-loop investigation — RESOLVED (2026-07-25, carbon)

Root-caused on carbon (native Linux, strace/ptrace work; WSL blocks them and,
critically, mis-measured CPU for tight poll loops — see below).

## Root cause (confirmed at source level)

An idle asyncio event loop with an open `wss://` (TLS) connection burned
~2.4% of a core doing nothing, issuing a poll syscall ~1500x/s.

`extmod/modtls_mbedtls.c`'s SSLSocket ioctl does not answer
`MP_STREAM_GET_FILENO` (the raw socket does, `ports/unix/modsocket.c`). So
`extmod/modselect.c` classifies the TLS socket as a *non-fd* object. With
`MICROPY_PY_SELECT_POSIX_OPTIMISATIONS` (on for the unix port), one non-fd
object drops the whole poll set to the periodic `ioctl(MP_STREAM_POLL)` path,
whose period `MICROPY_PY_SELECT_IOCTL_CALL_PERIOD_MS` was a hard-coded **1ms**.
Idle asyncio+TLS therefore spins at ~1kHz. Generic MicroPython unix-port issue,
not claude-net specific.

## Fix (shipped)

- micropython integration branch `pr/unix-select-ioctl-period-configurable`:
  `#ifndef` guard so the period is overridable (default stays 1).
- picolet `mcp/unix` variant sets it to **50ms**.
- Idle CPU: **2.45% -> 0.07%** (~25x). Keepalive + inbound delivery intact
  (the periodic path still runs the SSL poll ioctl every period, so
  `mbedtls_ssl_check_pending` is unaffected).

## Measurements (carbon, linux-x64, 8 cores)

| config                                  | idle CPU | health           |
|-----------------------------------------|---------:|------------------|
| full plugin, period=1 (baseline)        |   2.43%  | 45k polls/30s    |
| full plugin, period=50 (fix)            |   0.07%  | no reconnect 45s |
| bare mpyws client, period=1             |   2.45%  | healthy 40s      |
| same binary, HUB DISABLED (no TLS sock) |   0.00%  | -                |

## Corrections to the earlier (WSL) diagnosis

- **"bare client is healthy at 0.2%, only the full stack loops"** — WRONG.
  WSL's /proc CPU accounting mis-measured the tight poll loop. On carbon the
  bare client burns the *same* 2.45% as the full plugin. The bug is purely
  SSL-in-poll-set; the stdin shim / mpyfastmcp / rename-watch are irrelevant.
- **"~31s reconnect loop"** — does NOT reproduce on native Linux (period=1 or
  50, bare or full: every run survives 40s idle, `idle_ms` resets ~every 2s
  from hub pings). Almost certainly WSL scheduler/timer contention from 15
  procs each spinning at ~1kHz. The period=50 fix removes that pressure.

## Repros

- `repro_idle_cpu.py` — drive the packaged plugin like Claude Code (MCP
  handshake then idle), sample /proc CPU + RSS, timestamp stderr, detect
  reconnect cadence. Env: PLUGIN_BIN, CLAUDE_NET_HUB, DURATION, REPRO_CWD,
  STRACE_OUT (histogram), STRACE_TIMELINE (per-call).
- `trace_idle.sh {syscalls|timeline|perf} [secs]` — strace/perf a fifo-driven
  idle plugin (SIGINT so strace flushes its -c summary).
- `channel_delivery_test.py` — launch the plugin, hold it registered, log
  inbound `notifications/claude/channel` with length+tail so a stalled/
  truncated large message would show. Used to prove idle-socket delivery.
- `realhub_idle_probe.py` — bare mpyws -> real hub, no MCP/stdin. Isolates the
  SSL-socket-only case. Run: `<mcp-runtime> realhub_idle_probe.py`.
- `build_mcp_integration.sh` — native mcp-variant build from integration.
- `concurrent_idle.py`, `idle_ping_{server,client}.py`, `stdin_repro*.py` —
  earlier isolation repros (kept).

## Follow-up (not done)

Deeper fix for near-zero CPU *and* sub-ms latency: forward `GET_FILENO` in
modtls so the TLS socket is kernel-pollable. Requires also keeping the SSL
`MP_STREAM_POLL` ioctl in the probe set (or a buffered-data flag), else
`mbedtls`-buffered data with no fresh socket activity stalls. Deferred.
