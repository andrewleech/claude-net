# Spike results: claude-net plugin on picolet MicroPython

Date: 2026-07-23
Anchors: claude-net `main` @ `4f564a56b9`, picolet `dev` @ `2fe3ef5d14`

This file collects the findings from the 4-agent de-risking spike that
precedes `planning/ROADMAP.md`. It is the source for that roadmap's "Current
state (verified facts...)" section; each fact below was re-checked against
source or the live binary on 2026-07-23 unless marked "spike-only" (measured
during the spike and not independently re-verified for this write-up).

## Bun plugin facts (`/home/corona/claude-net/src/plugin/plugin.ts`, 1607 lines)

- MCP stdio peer over newline-delimited JSON-RPC 2.0; handles `initialize`
  (+ `oninitialized` reading the client's `experimental["claude/channel"]`
  capability), `tools/list`, `tools/call`, `prompts/list`, `prompts/get`.
  Emits a non-standard `notifications/claude/channel` with `{content,
  meta:{from, type, cn_message_id, cn_reply_to?, team?}}`
  (plugin.ts:501–518).
- 11 tools + 1 prompt (`rename`), hand-written JSON-schema literals
  (plugin.ts:562–743).
- Hub WS frames: `{action, requestId, ...}` outbound, `{event: response|
  message|registered|error}` inbound. Actions: register, send, send_team,
  join_team, leave_team, list_agents, list_teams, query_events, ping,
  update_channel_capable (plugin.ts:875–934, 1170–1211).
- Ceremony details (the parity checklist for Phase 7): register gated on
  both MCP-initialize-complete and WS-open (`maybeSendRegister`,
  plugin.ts:1297); name-collision retry matches `/already registered/i` in
  the hub error string (plugin.ts:1263); a one-shot nudge queue drains extra
  content blocks into the next tool result — `upgrade_hint` from the
  register response, and a guarded rename-suggestion nudge after a
  suffixed auto-register (plugin.ts:790–954, 1229–1240);
  `CLAUDE_NET_CHANNELS_PATCHED=1` short-circuits the `_ack_channel`
  self-test entirely (plugin.ts:1445–1454); the self-test itself is a 2 s
  delay after register, 60 s ack window, idempotent, re-fired on manual
  register while still false (plugin.ts:1096–1123, 1054–1056); watchdog
  31 s resets on any hub traffic including a WS control PING
  (plugin.ts:1330), with reconnect backoff 1 s → 30 s doubling, reset on
  open; state file at `/tmp/claude-net/state-<ppid>.json`, register frame
  carries `cc_pid: process.ppid` and `cwd` (the plugin is exec-replaced
  from bash, so ppid IS the Claude Code pid); per-request 10 s timeout,
  requestId = UUIDv4; stdin EOF triggers shutdown only when a hub URL is
  configured, and shutdown deletes the state file, closes the WS, rejects
  pending requests, and exits 0.

## Hub-side facts (claude-net `src/hub/`)

- Serves plugin source at `GET /plugin.ts` (index.ts:211); `GET /setup`
  generates the install script that registers the MCP server as "download
  plugin.ts to tmp, exec `bun run`" (setup.ts:129).
- `PLUGIN_VERSION_CURRENT` = hub package.json version; a mismatch at
  register produces an `upgrade_hint` in the register response
  (ws-plugin.ts:203–221, version.ts).
- `bin-server.ts` serves a whitelisted file set at `GET /bin/:name` — the
  natural place to add the compiled MicroPython plugin binary
  (bin-server.ts:144).
- Name regex `session:user@host` (registry.ts:380, `isValidAgentName`);
  `hub@claude-net` / `system@claude-net` are reserved.
- Wire-protocol details confirmed live against the running hub during the
  spike: register replies as two frames, control PING is echoed back as a
  PONG response frame, client frames must be masked, the hub sends control
  PING roughly every 5 s and evicts after roughly 30 s of silence, and there
  is no subprotocol negotiation or auth handshake.

## MicroPython/picolet capability findings

Verified against the prebuilt `packages/picolet-runtime/build/
picolet-runtime-linux-x64-cli` (662 KB) unless noted.

- Available: `asyncio`, non-blocking sockets with getaddrinfo-style
  addressing, `select.poll` (not `select.select`), `json`, `struct`,
  `binascii`, `time.ticks_ms`, `os.stat` `st_mtime`, `os.getcwd`/
  `listdir`/`getenv`, and `ffi` (unix port, built `-rdynamic`).
- **Async stdin**: `asyncio.StreamReader(sys.stdin.buffer)` +
  `await readline()` works; `b''` signals EOF; integrates with the poll
  loop with zero idle CPU (spike-only).
- **RFC6455 client**: a hand-rolled client works; the combined stdin+WS
  loop measured RSS 2.76 MB (spike-only).
- **TLS**: a variant built with `MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1`
  measured 878 KB; a real `wss://` register+ping against the live hub
  succeeded. The module name is `tls`, not `ssl`. PEM parsing is off, so
  the bundled CA must be DER. SNI is mandatory. RSS with a live TLS
  connection measured 3.2 MB (spike-only).
- **Not available**: `os.getpid`/`getppid`/`uname`/`environ`, `hashlib`
  (in the `cli` build), the `ssl` name. Workarounds verified live on
  2026-07-23: `ffi.open(None)` → `getppid()` and `gethostname()` both work
  from the prebuilt cli binary; `os.urandom(16)` works as a UUIDv4 source;
  `time.time_ns()` works for millisecond-epoch timestamps.
- **Annotations are not retained at runtime**: `f.__annotations__` raises
  `AttributeError` on the prebuilt binary. MicroPython also exposes no
  parameter names or defaults on function objects and has no `inspect`
  module. The original plan of deriving schemas from decorated-function
  signatures/type-hints is not implementable by runtime introspection —
  this is why Q5 requires explicit param specs as the ground truth, with
  build-time CPython codegen from real type hints as an additive layer.

## picolet variant mechanics (for the new `mcp` variant)

- A variant is `variants/<variant>/unix/mpconfigvariant.{h,mk}` plus a
  manifest `manifests/manifest_<variant>.py` plus two case-arms in
  `scripts/build-runtime.sh` (target/variant dispatch around line 94;
  size-gate ceiling table around line 331).
- The `cli` variant's `.mk` force-disables SSL
  (`variants/cli/unix/mpconfigvariant.mk:13–15`); the spike overrode this
  on the make command line to get the ad-hoc TLS build. The `mcp` variant
  makes that override a proper, permanent config.
- Dependency policy: new native dependencies get declared in
  `packages/picolet-runtime/sbom/runtime.toml` (an mbedtls entry is
  needed).
- Single-binary output is non-negotiable (picolet `CLAUDE.md`); production
  packaging appends the app romfs to the binary.

## Memory-target arithmetic

24 sessions × ~90 MB (bun) ≈ 2.6 GB today; 24 × ~3.2 MB (picolet, TLS live)
≈ 77 MB after. Single thread per session vs roughly 8 threads/session today.

## Spike artifacts (`planning/spike/`)

| File | Demonstrates |
|------|---------------|
| `cap.py` | Import/capability probe against the prebuilt cli binary: which stdlib modules and os.* calls succeed or fail (source for the "Available"/"Not available" lists above). |
| `stdin_test.py` | `asyncio.StreamReader(sys.stdin.buffer)` readline loop alongside a concurrent ticker task, proving async stdin doesn't block the event loop. |
| `idle_test.py` | Confirms the stdin reader idles (times out cleanly) rather than busy-looping when nothing is written to stdin. |
| `ws.py` | Hand-rolled RFC6455 client (`WSClient`) over `asyncio` streams: handshake, masking, framing — no `ssl`/`hashlib` dependency. Basis for `mpyws` (P3). |
| `ws_driver.py` | Drives `ws.py`'s `WSClient` against `mock_hub.py`: register + ping round trip over plain `ws://`. |
| `mock_hub.py` | CPython (`websockets`) mock of the claude-net hub's register/ping wire shapes, used as the spike's non-live test server. |
| `combined.py` | Stdin JSON-RPC reader + WS client sharing one asyncio loop (the plugin's actual shape) with RSS reported from `/proc/self/status`; measured 2.76 MB RSS. |
| `mp_rss.py` | Connects, registers, and holds a live `wss://` connection against the real hub, reading its own RSS from `/proc` while idle. |
| `mp_wss.py` | The TLS-capable client: TCP → mbedtls `tls.wrap_socket` (SNI) → RFC6455 upgrade → masked register/ping frames, against the real hub, with CERT_NONE and CERT_REQUIRED modes selectable by argv. Basis for the P1 async-TLS work. |
| `build_tls.sh` | Builds the ad-hoc `picolet-mcp-tls` spike binary (`cli` baseline + `MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1` on the make command line) used for all TLS spike measurements. |
| `isrg_root_x1.der` | The DER-encoded ISRG Root X1 CA certificate used for CERT_REQUIRED verification against the hub's Let's-Encrypt-via-`tailscale cert` certificate (Q2). |
| `isrg_root_x1.pem` | PEM form of the same CA, kept for reference/regeneration; not usable directly by the runtime (PEM parsing is off in the TLS build). |
| `spike.py` | CPython reference client (`websocket-client`) that registers and pings the real hub, used to cross-check the MicroPython client's wire behaviour against a known-good implementation. |
