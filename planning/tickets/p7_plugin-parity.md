# Ticket: P7 — The claude-net plugin: full feature parity

- Phase: P7
- Owner-model (impl / test / review): 2x sonnet (split: WS/lifecycle half vs identity/ceremony half) / haiku / opus (standard + adversarial)
- Depends on: P1, P2, P3, P4, P5, P6
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: 2026-07-23 @ pre-commit
- Revalidated:

## Goal

`plugin.py` (mpyfastmcp app + mpyws) that a patched Claude Code can use
interchangeably with plugin.ts against the live hub. This phase composes
every prior layer (mpyws, mpyjsonrpc, mpyschema, mpyfastmcp, the `mcp`
variant, async TLS); parity is verifiable only once all of them exist.

## Preconditions

- P1: async TLS handshake+I/O proven under the asyncio poll loop against the
  real hub.
- P2: `mcp` picolet variant built, size-gated, SBOM-recorded, real-hub TLS
  smoke green.
- P3: `mpyws` — connect/recv/send/close, fragmentation, control PING/PONG,
  plain + TLS, Autobahn subset passing.
- P4: `mpyjsonrpc` — async stdio JSON-RPC 2.0 peer, dispatcher, outbound
  notifications/correlation, EOF shutdown hook.
- P5: `mpyschema` — spec-to-inputSchema emitter + validator, golden-diffed
  against plugin.ts's 11 tool schemas.
- P6: `mpyfastmcp` — `MCPServer`, `@tool`/`@prompt` decorators, notify hook,
  nudge-drain middleware hook, API reviewed and accepted by Andrew.

## Work items

The ceremony checklist — each item is an independently reviewable unit.
Anchors are plugin.ts lines at claude-net `main` @ `4f564a56b9`.

1. Hub URL derivation from `CLAUDE_NET_HUB` (`http`→`ws` prefix swap, strip
   trailing `/`, append `/ws`; plugin.ts:1465) and hubless mode (tools return
   "CLAUDE_NET_HUB not set" errors; plugin.ts:988).
2. Identity resolution at startup: default `cwd-basename:user@host` (USER
   env; hostname via ffi `gethostname` — verified), persisted-name file
   `<sid>.claude-net.json` next to the transcript, transcript custom-title;
   freshest-timestamp wins (plugin.ts:249–476, plugin.ts:1497–1518).
3. Transcript discovery: encode cwd (non-alphanumeric → `-`), newest
   `.jsonl` under `~/.claude/projects/<encoded>/`, UUID filename validation
   (plugin.ts:262–318).
4. Auto-register with −2..−9 suffix retry; collision = `/already
   registered/i` on the error; terminal failure → error state file + system
   notification asking the user to pick a name (plugin.ts:1213–1284).
5. Register gating on MCP-initialized AND WS-open, whichever completes
   second (plugin.ts:1297–1304); register frame carries channel_capable,
   plugin_version, cc_pid (ffi `getppid` — verified), cwd.
6. Channel capability: `oninitialized` reads experimental `claude/channel`
   OR `CLAUDE_NET_CHANNELS_PATCHED=1`; else empirical self-test — 2 s
   delayed system@claude-net notification, 60 s window, idempotent
   `_ack_channel` flipping the flag + `update_channel_capable` push;
   re-fire on manual register while false (plugin.ts:1068–1149,
   plugin.ts:1438–1459).
7. Nudge queue: one-shot content blocks drained into the next tool result;
   upgrade_hint capture; guarded "Rename suggestion" after suffixed
   auto-register; manual register cancels the rename nudge
   (plugin.ts:790–954, plugin.ts:1030–1056, plugin.ts:1229–1240).
8. `/rename` transcript watch: 5 s poll, stat-size change gate, latest
   custom-title, sanitize (`sanitizeSessionPart` rules plugin.ts:374–381),
   re-register via the retry path (plugin.ts:1526–1560).
9. `rename` MCP prompt → the two-step mirror-agent-inject + register
   message (plugin.ts:729–778).
10. Inbound `{event:"message"}` → `notifications/claude/channel` with cn_
    meta (plugin.ts:501–518); `registered`/`error` frames logged.
11. Request correlation: UUIDv4 requestId (os.urandom — verified), 10 s
    timeout, pending-map rejection on disconnect (plugin.ts:1151–1168,
    plugin.ts:1571–1575).
12. Watchdog: 31 s no-traffic → terminate + reconnect; reset on data AND
    control PING (mpyws exposes traffic timestamps); backoff 1 s→30 s
    doubling, reset on open (plugin.ts:1306–1385).
13. Statusline state file `/tmp/claude-net/state-<ppid>.json`
    {name,status,error?,hub,cwd,updated_at ISO-8601} on register/disconnect/
    error; deleted on shutdown (plugin.ts:526–558).
14. Local tools: whoami (with the exact unregistered guidance text), tool
    blocking until registered except register, plain-name auto-expansion
    (plugin.ts:959–1016).
15. INSTRUCTIONS parity (plugin.ts:101–213) and server info/capabilities
    parity (plugin.ts:1396–1406) — byte-identical strings unless a
    difference is deliberate and recorded.
16. Lifecycle: stdin EOF → shutdown when hub configured; SIGTERM/SIGINT if
    representable (MicroPython unix has no signal module in the cli build —
    investigate; EOF path is the load-bearing one per plugin.ts:1589–1601);
    clean shutdown semantics (plugin.ts:1562–1577).
17. PLUGIN_VERSION constant, single source, reported in register.

## Interfaces / contracts

- `plugin.py` is the single entry point invoked as
  `picolet-runtime-linux-x64-mcp plugin.py` for dev iteration, and as the
  `mcp` binary + app romfs for the packaged form P8 consumes.
- PLUGIN_VERSION (work item 17) is the single version source P8's
  build-time lockstep-assert (hub package.json version match) reads.
- Statusline state-file format (work item 13) is a stable contract:
  `statusline.py` and P8's install/rollout tooling read it unchanged.
- `CLAUDE_NET_CHANNELS_PATCHED` env var (work item 6) is a stable external
  contract consumed unchanged by P8's install-channels interplay.
- The parity harness scenario driver (see Tests) is itself a reusable
  artifact: P8's CI job re-runs it against the packaged binary before
  shipping.

## Tests

- Unit/integration: extend `mock_hub.py` into a scriptable mock hub fixture
  (scripted frame sequences: collision cascades, upgrade_hint, offline NAKs,
  hub silence → watchdog fire, two-frame register reply, ping echo pair).
- **Parity harness (the key gate):** one scenario driver runs the SAME
  scripted MCP-client + mock-hub scenario against the bun plugin and the
  MicroPython plugin, diffing: tools/list, prompts/list, every tool result,
  notification frames, hub frames sent, state-file contents. Divergences
  are either bugs or documented deliberate differences (signed off by
  Andrew).
- Ceremony tests: fake `~/.claude/projects/` tree fixtures for transcript
  discovery, persisted-name freshness contest, `/rename` detection latency.
- Real-hub smoke: register, whoami, send/receive with a live peer, ping,
  hub_events, reconnect-after-hub-restart, watchdog recovery after suspend
  (manual), 24 h soak with periodic traffic — RSS stable ≤ 4 MB, no fd leak.

## Exit criteria

- Parity harness clean, or divergences explicitly signed off by Andrew.
- Real-hub smoke green including inbound `<channel>` rendering in a patched
  CC session.
- Soak shows flat RSS ≤ 4 MB and single OS thread (`/proc/<pid>/status`
  Threads: 1).
- Measured per-session footprint recorded next to the 90 MB bun baseline.

## Open questions consumed

- Q1 — DECIDED: dedicated `mcp` variant (cli baseline + mbedtls). This
  phase targets that binary directly; no TLS work of its own beyond what
  mpyws/mpyfastmcp already expose.
- Q2 — DECIDED: bundled ISRG Root X1 DER + CERT_REQUIRED + SNI as default,
  with an explicit insecure-override env var. The plugin's hub-connect path
  (work item 1) uses this default; no separate cert-handling code belongs
  in the plugin itself.
- Q4 — DECIDED: reusable libs (mpyws, mpyjsonrpc, mpyschema, mpyfastmcp)
  ship from the claude-net-mpy worktree via the app romfs, not a picolet
  manifest. `plugin.py` imports them from that worktree layout.
- Q5 — DECIDED: explicit spec objects (mpyschema, per P5) are the schema
  ground truth; work item 15's INSTRUCTIONS/capabilities parity and the 12
  tool schemas are expressed this way, not via type-hint introspection.
- Q7 — DECIDED: library names `mpyfastmcp`, `mpyws`, `mpyjsonrpc`,
  `mpyschema` — this phase's imports use these names as final, not
  placeholders.

## Risks

- Parity drift vs bun plugin evolving on `main` during build-out —
  mitigation: parity harness pinned to a hub version; ticket revalidation
  at phase entry includes `git log` over claude-net `main`.
- Long-session RSS growth (GC fragmentation) — mitigation: 24 h soak with
  traffic; flat-RSS exit criterion.
- Watchdog false-positive/negative porting (timer semantics differ from
  Node's unref'd timers) — mitigation: mock-hub silence scenario +
  suspend/resume manual test.
- No signal module for SIGTERM handling in the cli build — mitigation:
  stdin-EOF is the load-bearing shutdown path (matches bun plugin reality);
  investigate signal availability and document the outcome (work item 16).
- Race between `oninitialized` and WS-open completing in either order
  (work item 5's gating is the seam) — adversarial review brief item.
- Reconnect while a request is in-flight (work item 11/12 interaction) —
  adversarial review brief item.
- Rename-during-collision-retry interaction between work items 4 and 8 —
  adversarial review brief item.
- State-file staleness across register/disconnect/error/shutdown
  transitions (work item 13) — adversarial review brief item.
