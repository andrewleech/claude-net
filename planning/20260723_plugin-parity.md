# P7 findings: bun-vs-mpy plugin parity

- Date: 2026-07-23
- Anchors: claude-net-mpy `mpy-plugin` @ `39ea695`, picolet `dev` @ `be86d84`
- Status: **PASS-with-documented-divergences**

This note synthesises the P7 review round history (3 rounds) that drove the
MicroPython plugin (`src/plugin-mpy/plugin.py` + `_hub`/`_identity`/
`_instructions`/`_statusline`/`_stdin_shim`/`_version`) to parity with the
reference bun plugin (`plugin.ts`), running on the
`picolet-runtime-linux-x64-mcp` binary. Tests live under
`src/plugin-mpy/tests/`.

## Outcome

PASS-with-documented-divergences. By round 3 the parity harness is clean, all
19 ceremony tests pass against the real binary, and the real-hub smoke passes.
The exit gate is met with three deliberate/accepted divergences recorded below;
two minor faithfulness residuals (hub_events zero-value args; cross-runtime
timestamp units) remain open and are carried to P8 rather than blocking P7.

The round-1 green report was **not** trustworthy: the review found the parity
harness only diffed `tools/list`/`prompts/list`/`serverInfo`, and 13 of 17
ceremony tests were hardcoded `pass:True` stubs. The verification instruments
were rebuilt in the round-1 fix before the gate could legitimately be checked.
Rounds 2 and 3 then ran against real instruments.

## Parity harness result (bun-vs-mpy)

Clean — `parityClean=true`, 7/7 scenarios, zero undocumented divergences
(rounds 2 and 3).

What is diffed (after the round-1 rebuild of `parity_harness.py`): the harness
drives scripted MCP-client + mock-hub scenarios against **both** bun and mpy
and byte-compares every observable surface:

- `serverInfo.name`/`version`, `tools/list` (11 tools, schemas), `prompts/list`.
- Each `tools/call` result body.
- Each `notifications/claude/channel` frame.
- Each hub frame sent on the wire (captured via a new `--frame-log` on
  `planning/spike/mock_hub.py`, UUID-redacted).
- `/tmp/claude-net/state-<ppid>.json` contents.

Scenarios: registration+notification+state-file+EOF-shutdown; ping echo;
offline NAK; collision-cascade+nudge-queue.

Bugs the rebuilt harness surfaced and forced fixed in `plugin.py` (previously
undocumented divergences from bun):

- `isError` results were missing bun's `"Error: "` prefix — added
  `_error_result` at all 6 call sites.
- Tool results were compact JSON, not bun's 2-space-indented output —
  MicroPython's `json.dumps` has no `indent` kwarg, so a hand-rolled
  `_json_pretty`/`_tool_result` matches bun byte-for-byte.
- `channel_capable` used Python `bool({})` (False) where bun uses JS `!!{}`
  (True) — added `_js_truthy` to match JS truthiness.

Test-infra bugs found and fixed while building the real tests (not app bugs):
`run_mock_hub` invoked `uv` wrong and resolved `mock_hub.py` one dir too
shallow, so no scripted-hub test had ever reached a live hub; the harness's
`initialize()` never sent `notifications/initialized`, so auto-register never
fired in any prior test.

Deliberate divergences justified against the harness:

1. **Shutdown-on-EOF drain.** With a tool call in-flight, mpy drains the
   in-flight request to a real reply before exit (bounded by the hub request's
   own 10s timeout), because `mpyjsonrpc.JsonRpcPeer.serve()` drains in-flight
   handler tasks before firing shutdown callbacks. bun does `process.exit(0)`
   (near-instant, silently drops the reply). Root-caused to the frozen
   `mpyjsonrpc` library; recorded as intentional (never drops a reply).
2. **No-signal cleanup.** The mcp cli build has no `signal` module, so state-file
   deletion is EOF-driven only; a SIGTERM without EOF leaves a stale state file.
   This is the DECIDED work-item-16 tradeoff (EOF is load-bearing).

## 17-ceremony status

| # | Ceremony | Status |
|---|----------|--------|
| 1 | Hub URL derivation (http/https→ws/wss, trailing-slash strip, /ws) | faithful |
| 2 | Identity resolution (cwd-basename:user@host, freshest-of-persisted/custom-title) | faithful; residual (cross-runtime ts units) |
| 3 | Transcript discovery (newest UUID-named .jsonl) | faithful |
| 4 | Auto-register collision cascade (-2..-9 suffix on /already registered/) | faithful |
| 5 | Register gating (fires once, both MCP-initialized AND WS-open) | faithful |
| 6 | Channel capability self-test (2s/60s, idempotent _ack_channel, PATCHED bypass) | faithful |
| 7 | Nudge queue (one-shot drain into next tool result, not _ack_channel/errors) | faithful |
| 8 | Rename transcript watch (5s poll, stat-size gate, re-register) | faithful |
| 9 | Rename prompt (prompts/get drives /rename self-inject + register) | faithful |
| 10 | Inbound messages (event→notifications/claude/channel, cn_ meta) | faithful |
| 11 | Request correlation (UUIDv4 id, 10s timeout, pending-map on disconnect) | deliberate divergence (drain-before-shutdown vs process.exit) |
| 12 | Watchdog (31s no-traffic, inbound-only reset, backoff 1s→30s) | faithful (fixed R2: last_recv_ms) |
| 13 | Statusline state file (write on register, delete on shutdown) | faithful (fixed R2: ppid cached at startup) |
| 14 | Local tools + hub_events frame mapping | divergence (hub_events zero-value args, unfixed) |
| 15 | INSTRUCTIONS / serverInfo / capabilities parity | faithful (byte-identical INSTRUCTIONS) |
| 16 | Lifecycle (stdin EOF → exit 0, state file deleted) | deliberate divergence (no-signal SIGTERM cleanup) |
| 17 | PLUGIN_VERSION (0.2.0, single source) | faithful |

Round-2 review caught two real, load-bearing bugs the round-1 suite could not
structurally reach; both were one-line fixes and were closed in the round-2 fix:

- **Ceremony 13 — orphaned state file.** `delete_session_state()` recomputed the
  path from a live `getppid()` at shutdown; but shutdown is triggered by the
  parent's death, so `getppid()` returned the reaper pid (1) and the real
  `state-<ccpid>.json` was orphaned (permanent phantom-agent entry). Fixed by
  caching the ppid at first call (parent still alive), matching `plugin.ts`
  capturing `STATE_FILE` at module load.
- **Ceremony 12 — watchdog false-negative.** Read `ws.last_traffic_ms` (updated
  on send OR recv), so outbound app sends against a zombie socket suppressed the
  watchdog. Fixed to `ws.last_recv_ms` (inbound data + control PING/PONG/CLOSE
  only), matching bun's inbound-only reset.

## Real-hub smoke

Passed all three rounds. Target `wss://telie.story-kettle.ts.net:4815/ws`,
7/7 operations: initialize, register, whoami, ping, hub_events, list_agents,
send_message.

## Measurements

- Binary: `picolet-runtime-linux-x64-mcp`, ~879 KB (P2 sized the mcp variant at
  899,384 bytes against the 1 MiB NFR-MCP-1 ceiling).
- Import surface exercised: tls, asyncio, hashlib.sha1, ffi, os.urandom,
  time.time_ns.
- **RSS and thread count were not captured** in any P7 round — see residuals.

## Residuals for P8

1. **hub_events zero-value args (minor, ceremony 14).** `since_minutes=0` and
   `limit=0` are treated as literals; bun treats them as JS-falsy and applies
   defaults (`since_minutes ? … : 60`, omit `limit` unless truthy). With
   `since_minutes=0,limit=0` bun sends `since=now-60min` and omits `limit`; mpy
   sends `since=now-0min` and includes `limit:0`. Same JS-truthiness gap already
   solved via `_js_truthy` for channel capability, missed for the numeric args.
   Not caught by the harness. Fix in `_tool_hub_events`.
2. **Cross-runtime persisted-name timestamp units (minor, ceremony 2).** mpy
   writes `ts` in seconds (`time.time()`) and reads custom-title mtime in
   seconds (`os.stat[8]`); bun uses milliseconds (`Date.now()` / `mtimeMs`).
   Each runtime is internally consistent, but a `<sid>.claude-net.json` written
   by one runtime and read by the other breaks freshest-wins (ms ~1.7e12 always
   dominates s ~1.7e9). Undercuts the stated bun/mpy interchangeability if a
   session migrates. Normalise to milliseconds in `_identity`. Not diffed by the
   harness (each runtime runs against its own state).
3. **No runtime resource measurement.** Capture RSS and thread count of the
   running plugin against the real hub, and set a budget, so P8 CI can regress
   on process footprint (not just parity/behavior).
4. **Signed-off divergence list.** Record the drain-before-shutdown (11) and
   no-signal-cleanup (16) divergences explicitly on the ticket so the
   "divergences deliberate + documented" exit criterion is unambiguous.
