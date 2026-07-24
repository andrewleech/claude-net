# Roadmap: claude-net plugin on the picolet MicroPython runtime

Date: 2026-07-23
Anchors: claude-net `main` @ `4f564a56b9`, picolet `dev` @ `2fe3ef5d14`
Status: planning complete (4-agent de-risking spike done); this document is the
execution plan. It is updated in place as phases complete, never forked.

## Goal

Replace the bun/TypeScript claude-net MCP plugin
(`/home/corona/claude-net/src/plugin/plugin.ts`, spawned per Claude Code session,
~90 MB RSS / ~8 threads each) with a functionally-equivalent plugin running on
a picolet MicroPython binary (~3 MB RSS, single-threaded, <1 MB on disk).
Deliverables:

1. A git worktree of claude-net for the work.
2. The alternate plugin, feature-parity with plugin.ts.
3. A reusable minimal library stack underneath it, headlined by `mpyfastmcp`
   (FastMCP-style decorator layer), built properly for reuse beyond this
   plugin.

Layering (decided with Andrew — pragmatic reusable stack, NOT a FastAPI/ASGI
port):

```
claude-net plugin (app)
└── mpyfastmcp            @tool/@prompt decorators, FastAPI-flavoured ergonomics
    ├── JSON-RPC 2.0 stdio peer lib   (async readline loop, correlation, notifications)
    └── schema layer                  (param spec → JSON Schema; see Q5)
plus, used by the plugin directly:
    └── async WebSocket client lib    (RFC6455 over TLS or plain)
```

A reusable HTTP/ASGI micro-framework is explicitly out of scope.

## Current state (verified facts the plan rests on)

Each fact re-checked against source or the live binary on 2026-07-23 unless
marked "spike" (spike results were independently confirmed during the spike).

**The bun plugin** (`/home/corona/claude-net/src/plugin/plugin.ts`, 1607 lines):

- MCP stdio peer: newline-delimited JSON-RPC 2.0; handles initialize (+
  `oninitialized` reads client `experimental["claude/channel"]` capability),
  tools/list, tools/call, prompts/list, prompts/get. Emits non-standard
  `notifications/claude/channel` with `{content, meta:{from, type,
  cn_message_id, cn_reply_to?, team?}}` (plugin.ts:501–518).
- 11 tools + 1 prompt (`rename`), hand-written JSON-schema literals
  (plugin.ts:562–743).
- Hub WS frames `{action, requestId, ...}` / `{event: response|message|
  registered|error}`. Actions: register, send, send_team, join_team,
  leave_team, list_agents, list_teams, query_events, ping,
  update_channel_capable (plugin.ts:875–934, 1170–1211).
- Host ceremonies — the parity checklist, enumerated in Phase 7. Notable
  details beyond the obvious list:
  - Register is gated on BOTH MCP initialize completed AND WS open
    (`maybeSendRegister`, plugin.ts:1297).
  - Name-collision retry detects collision by matching `/already registered/i`
    in the hub error string (plugin.ts:1263).
  - A one-shot "nudge queue" drains extra text blocks into the next tool
    result: `upgrade_hint` from the register response, and a guarded "Rename
    suggestion" nudge when a suffix was used (plugin.ts:790–954, 1229–1240).
  - `CLAUDE_NET_CHANNELS_PATCHED=1` env short-circuits the `_ack_channel`
    ceremony entirely (plugin.ts:1445–1454).
  - Self-test: 2 s delay after register, 60 s ack window, idempotent
    `_ack_channel`, re-fired on manual register while still false
    (plugin.ts:1096–1123, 1054–1056).
  - Watchdog 31 s resets on any hub traffic including WS control PING
    (plugin.ts:1330); reconnect backoff 1 s → 30 s doubling, reset on open.
  - State file `/tmp/claude-net/state-<ppid>.json`; register frame carries
    `cc_pid: process.ppid` and `cwd` (the plugin is exec-replaced from bash so
    ppid IS the Claude Code pid).
  - Per-request 10 s timeout; requestId = UUIDv4.
  - stdin EOF → shutdown only when a hub URL is configured; shutdown deletes
    the state file, closes WS, rejects pendings, exit 0.

**The hub side** (claude-net `src/hub/`):

- Serves plugin source at `GET /plugin.ts` (index.ts:211); `GET /setup`
  generates the install script which registers the MCP server as
  "download plugin.ts to tmp, exec `bun run`" (setup.ts:129).
- `PLUGIN_VERSION_CURRENT` = hub package.json version; mismatch at register →
  `upgrade_hint` in the register response (ws-plugin.ts:203–221, version.ts).
- `bin-server.ts` serves a whitelisted file set at `GET /bin/:name` — the
  natural place to add the compiled plugin binary (bin-server.ts:144).
- Name regex: `session:user@host` (registry.ts:380, `isValidAgentName`);
  `hub@claude-net` / `system@claude-net` reserved.
- Wire protocol details (register two-frame reply, ping echo + pong response,
  masked client frames, hub control PING ~5 s / evict ~30 s, no subprotocol/
  auth) confirmed against the live hub during the spike.

**MicroPython/picolet capabilities** (verified against prebuilt
`packages/picolet-runtime/build/picolet-runtime-linux-x64-cli`, 662 KB):

- Available: asyncio, non-blocking socket (getaddrinfo-style addressing),
  select.poll (not select.select), json, struct, binascii, time.ticks_ms,
  os.stat st_mtime, os.getcwd/listdir/getenv, `ffi` (unix port, `-rdynamic`).
- Async stdin solved: `asyncio.StreamReader(sys.stdin.buffer)` +
  `await readline()`; b'' = EOF; poll-integrated, zero idle CPU (spike).
- RFC6455 client hand-rolled works; combined stdin+WS loop RSS 2.76 MB
  (spike; artifacts `ws.py`, `combined.py`, `mock_hub.py` in scratchpad).
- TLS: variant built with `MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1` = 878 KB;
  real wss register+ping succeeded; module is `tls` not `ssl`; PEM parsing
  off (bundled CA must be DER); SNI mandatory; RSS 3.2 MB with TLS live
  (spike; `mp_wss.py`, `picolet-mcp-tls`, `isrg_root_x1.der`, `build_tls.sh`).
- **NOT available:** os.getpid/getppid/uname/environ, hashlib (cli build),
  `ssl` name. **Workarounds verified live 2026-07-23:** `ffi.open(None)` →
  `getppid()` and `gethostname()` both work from the prebuilt cli binary;
  `os.urandom(16)` works (UUIDv4 source); `time.time_ns()` works (ms epoch
  timestamps).
- **Annotations are NOT retained at runtime** (verified:
  `f.__annotations__` → AttributeError on the prebuilt binary). MicroPython
  also does not expose parameter names or defaults on function objects, and
  has no `inspect` module. **The original "derive schemas from decorated
  function signatures/type-hints" plan is not implementable by runtime
  introspection.** See Q5 — the schema layer takes explicit param specs
  instead (with optional build-time codegen from hints later).

**picolet variant mechanics** (for the new `mcp` variant):

- A variant = `variants/<variant>/unix/mpconfigvariant.{h,mk}` + a manifest
  `manifests/manifest_<variant>.py` + two case-arms in
  `scripts/build-runtime.sh` (target/variant dispatch ~line 94; size-gate
  ceiling table ~line 331). cli's .mk force-disables SSL
  (variants/cli/unix/mpconfigvariant.mk:13–15); the spike overrode this on
  the make command line — the `mcp` variant makes it a proper config.
- Dependency policy: new native deps declared in
  `packages/picolet-runtime/sbom/runtime.toml` (mbedtls entry needed).
- Single-binary output is non-negotiable (picolet CLAUDE.md); production
  packaging appends the app romfs to the binary.

**Memory target arithmetic:** 24 sessions × ~90 MB ≈ 2.6 GB today; 24 × ~3.2 MB
≈ 77 MB after. Single thread vs ~8/session.

## Design decisions

### Settled

- S1. Layer name `mpyfastmcp`; pragmatic stack, no FastAPI/ASGI port (Andrew,
  pre-roadmap).
- S2. Linux is the primary target; Windows deferred to its own phase (async
  stdin on Windows is an open problem — select on pipes doesn't work).
- S3. Distribution: hub serves the compiled binary for on-demand
  download/install, replacing "hub serves .ts, bun runs it". Binary embeds
  PLUGIN_VERSION; install keeps it version-matched to the hub.
- S4. Schema derivation via runtime introspection is off the table (verified
  fact above); the schema layer's ground-truth input is explicit param specs.
  How much hint-driven DX to layer on top is Q5.

### Open questions

| # | Question | Options | Owner phase | Status |
|---|----------|---------|-------------|--------|
| Q1 | TLS packaging | (a) dedicated `mcp` variant (cli + SSL/mbedtls, 878 KB proven) vs (b) re-enable TLS in shared cli variant (conflicts with NFR-1 leanness intent) | Phase 0 decides, Phase 2 executes | DECIDED — see DECISIONS.md |
| Q2 | Cert verification posture | (a) CERT_NONE over tailnet (trust Tailscale) vs (b) bundled ISRG Root X1 DER + CERT_REQUIRED (both proven) | Phase 2 | DECIDED — see DECISIONS.md |
| Q3 | Enable hashlib/SHA1 for Sec-WebSocket-Accept verification | .h macro override, small size cost vs skip (non-load-bearing for a client) | Phase 2 (measure, then decide) | DECIDED — see DECISIONS.md |
| Q4 | Where the reusable libs live | (a) claude-net worktree, shipped via app romfs (b) picolet `packages/` (c) micropython-lib contribution | Phase 0 | DECIDED — see DECISIONS.md |
| Q5 | Schema-spec surface given no runtime annotations | (a) explicit spec objects in the decorator (`@tool(params={...})` / `Field`-style) as ground truth (b) build-time CPython codegen: read real type hints from source, emit spec literals (c) both, (a) first | Phase 5 | DECIDED — see DECISIONS.md |
| Q6 | Hub binary-serving route + client-side caching/refresh mechanics | extend bin-server whitelist vs dedicated `/plugin-bin/<target>` route; cache at `~/.claude-net/` keyed by version vs re-download on upgrade_hint | Phase 8 | OPEN |
| Q7 | Names for the ws / jsonrpc / schema libs | working names `mpyws`, `mpyjsonrpc`, `mpyschema` (only `mpyfastmcp` is fixed) | Phase 0 | DECIDED — see DECISIONS.md |

## Phases

Dependency graph:

```
P0 ──┬── P1 (async-TLS spike) ──┐
     ├── P2 (mcp variant) ──────┼── P3 (ws client lib) ──┐
     ├── P4 (jsonrpc stdio lib) ─┬── P6 (mpyfastmcp) ────┼── P7 (plugin parity) ── P8 (packaging/rollout) ── P9 (Windows)
     └── P5 (schema layer) ──────┘                        │
```

P1/P2 can run in parallel (P1 uses the spike's ad-hoc TLS binary
`picolet-mcp-tls`). P4/P5 need only the prebuilt cli binary and can run in
parallel with P1–P3.

---

### Phase 0 — Worktree, planning scaffold, decision closure

Goal: a claude-net worktree exists with a self-describing planning folder,
spike artifacts preserved, and Q1/Q4/Q7 closed so build phases start unblocked.

Why first: everything else lands in this worktree; Q1 gates Phase 2's shape and
Q4 gates where every library file goes.

Work items:
1. `git worktree add` a claude-net branch (e.g. `mpy-plugin`) off `main`
   @ `4f564a56b9`.
2. Create `planning/` in the worktree: `00_index.md` (document map,
   conventions, phase-entry ticket-revalidation procedure, execution model,
   ticket template), this roadmap as `planning/ROADMAP.md`, and a
   `planning/20260723_spike-results.md` capturing the spike findings +
   verified-facts section above.
3. Copy spike artifacts (`stdin_test.py`, `ws.py`, `ws_driver.py`,
   `mock_hub.py`, `combined.py`, `mp_wss.py`, `build_tls.sh`,
   `isrg_root_x1.der`, `spike.py`) into the worktree (e.g.
   `planning/spike/`) — they are starting code for P1/P3/P4.
4. Expand this roadmap's substantive work items into
   `planning/tickets/<phaseN>_<slug>.md` files (Written-stamped at the
   worktree HEAD), per the ticket template in `00_index.md`.
5. Close Q1, Q4, Q7 with Andrew; record dated DECIDED entries + design notes.
6. Decide the source layout under the worktree (e.g. `src/plugin-mpy/` for the
   plugin, `src/plugin-mpy/lib/{mpyws,mpyjsonrpc,mpyschema,mpyfastmcp}/` per
   Q4 recommendation) and commit the skeleton.

Targets: claude-net worktree on this host; no runtime code yet.

Tests: none (scaffolding); `planning/00_index.md` review is the check.

Exit criteria: worktree + planning folder committed; tickets for P1–P8 exist
with Written stamps; Q1/Q4/Q7 DECIDED and recorded.

Workflow shape: single sonnet agent for scaffolding + ticket expansion; opus
review of the ticket set against this roadmap (gaps, contradictions); Q
closures are user decisions, not agent work.

---

### Phase 1 — Retire the async-TLS risk (spike)

Goal: a wss connection whose TLS handshake and I/O run entirely under the
non-blocking asyncio poll loop, proven against the real hub.

Why this order: this is the top remaining technical risk — the spike's TLS
handshake used a BLOCKING socket. Under asyncio, mbedtls `wrap_socket`
surfaces MBEDTLS_ERR_SSL_WANT_READ/WRITE as OSError(EAGAIN) and the loop must
poll the fd through handshake progress. Everything above the WS client sits on
this; if it needs C-level changes (extmod/modtls_mbedtls.c poll semantics),
better to know before P3.

Work items:
1. Non-blocking `tls.wrap_socket` handshake driver: set socket non-blocking
   before wrap, loop handshake on EAGAIN with poll-based fd readiness, under
   asyncio (extend `mp_wss.py`).
2. Integrate with asyncio streams (or a thin custom stream over poll) for
   post-handshake read/write, including EAGAIN on both directions.
3. **Buffered-record wakeup test**: mbedtls may hold decrypted application
   data in its internal buffer with nothing pending on the raw fd; a poll on
   the fd alone would hang. Verify MicroPython's tls object's MP_STREAM_POLL
   reports pending buffered data (send two JSON frames in one TLS record from
   a test server; second frame must be readable without new fd activity). If
   it does not, design the workaround (drain-after-read loop) and document it.
4. Concurrency proof: stdin readline + wss traffic interleaved in one loop
   (async port of `combined.py` over TLS), idle CPU ~0.
5. Real-hub proof: register + ping against
   `wss://telie.story-kettle.ts.net:4815/ws` from the asyncio loop, both
   CERT_NONE and CERT_REQUIRED(ISRG Root X1 DER).
6. Measure: RSS, handshake wall time, steady-state CPU. Write findings to
   `planning/YYYYMMDD_async-tls.md`.

Targets: `picolet-mcp-tls` spike binary (878 KB) on linux-x64; mock TLS server
(CPython) + real hub.

Tests: scripted CPython harness driving the MicroPython binary: handshake
under load, mid-handshake server stall (EAGAIN path actually exercised),
buffered-record wakeup, server-initiated close during handshake, cert failure
surfaces as a catchable exception.

Exit criteria: async register+ping green against the real hub over TLS from
a single asyncio loop; buffered-record semantics documented; RSS ≤ 4 MB;
findings note written. If a MicroPython C fix is required, it is identified
and either landed (via picolet's mbm feature-branch flow) or worked around —
escalate to Andrew before P3 if C changes are needed.

Workflow shape: implementation on **opus** (deliberate override: TLS/event-loop
state-machine subtlety is the project's top risk and may cross into C
internals); test authoring/running on haiku; standard + adversarial review on
opus; loop until clean.

---

### Phase 2 — The `mcp` picolet variant

Goal: a reproducible, size-gated picolet variant purpose-built for the plugin:
cli baseline + TLS (per Q1), landed in the picolet repo with SBOM entry.

Why here: P3's TLS tests and everything after ship on this binary; parallel
with P1 (which uses the ad-hoc spike build).

Work items:
1. `variants/mcp/unix/mpconfigvariant.{h,mk}`: cli baseline with
   `MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1` (from `build_tls.sh`), compiler ON
   (dev iteration runs .py directly).
2. Decide + implement Q3 (hashlib/SHA1 .h override) after measuring its size
   cost against the 1 MiB ceiling (878 KB baseline, ~146 KB headroom).
3. `manifests/manifest_mcp.py` (initially minimal; libs ship via app romfs per
   Q4 unless Q4 chose freezing).
4. `scripts/build-runtime.sh`: `linux-x64/mcp` case arm + size-gate entry
   (ceiling 1 MiB, new NFR id, e.g. NFR-MCP-1).
5. `sbom/runtime.toml`: mbedtls declaration (dependency policy).
6. Decide + implement Q2 (cert posture): if bundling, embed
   `isrg_root_x1.der` in the romfs/frozen data and wire CERT_REQUIRED + SNI
   as the library default with an explicit insecure override.
7. Commit on picolet `dev` per its commit policy (signed, phase-tagged
   message referencing this work).

Targets: picolet repo, linux-x64 only (Windows arm explicitly absent until
P9).

Tests: build from clean; size gate green; smoke: binary runs `mp_wss.py`
register+ping against the real hub; import-surface test (asserts tls, asyncio,
select.poll, ffi, json, binascii, os.urandom, time.time_ns all present).

Exit criteria: `picolet-runtime-linux-x64-mcp` builds ≤ 1 MiB with gate
enforced; real-hub TLS smoke green; SBOM updated; Q2/Q3 DECIDED and recorded.

Workflow shape: implementation on sonnet (build config, low novelty); tests on
haiku; opus review (including the size-gate and single-binary guard
adversarially); loop.

---

### Phase 3 — Async WebSocket client library (`mpyws`, name per Q7)

Goal: a reusable, tested RFC6455 client for MicroPython asyncio: handshake,
client-side masking, 7/16/64-bit lengths, fragmentation reassembly,
transparent control PING→PONG, clean close handshake, text+binary, over plain
TCP or TLS (P1 pattern).

Why here: first real library; depends on P1 (async TLS) and P2 (the binary it
ships on); plugin and any future MicroPython WS consumer sit on it.

Work items:
1. Extract/rewrite spike `ws.py` into a proper package with a documented API:
   `connect(url, *, ssl_ctx/cadata, headers) -> WSClient`,
   `await recv() -> str|bytes`, `await send(str|bytes)`,
   `await close(code, reason)`, `.closed`, idle/traffic timestamps exposed for
   caller-side watchdogs (watchdog policy itself stays in the app layer).
2. URL parsing (ws/wss, host/port/path), https→wss style scheme mapping.
3. Sec-WebSocket-Key generation (os.urandom + binascii); Accept verification
   iff Q3 enabled hashlib, else skipped with a comment stating why it is
   non-load-bearing for a client.
4. Close/error taxonomy: distinguish clean close, abortive close, protocol
   error; all surface as typed exceptions the caller can drive reconnect from.
5. Fragmentation: reassembly of fragmented text/binary; control frames
   interleaved mid-fragment handled.
6. Package docs + usage example (the mock-hub echo client).

Targets: linux-x64 `mcp` binary; CPython mock servers.

Tests (CPython pytest harness driving the MicroPython binary as a subprocess):
- Unit: frame encode/decode vectors (masking, all three length forms,
  RSV bits rejected, opcode validation).
- Integration: mock server (extend `mock_hub.py`) exercising fragmentation,
  interleaved control frames, ping flood, oversized frame, abrupt FIN,
  mid-frame disconnect, slow-loris partial header.
- Adversarial: a subset of Autobahn-testsuite cases (fuzzingserver in docker,
  ephemeral-container pattern) — at minimum the framing (1.x), ping/pong
  (2.x), fragmentation (5.x) and close (7.x) groups; record pass matrix in
  the phase report.
- TLS: same suite over the P1 TLS path against a CPython TLS echo server.

Exit criteria: all tests green on the `mcp` binary; Autobahn subset pass
matrix recorded with no non-strict failures in the covered groups; API doc
reviewed; RSS of an idle connected client ≤ 3.5 MB.

Workflow shape: implementation on sonnet; test authoring/running on haiku
(Autobahn wiring included); standard + adversarial review on opus (adversarial
brief: RFC 6455 conformance holes, unmasked-frame or length-overflow bugs,
control-frame starvation); loop until clean.

---

### Phase 4 — JSON-RPC 2.0 stdio peer library (`mpyjsonrpc`, name per Q7)

Goal: a reusable async newline-delimited JSON-RPC 2.0 peer over stdio:
serve requests (method dispatch), emit server→client notifications, correlate
client→server requests if ever needed, stderr logging helper, EOF→shutdown
hook.

Why here: independent of P1–P3 (runs on the prebuilt cli binary); mpyfastmcp's
transport core.

Work items:
1. Async read loop on `asyncio.StreamReader(sys.stdin.buffer)`; strict
   line-delimited framing; oversized-line guard.
2. Dispatcher: method registry, positional/named params, JSON-RPC error
   objects (−32700 parse, −32600 invalid request, −32601 method not found,
   −32602 invalid params, −32603 internal), id echo rules (string/number/null),
   notification (no id) handling — no response emitted.
3. Outbound notification API (used later for `notifications/claude/channel`)
   and outbound request correlation with per-request timeout (mirrors the bun
   plugin's 10 s hub-request pattern for symmetry, even though MCP servers
   rarely call out).
4. Concurrency policy: handler execution model (sequential per-connection vs
   task-per-request) documented and tested; stdout writes serialized (single
   writer) so interleaved responses can't corrupt framing.
5. stderr `log()` helper with prefix; EOF (b'') → registered shutdown
   callback.

Targets: prebuilt cli binary (662 KB) for dev; `mcp` binary once P2 lands.

Tests: CPython pytest harness spawning the MicroPython binary as a subprocess
speaking real stdio: happy-path request/response, batch-of-lines burst,
malformed JSON, unknown method, wrong-type params, notification handling,
id-type preservation, huge payload (≥ 256 KB result), EOF mid-stream, stderr
never pollutes stdout.

Exit criteria: conformance suite green; framing fuzz (random byte junk between
valid lines) never crashes the loop; documented API.

Workflow shape: implementation on sonnet; tests on haiku; opus review
(adversarial brief: framing corruption, id confusion, error-object spec
violations); loop.

---

### Phase 5 — Schema layer (`mpyschema`, name per Q7)

Goal: a small, tested library that turns explicit parameter specs into MCP
`inputSchema` JSON-Schema fragments and validates/coerces incoming tool
arguments against them.

Why here: independent; feeds mpyfastmcp. Shaped by the verified fact that
MicroPython retains neither annotations nor parameter-name introspection (S4).

Work items:
1. Spec API (ground truth, per Q5(a)): e.g.
   `Str(desc=..., required=True)`, `Num(...)`, `Bool(...)`, defaults,
   optional fields — enough to express all 11 existing tool schemas exactly
   (they use only object/string/number, required lists, descriptions).
2. Emitter: spec → `{"type":"object","properties":{...},"required":[...]}`
   matching plugin.ts's literals byte-for-byte where semantics allow (parity
   tests diff the emitted tools/list against the bun plugin's).
3. Validator: check + coerce incoming `arguments` (MCP clients send strings/
   numbers; the bun plugin treats everything as strings — match its observed
   leniency, e.g. hub_events since_minutes arrives as number).
4. Q5(b) decision point: if chosen, a CPython codegen tool (uv/PEP 723
   script) that parses the plugin source's real type hints and emits spec
   literals as a build step — additive, not required for P6/P7.
5. Docs: the "why not type hints" note (annotations verified absent at
   runtime) so future readers don't re-litigate it.

Targets: prebuilt cli binary; pure-Python, no TLS/WS dependency.

Tests: golden tests — emit schemas for all 11 claude-net tools + rename prompt
and diff against the literals extracted from plugin.ts; validator
matrix (missing required, wrong type, extra keys, empty object tools);
round-trip under the MicroPython binary, not just CPython.

Exit criteria: emitted tools/list JSON is semantically identical to the bun
plugin's (key-order-insensitive diff clean); validator matrix green on the
MicroPython binary; Q5 DECIDED.

Workflow shape: implementation on sonnet; tests on haiku; opus review; loop.

---

### Phase 6 — `mpyfastmcp`

Goal: the reusable FastMCP-style layer: an `MCPServer` object with
`@server.tool(...)` / `@server.prompt(...)` decorators (specs per P5),
instructions string, capabilities declaration, initialize/oninitialized hook
exposing client capabilities, tools/list, tools/call (with validation +
isError result shape), prompts/list, prompts/get, and a public
`server.notify(method, params)` for custom notifications.

Why here: composes P4 + P5; the last reusable layer before the app.

Work items:
1. `MCPServer(name, version, instructions, capabilities)` over mpyjsonrpc;
   initialize handshake (protocolVersion negotiation as the MCP spec + the
   bun SDK behave), `oninitialized` callback with `getClientCapabilities()`.
2. `@tool(name, description, params=...)` → registry + schema emission +
   arg validation + `{content:[{type:"text",...}], isError?}` result
   convention; helpers equivalent to plugin.ts `toolResult` /
   `notConnectedError`.
3. `@prompt(...)` + prompts/get returning messages (rename-prompt shape).
4. Result post-processing hook (the plugin's nudge-drain needs to append
   content blocks to outgoing tool results — expose a middleware-ish hook
   rather than hard-coding claude-net behaviour into the layer).
5. Notification API used for `notifications/claude/channel` (the layer must
   not hard-code the method name).
6. Ergonomics/docs pass: README with a minimal example server; this is the
   headline reusable deliverable — API review with Andrew before freeze.

Targets: prebuilt cli binary for dev; `mcp` binary for CI.

Tests: harness acting as an MCP client over stdio: full handshake, capability
echo, tools/list golden, tools/call success + validation error + handler
exception → isError, prompts round-trip, notification emission ordering
(notification mid-request must not corrupt framing), unknown method → −32601.
Cross-check: run the same client script against the bun plugin (hubless mode)
and mpyfastmcp demo server; diff behaviours.

Exit criteria: MCP conformance suite green; API reviewed and accepted by
Andrew (it is the reuse surface); demo server in README runs on the `mcp`
binary.

Workflow shape: implementation on sonnet; tests on haiku; standard +
adversarial opus review with an extra API-design review pass (opus) before
Andrew sign-off; loop.

---

### Phase 7 — The claude-net plugin: full feature parity

Goal: `plugin.py` (mpyfastmcp app + mpyws) that a patched Claude Code can use
interchangeably with plugin.ts against the live hub.

Why here: composes everything; parity is verifiable only once all layers
exist.

Work items (the ceremony checklist — each is a reviewable unit; anchors are
plugin.ts lines at `4f564a56b9`):
1. Hub URL derivation from `CLAUDE_NET_HUB` (`http`→`ws` prefix swap, strip
   trailing `/`, append `/ws`; :1465) and hubless mode (tools return
   "CLAUDE_NET_HUB not set" errors; :988).
2. Identity resolution at startup: default `cwd-basename:user@host`
   (USER env; hostname via ffi `gethostname` — verified), persisted-name file
   `<sid>.claude-net.json` next to the transcript, transcript custom-title;
   freshest-timestamp wins (:249–476, :1497–1518).
3. Transcript discovery: encode cwd (non-alphanumeric → `-`), newest `.jsonl`
   under `~/.claude/projects/<encoded>/`, UUID filename validation (:262–318).
4. Auto-register with −2..−9 suffix retry; collision = `/already registered/i`
   on the error; terminal failure → error state file + system notification
   asking the user to pick a name (:1213–1284).
5. Register gating on MCP-initialized AND WS-open, whichever completes second
   (:1297–1304); register frame carries channel_capable, plugin_version,
   cc_pid (ffi `getppid` — verified), cwd.
6. Channel capability: `oninitialized` reads experimental `claude/channel` OR
   `CLAUDE_NET_CHANNELS_PATCHED=1`; else empirical self-test — 2 s delayed
   system@claude-net notification, 60 s window, idempotent `_ack_channel`
   flipping the flag + `update_channel_capable` push; re-fire on manual
   register while false (:1068–1149, 1438–1459).
7. Nudge queue: one-shot content blocks drained into the next tool result;
   upgrade_hint capture; guarded "Rename suggestion" after suffixed
   auto-register; manual register cancels the rename nudge (:790–954,
   1030–1056, 1229–1240).
8. /rename transcript watch: 5 s poll, stat-size change gate, latest
   custom-title, sanitize (`sanitizeSessionPart` rules :374–381),
   re-register via the retry path (:1526–1560).
9. `rename` MCP prompt → the two-step mirror-agent-inject + register message
   (:729–778).
10. Inbound `{event:"message"}` → `notifications/claude/channel` with cn_
    meta (:501–518); `registered`/`error` frames logged.
11. Request correlation: UUIDv4 requestId (os.urandom — verified), 10 s
    timeout, pending-map rejection on disconnect (:1151–1168, 1571–1575).
12. Watchdog: 31 s no-traffic → terminate + reconnect; reset on data AND
    control PING (mpyws exposes traffic timestamps); backoff 1 s→30 s
    doubling, reset on open (:1306–1385).
13. Statusline state file `/tmp/claude-net/state-<ppid>.json`
    {name,status,error?,hub,cwd,updated_at ISO-8601} on register/disconnect/
    error; deleted on shutdown (:526–558).
14. Local tools: whoami (with the exact unregistered guidance text), tool
    blocking until registered except register, plain-name auto-expansion
    (:959–1016).
15. INSTRUCTIONS parity (:101–213) and server info/capabilities parity
    (:1396–1406) — byte-identical strings unless a difference is deliberate
    and recorded.
16. Lifecycle: stdin EOF → shutdown when hub configured; SIGTERM/SIGINT if
    representable (MicroPython unix has no signal module in cli — investigate;
    EOF path is the load-bearing one per :1589–1601); clean shutdown
    semantics (:1562–1577).
17. PLUGIN_VERSION constant, single source, reported in register.

Targets: linux-x64 `mcp` binary + app romfs; dev iteration as
`picolet-runtime-linux-x64-mcp plugin.py`.

Tests:
- Unit/integration: extend `mock_hub.py` into a scriptable mock hub fixture
  (scripted frame sequences: collision cascades, upgrade_hint, offline NAKs,
  hub silence → watchdog fire, two-frame register reply, ping echo pair).
- **Parity harness (the key gate):** one scenario driver runs the SAME
  scripted MCP-client + mock-hub scenario against the bun plugin and the
  MicroPython plugin, diffing: tools/list, prompts/list, every tool result,
  notification frames, hub frames sent, state-file contents. Divergences are
  either bugs or documented deliberate differences.
- Ceremony tests: fake `~/.claude/projects/` tree fixtures for transcript
  discovery, persisted-name freshness contest, /rename detection latency.
- Real-hub smoke: register, whoami, send/receive with a live peer, ping,
  hub_events, reconnect-after-hub-restart, watchdog recovery after suspend
  (manual), 24 h soak with periodic traffic — RSS stable ≤ 4 MB, no fd leak.

Exit criteria: parity harness clean (or divergences signed off by Andrew);
real-hub smoke green including inbound `<channel>` rendering in a patched CC
session; soak shows flat RSS ≤ 4 MB and single OS thread (`/proc/<pid>/status`
Threads: 1); measured per-session footprint recorded next to the 90 MB bun
baseline.

Workflow shape: implementation split across two sonnet agents (WS/lifecycle
half vs identity/ceremony half — the nudge queue and register gating are the
seam to specify carefully in tickets); tests on haiku; standard + adversarial
opus review (adversarial brief: race between oninitialized and WS open,
reconnect during in-flight request, rename-during-collision-retry, state-file
staleness); loop until parity harness + reviews clean.

---

### Phase 8 — Packaging, distribution, rollout

Goal: the hub serves the versioned binary; a fresh host installs and runs the
MicroPython plugin via `curl <hub>/setup | bash`; version lockstep and
upgrade_hint keep it current; rollout is opt-in first, then default.

Work items:
1. Production packaging: build-runtime.sh romfs-append step producing
   `claude-net-plugin-linux-x64` (mcp binary + plugin app romfs), version
   stamped at build; a build check asserts embedded PLUGIN_VERSION equals hub
   package.json version (lockstep, replacing plugin.ts's "bump both" comment
   discipline).
2. Hub serving (Q6): route for the binary (bin-server whitelist extension or
   `/plugin-bin/<target>`), correct content-type, and a version/hash endpoint
   so installs can check freshness cheaply.
3. setup.ts: new install path — download binary to `~/.claude-net/plugin/`
   (not /tmp: it must survive reboots, unlike the current per-launch .ts
   fetch), chmod +x, register the MCP server command as the binary (argv/env
   identical semantics: exec'd so ppid is CC); keep the bun path behind a
   flag during rollout (e.g. `/setup?runtime=bun`).
4. Upgrade flow: hub upgrade_hint text already says re-run `/setup` — verify
   it holds for the binary path; wrapper or launcher re-checks version against
   the hub endpoint at spawn and re-downloads when stale (decide exact
   mechanics under Q6; must not add per-launch latency when current).
5. install-channels / statusline / mirror-agent interplay: state-file format
   unchanged (statusline.py reads it), `CLAUDE_NET_CHANNELS_PATCHED` export
   honored, docs updated.
6. Hub-side PLUGIN_VERSION_CURRENT / buildUpgradeHint unchanged in semantics;
   CI job in the worktree builds the binary and runs the parity harness
   against the hub version it will ship with.
7. Rollout: (a) opt-in on Andrew's hosts, soak ≥ 1 week of real use across
   ≥ 10 concurrent sessions; (b) flip /setup default to the binary; (c) bun
   path retained as documented fallback for one release, then removed.
   Aggregate-memory measurement before/after recorded in the phase report.

Targets: hub at telie (and local dev hub) + at least two client hosts.

Tests: fresh-host install from scratch via /setup in a clean container;
upgrade test (old binary + bumped hub → upgrade_hint surfaces → re-setup
lands new version); mixed-fleet test (bun and mpy plugins registered
simultaneously — hub treats both correctly); statusline renders from the mpy
state file; /mcp reconnect restores persisted name.

Exit criteria: fresh install → working session with inbound channels, zero
manual steps beyond the documented one-liner; version-lockstep check enforced
in CI; soak criteria met; default flipped with fallback documented.

Workflow shape: implementation on sonnet (hub TS + bash + build scripting);
tests on haiku (container-based install tests); opus review with an
adversarial pass on the supply path (partial download, hub/binary version
skew, stale cache, concurrent-session download race); loop.

---

### Phase 9 — Windows (deferred)

Goal: the plugin runs on Windows hosts with the same parity bar. Explicitly
deferred; nothing in P0–P8 may add Windows work, but nothing may bake in
gratuitous Linux-isms either (path handling and the ffi surface are the
watch-points — keep them behind small platform shims per picolet's façade
pattern).

Known problem statement (do not start without a spike):
- Async stdin: select/poll doesn't work on Windows pipes; MicroPython windows
  port options (thread-based reader feeding a queue, overlapped I/O via a
  small C shim in `user_c_modules/`, or the `pr/windows-extra-src-c` hook)
  need a P1-style de-risking spike.
- `mcp` variant windows arm: mbedtls under the dockcross MinGW cross-build;
  import-table allow-list guard per picolet's single-binary policy.
- ffi replacements: getppid/gethostname/state-file ppid have Win32
  equivalents (picolet_winevents precedent exists for Win32 FFI surface).
- Distribution: `/plugin-bin/windows-x64` + setup.ps1 or WSL-interop story.

Exit criteria (when scheduled): parity harness green on windows-x64 via WSL
interop per picolet test policy; separate spike report first.

Workflow shape: spike on opus, then the standard tiering.

## Rollout strategy (summary)

Side-by-side first: the hub serves both plugin forms; /setup gains a runtime
selector defaulting to bun until P8 soak completes; the register frame's
plugin_version distinguishes fleets; flip the default, keep bun as a
documented fallback for one release. The hub wire protocol is unchanged
throughout — no hub-side migration, only serving/install changes.

## Risk register

| Risk | Phase | Mitigation |
|------|-------|------------|
| Async TLS handshake under poll loop fails or needs C changes | P1 | Dedicated spike phase before any dependent build; escalation path to picolet mbm feature branch if extmod fix needed |
| mbedtls buffered application data not surfaced by poll → read hang | P1 | Explicit buffered-record wakeup test (two frames, one TLS record) |
| Schema DX disappointment (no type hints at runtime) | P5 | Verified early (this doc); explicit-spec API + optional CPython codegen (Q5); golden-diff tests guarantee parity regardless |
| Parity drift vs bun plugin evolving on main during build-out | P7 | Parity harness pinned to a hub version; ticket revalidation at phase entry includes `git log` over claude-net main |
| Long-session RSS growth (GC fragmentation) | P7 | 24 h soak with traffic; flat-RSS exit criterion |
| Large hub_events / tool payloads vs MicroPython json | P4/P7 | ≥ 256 KB payload test in P4; 1000-event query test in P7 |
| Version skew binary↔hub after install | P8 | Build-time lockstep assert + spawn-time freshness check + upgrade_hint path test |
| Watchdog false-positive/negative porting (timer semantics differ from Node unref'd timers) | P7 | Mock-hub silence scenario + suspend/resume manual test |
| No signal module for SIGTERM handling | P7 | stdin-EOF is the load-bearing shutdown path (matches bun plugin reality); investigate signal availability, document outcome |
| Only linux-x64 served initially; non-Linux hosts | P8/P9 | Mixed-fleet support keeps bun path working; Windows has its own phase |

## Progress tracking

- Each phase writes `planning/YYYYMMDD_<topic>.md` (findings, measurements,
  learnings) to the worktree planning folder, date + HEAD stamped.
- This roadmap is updated in place as phases complete and questions close;
  never forked.
- At each phase entry, the workflow planner revalidates that phase's tickets:
  `git log <ticket SHA>..HEAD` + `git diff <ticket SHA>..HEAD -- <anchors>`
  for code drift (both repos — claude-net worktree AND picolet), planning
  docs dated after the ticket's stamp + Qk changes for knowledge drift;
  update the ticket in place and append a Revalidated stamp. Only tickets
  revalidated at current HEAD feed a workflow. Drift big enough to reshape a
  ticket is a roadmap update, not a silent rewrite.
- Execution model: each phase's revalidated tickets feed a dynamic
  multi-agent workflow; coding tiering implementation→sonnet, automated
  testing→haiku, standard+adversarial review→opus, looped until reviews are
  clean and tests pass. Documented per-phase overrides (P1 opus
  implementation) take precedence.
