# Mirror-Session Feature Plan

Live-stream a local Claude Code session to the claude-net hub's web UI, so you can follow along — and continue the conversation — from any device on the trust network.

## 1. Goals & non-goals

### Goals
- **Transparent activation.** No new CLI flags; mirroring turns on via a setting, env var, or opt-in slash command. Default is **off**.
- **Zero observable latency** on the interactive terminal. The user never waits for the hub.
- **Full fidelity.** Every user prompt, assistant message, tool call, tool result, and status notification shows up in the web UI in the same order as the terminal.
- **Remote continuation.** From the web UI, send a message as the local user; the local Claude receives it and replies, and both devices see the full exchange.
- **Trust-network security.** Inherit the claude-net LAN/Tailnet trust boundary; add per-session mirror tokens so a passerby on the LAN can't silently attach.

### Non-goals
- Not a replacement for claude.ai. No cross-cloud sync, no SaaS.
- Not a full remote renderer — no live spinner / ANSI pixel-perfect redraw. We render the logical conversation, not the TUI framebuffer.
- Not multi-user collaboration within one session (only the original user can send remote input; others can watch if granted a read token).
- Not persistence-by-default. Transcripts live in-memory in the hub unless explicitly saved.

## 2. High-level architecture

```
┌──────────────────── local host ────────────────────┐        ┌────────── hub ───────────┐        ┌────── remote device ───────┐
│                                                    │        │                          │        │                            │
│  claude-channels launcher                          │        │  Elysia (Bun)            │        │  browser @ hub:4815        │
│   └─ patched claude (interactive TUI)              │        │   ├─ /ws   (plugin WS)   │        │   └─ dashboard.html        │
│        │                                           │        │   ├─ /ws/dashboard       │        │        ├─ live feed        │
│        ├─ hooks: UserPromptSubmit / Stop /         │        │   ├─ /ws/mirror/{sid}    │◄─────► │        ├─ transcript pane  │
│        │    Pre/PostToolUse / Notification         │        │   │    (new)            │        │        └─ compose box      │
│        │       │   POST → 127.0.0.1:N (mirror      │        │   └─ /api/mirror/...    │        │                            │
│        │       │            agent, loopback only)  │        │                          │        │                            │
│        │       ▼                                   │        │  MirrorRegistry          │        │                            │
│  mirror-agent  ── WS ──►  hub /ws   (same plugin   │◄──────►│   sid → { transcript[],  │        │                            │
│   (separate MCP session / lightweight daemon)      │        │     watchers[], owner,   │        │                            │
│        │                                           │        │     localAgent }         │        │                            │
│        └─ FIFO: /tmp/claude-net/inject-{pid}.fifo  │        │                          │        │                            │
│             (Claude patched to read via a          │        │                          │        │                            │
│              UserPromptSubmit-style hook)          │        │                          │        │                            │
└────────────────────────────────────────────────────┘        └──────────────────────────┘        └────────────────────────────┘
```

Two roles per mirrored session:
- **mirror-agent** — a small local process (NOT inside claude) that owns the hub WebSocket, buffers events, and handles the injection FIFO. Kept separate so that (a) claude's hot path never blocks on a network call, and (b) the agent survives a `/clear` or restart of the interactive claude.
- **hub MirrorSession** — in-hub per-session state holding the canonical transcript and a watcher set.

## 3. Capture strategy

### 3.1 Why hooks + optional patcher (and not purely tailing the JSONL)

| Tap point                | Latency                | Fidelity               | Invasiveness                   |
|--------------------------|------------------------|------------------------|--------------------------------|
| JSONL tail (inotify)     | ~fsync-dependent       | Full (post-turn)       | Zero — disk only               |
| Hooks (Pre/Post/Stop)    | Same-turn, sub-ms fire | Full per-event         | `settings.json` addition       |
| MCP notifications        | N/A                    | None (no conv events)  | —                              |
| Binary patch             | In-process             | Anything we want       | Fragile; only if we must       |

Decision: **hooks primary, JSONL tail as reconciliation fallback, patcher reserved for input injection only.**
- Hooks give us everything outbound (user → assistant → tools) at message granularity, and run in-process so there's nothing to lose.
- We POST to `127.0.0.1` on the *loopback* mirror-agent, not to the hub — so the hook returns in microseconds even if the hub is down or slow.
- A background inotify watcher on the session's JSONL reconciles anything a hook dropped (it happens; `Stop` can be skipped in some paths). Each JSONL record has `uuid`, so dedupe is trivial.

### 3.2 Hook set

Added to `~/.claude/settings.json` (merged by the installer, never overwritten):

| Hook            | Payload we forward                                           | UI representation                  |
|-----------------|--------------------------------------------------------------|------------------------------------|
| `SessionStart`  | `session_id`, `transcript_path`, `cwd`, `source`             | Open new mirror session pane       |
| `UserPromptSubmit` | `prompt`, `session_id`, timestamp                         | User bubble                        |
| `PreToolUse`    | `tool_name`, `tool_input`, `tool_use_id`                     | Collapsed tool call card           |
| `PostToolUse`   | `tool_name`, `tool_response`, `tool_use_id`                  | Fill in result                     |
| `Stop`          | `last_assistant_message`, `stop_reason`                      | Assistant bubble (canonical)       |
| `Notification`  | message text                                                 | Inline status note                 |
| `PreCompact` / `PostCompact` | summary metadata                                | "Conversation compacted" divider   |

All hooks are single-line JSON stdin → exit 0. The command is:
```json
{"command": "/usr/bin/env claude-net-mirror-push", "timeout_ms": 50}
```
`claude-net-mirror-push` is a 30-line shell/bun script that `POST`s to `127.0.0.1:${MIRROR_PORT}/hook` with the raw JSON. 50ms timeout is generous — in practice it returns in <2ms. If the mirror-agent isn't running, the request fails fast and the hook returns 0 regardless. **We never block claude on a failing mirror.**

### 3.3 Mirror-agent

A long-running local Bun process. One per user, shared across sessions. Launched lazily the first time the launcher sees mirroring enabled. Responsibilities:

1. Accept hook POSTs on `127.0.0.1:<auto-port>`.
2. Maintain a WebSocket to the hub (reuses the claude-net plugin's `ws` logic and shared `types.ts` frames).
3. For each live `session_id`: `POST /api/mirror/session` on first event, then stream events as a new `MirrorEventFrame`.
4. Watch each session's JSONL with `fs.watch` (persistent=false) for reconciliation; dedupe by `uuid`.
5. Listen for `MirrorInjectFrame` from hub and write the prompt to `/tmp/claude-net/inject-<pid>.fifo` (see §6).
6. Expose `/health`, `/sessions`, `/stop` on loopback for the launcher and for `/mirror` status.

Being separate from both claude and the MCP plugin is deliberate:
- Plugin lives only as long as claude does. Mirror-agent should outlive `/clear` and claude restarts so a watcher on the web doesn't lose the session on every restart.
- A crash in the mirror-agent can't take down claude.

## 4. Hub changes

### 4.1 New WebSocket/API surface

- `POST /api/mirror/session` → create a `MirrorSession { sid, ownerAgent, cwd, createdAt, token, transcript:[] }`; returns `{mirrorUrl: /mirror/{sid}#token=...}`.
- `WS /ws/mirror/{sid}` → bidirectional:
  - mirror-agent → hub: `MirrorEventFrame` (one per hook/JSONL record).
  - hub → mirror-agent: `MirrorInjectFrame` (prompt to inject) or `MirrorControlFrame` (pause/resume/close).
- `GET /api/mirror/{sid}/transcript` → full transcript snapshot (auth-gated).
- `WS /ws/dashboard` already exists; it broadcasts a new `mirror:session_started` / `mirror:event` / `mirror:session_ended` event type. Watchers with the right token subscribe to just their session via a `subscribe` frame.

### 4.2 New frame types (shared/types.ts)

```ts
type MirrorEventKind =
  | "session_start" | "user_prompt" | "tool_call" | "tool_result"
  | "assistant_message" | "notification" | "compact" | "session_end";

interface MirrorEventFrame {
  action: "mirror_event";
  sid: string;
  uuid: string;           // from JSONL or synthesized for hook-only events
  kind: MirrorEventKind;
  ts: number;
  payload: unknown;       // kind-discriminated; see table above
  requestId?: string;
}

interface MirrorInjectFrame {
  event: "mirror_inject";
  sid: string;
  text: string;
  origin: { watcher: string; ts: number };
}
```

### 4.3 Storage

Mirror-session state (transcript + watcher set) lives in a new `MirrorRegistry` — in-memory by default, consistent with current hub philosophy. Optional disk backing via an env flag (`CLAUDE_NET_MIRROR_STORE=./data/mirror`) for users who want to reconnect after a hub restart. Transcript retention default: 24h rolling, configurable.

## 5. Web UI changes

`dashboard.html` grows a second tab/route:

- **`/` — existing dashboard** (agents / teams / message log). Unchanged.
- **`/mirror/{sid}#token=...`** — new single-session view:
  - Header: session id, cwd, owner agent, connection status, last event timestamp, read-only toggle.
  - Transcript pane: renders user bubbles, assistant bubbles, and expandable tool-call cards. Follows the live stream; scroll lock on user scroll-up.
  - Compose box at the bottom (hidden if the viewer only has a read-only token). Textarea + send button + shift-enter for newlines; sends `POST /api/mirror/{sid}/inject` which becomes a `MirrorInjectFrame`.
  - Status strip: "local agent offline" / "injection disabled" / "read-only".
- **`/mirror` — session list.** Shows all your mirror sessions; you can only see the ones whose token you hold (kept in `localStorage` once opened).

No framework; stays with vanilla JS and the existing Tokyonight palette. Rendering the transcript is straightforward — the JSONL schema maps 1:1 to DOM nodes.

## 6. Remote input injection

This is the interesting/hard part. Research confirms: **Claude Code has no supported API to push a prompt into a running interactive session.** The options:

| Option                                    | Pro                         | Con                                           |
|-------------------------------------------|-----------------------------|-----------------------------------------------|
| A. tmux `send-keys`                       | Works today                 | Requires tmux/screen; fragile; visible typing |
| B. Stop local claude, `--resume` remotely | Official                    | Breaks the user's live terminal               |
| C. Headless SDK process alongside         | Clean                       | Not what the user asked for (they want their *current* local session reachable) |
| D. FIFO + `UserPromptSubmit`-style hook   | Fast, no TTY tricks         | Only adds context to the *next* user submit — can't start a turn |
| E. Same-length patch to read a FIFO as stdin when idle | Real injection        | Patching work; risky                         |
| F. Patched "IPC hook" — small patch that polls a FIFO and calls the same internal function the REPL uses to submit a prompt | Best behavior | Must find a stable anchor; redo per release |

Recommended two-tier rollout:

- **Phase 1 (ship first): Option A with fallback B.**
  - If the local session runs inside tmux (we detect `$TMUX`), inject via `tmux send-keys -t <target> -- "$prompt" Enter`. The launcher opts users into tmux by default (`claude-channels` can wrap in a detached tmux session named `claude-<pid>` transparently — user still sees the same terminal because we attach immediately). This is the only injection path that doesn't disturb the live REPL.
  - If not in tmux, the compose box submits "Inject disabled (not in tmux). Pause session?" — optional consent dialog to stop the local claude and resume headless on the hub (Option B). This is a heavy-handed hand-off, only done on explicit user click.

- **Phase 2 (nicer, opt-in): Option F.**
  - Use the existing patcher approach (same-length byte patches) to add a single patch: before showing the next REPL prompt, call the submit function with any content waiting in `/tmp/claude-net/inject-<pid>.fifo`. The patcher guide already documents how to find stable anchors (`tengu_*` statsig names, function entry strings). We identify the "enter submit" path once and maintain it like the other 5 patches. Shipped behind `mirror.injection: "patch"` opt-in until it has a release or two of proof.
  - When this ships, **no tmux requirement**, no visible keystroke simulation, injection latency ≈ 0.

Both paths re-use the mirror-agent as the inject receiver so the web UI only ever talks to one interface.

## 7. Activation UX

Goal: "transparent" = no CLI flags, no per-session ritual.

Three activation switches, precedence top-down:

1. **Env var** `CLAUDE_NET_MIRROR=1` (or `=watch-only`) — picked up by `claude-channels` at launch; patches the ephemeral settings used by the patched binary to include the mirror hooks.
2. **Setting in `~/.claude/settings.json`**:
   ```json
   { "claudeNet": { "mirror": { "enabled": true, "injection": "tmux" } } }
   ```
   `claude-channels` reads this and injects the hook block into the per-invocation settings.
3. **Slash command** `/mirror on|off|status|url` — implemented as an MCP tool on the claude-net plugin:
   - `/mirror on` → plugin asks the mirror-agent to register the current session; prints the URL + a truncated token. The hooks are already installed; they just start being honored because a `MirrorSession` now exists hub-side.
   - `/mirror url` → prints the URL again.
   - `/mirror off` → closes the mirror session; hub retains transcript for retention window.
   - `/mirror status` → connection state, watcher count, last event age.

The "transparent" flow: the user adds `"mirror.enabled": true` once in settings, and from that point on every new claude session is reachable; `/mirror url` when they want the link.

## 8. Security model

The current claude-net trust boundary is "whoever can reach the hub, trusted." Mirror-session leaks *content* rather than just coordination traffic, so we tighten the model.

### 8.1 Per-session mirror tokens

- On `POST /api/mirror/session`, hub generates a 128-bit random `token`. The URL form `/mirror/{sid}#token=...` puts it in the fragment so it's never sent to the server in HTTP logs or Referer headers.
- All `/api/mirror/{sid}/*` endpoints and the `/ws/mirror/{sid}` socket require `Authorization: Bearer <token>` (or `?t=<token>` for the WS subprotocol).
- Tokens are typed: `owner` (read+inject) and `reader` (read-only). Owner can mint reader tokens from `/mirror on`.
- Tokens revocable via `/mirror off` or `/mirror revoke`.

### 8.2 Origin binding

- A session's `ownerAgent` is pinned to the claude-net agent name (`session:user@host`) that first called `POST /api/mirror/session`. Subsequent events on `/ws/mirror/{sid}` must come over the *same* plugin WS identity. Prevents another agent on the LAN from hijacking the stream.

### 8.3 Redaction hook

- Mirror-agent pipes every event through an optional redactor before shipping to the hub. Default redactor is a config file of regexes (`.ssh/.*`, `AWS[A-Z0-9]{16,}`, etc.). Users can add project-specific patterns in `.claude-net/redact.json`. Matched spans become `«REDACTED:KIND»`.
- Encourages users to set this up, but on by default only for a small starter list so we don't advertise false confidence.

### 8.4 Transport

- All hub ↔ mirror-agent traffic goes over WSS if the hub is configured with TLS (there's an optional `CLAUDE_NET_TLS=` path). On plain HTTP (LAN mode), we rely on the network trust boundary.
- Tokens are high-entropy and single-session, so accidental exposure is bounded.

### 8.5 Local surface

- Mirror-agent listens only on `127.0.0.1`, with a random ephemeral port and a filesystem-permissioned socket path file (`/tmp/claude-net/mirror-<uid>.sock` alternative for UNIX-socket-only mode).
- Hook runner and agent communicate over the same loopback, no system-wide exposure.

### 8.6 Injection consent

- First remote inject in a session triggers a terminal-side confirmation: a `Notification` hook prints `[mirror] inject from <watcher agent name> — accept? (hit enter to accept, ctrl-c to reject within 5s)`. After acceptance, injection is allowed for the rest of the session unless `/mirror consent reset` is called.
- Default behavior is `ask-first-per-session`; can be set to `always`, `never`, or `ask-every-time` in settings.

### 8.7 Threat model summary

| Attacker                         | Mitigation                                          |
|----------------------------------|-----------------------------------------------------|
| Passive LAN observer             | URL token in fragment; WSS if configured            |
| LAN peer guessing session URLs   | 128-bit token; sid alone is useless                 |
| Malicious second agent on hub    | Owner pinning; watcher tokens don't authorize inject|
| Hub admin reading transcripts    | Explicit — documented trust on hub host             |
| Process on local box             | Loopback bind + fs perms                            |
| Hostile content in transcript    | Redactor for known-bad patterns                     |
| Accidental persistence           | In-memory default; disk store opt-in                |

## 9. Performance analysis

Hot path on every turn (worst case, before any hub/network involvement):

1. `UserPromptSubmit` hook fires. Claude runs `claude-net-mirror-push`.
2. Script does `curl -m 0.05 -X POST --data-binary @- http://127.0.0.1:$P/hook`. Localhost TCP connect + write + close: typically 300–800µs on Linux.
3. mirror-agent buffers event in a ring queue; returns 202.
4. Hook exits 0. Total add to turn latency: **sub-millisecond, loopback-bounded.**

If the mirror-agent is down or slow:
- The `curl -m 0.05` caps exposure at 50ms per hook, and we retry at most once.
- If network to the hub is slow, the mirror-agent owns the backpressure and drops events on the ring, never claude.

Memory: transcript is a reference to the JSONL the agent already maintains — mirror-agent holds only an in-flight buffer (~1–2MB).

### 9.1 Measurable SLOs

- p99 added latency per turn on the local claude: < 2ms (loopback only).
- p99 event delivery to hub (LAN): < 50ms.
- p99 event delivery to web UI (LAN): < 100ms end-to-end.
- Mirror-agent RSS: < 30MB idle, < 60MB with one active session.

Measure via: (a) hook wrapper records its own start/end and logs > p95 to a local file; (b) hub records ingress→broadcast time per event.

## 10. Phased implementation

Each phase ends with a shippable increment. Keeps scope honest.

### Phase M0 — Scaffolding (≈ 0.5 day)
- `src/shared/types.ts`: add `MirrorEventFrame`, `MirrorInjectFrame`, `MirrorEventKind`, `MirrorSession`, `MirrorToken`.
- New doc `docs/MIRROR_SESSION_SPEC.md` (this file, promoted).

### Phase M1 — Outbound (read-only mirror) (≈ 2–3 days)
- `src/hub/mirror.ts` — `MirrorRegistry`, token issuance, `POST /api/mirror/session`, `WS /ws/mirror/{sid}`, transcript ring.
- `src/hub/mirror-ui.html` (or extended dashboard.html) — single-session view rendering user/assistant/tool cards.
- `bin/claude-net-mirror-push` — hook forwarder.
- `src/mirror-agent/agent.ts` — daemon: loopback listener, hub WS, JSONL reconciliation, session lifecycle.
- `/mirror on|off|url|status` added to plugin as an MCP tool.
- Settings merge helper in `bin/claude-channels` that injects hooks into the ephemeral settings when `claudeNet.mirror.enabled`.
- Tests: integration test that spawns a hub, a fake claude emitting hook payloads, and a WS watcher, and asserts end-to-end event order.

Exit criteria: with `mirror.enabled = true`, every claude session auto-streams to the hub; a browser at `/mirror/<sid>#...` sees the transcript updating live.

### Phase M2 — Injection via tmux (≈ 1–2 days)
- Launcher auto-wraps claude in a detached tmux session when mirror is enabled and tmux is present.
- Web UI compose box; `POST /api/mirror/{sid}/inject` → `MirrorInjectFrame` → mirror-agent → `tmux send-keys`.
- Injection consent prompt via `Notification` hook.

Exit criteria: from the web UI, I can type a message and see it enter the local claude as if I'd typed it.

### Phase M3 — Hardening (≈ 2 days)
- Redactor pipeline (config, regex library, `.claude-net/redact.json`).
- Token types (owner/reader) + `/mirror share --readonly`.
- Optional disk persistence for the hub (`CLAUDE_NET_MIRROR_STORE`).
- WSS/TLS story if the hub runs with TLS.
- Rate limits on `/api/mirror/{sid}/inject`.

### Phase M4 — Patched IPC injection (opt-in, ≈ 3–5 days, research)
- Anchor hunt in the bun-embedded JS: find the "submit prompt from REPL" path.
- Design a same-length patch that, on idle REPL tick, reads and submits any pending prompt from the FIFO.
- Gate behind `claudeNet.mirror.injection = "patch"`; keep tmux as default.
- Add the patch to `bin/patch-binary.py` and document in `CLAUDE_CODE_PATCHING_GUIDE.md`.

Exit criteria: injection works without tmux; verified on current and previous Claude Code release.

## 11. Failure modes & recovery

| Failure                                     | Behavior                                                                                                   |
|---------------------------------------------|------------------------------------------------------------------------------------------------------------|
| Mirror-agent crashed mid-session            | Hooks time out fast (50ms). Launcher restarts the agent on next hook; JSONL tail replays everything missed via `uuid` dedupe. |
| Hub unreachable                             | Mirror-agent buffers last N events; web UI shows "stream paused"; catches up on reconnect.                 |
| Network partition during inject             | Inject frame NACK'd; web UI shows "failed, retry?"                                                         |
| Claude writes partial JSONL line            | Reconciler waits for newline; never parses partial records.                                                |
| Two web watchers on same owner token        | Allowed; both stream; most-recent inject wins.                                                             |
| Claude `/clear` mid-mirror                  | `SessionStart` event with `source: clear` → new `sid` on hub; web UI banners "new session started."        |
| Claude compact                              | `PreCompact`/`PostCompact` hooks render a divider in the UI; no transcript loss (we retain the pre-compact lines). |
| Token leaked in URL                         | Owner can `/mirror revoke` → hub expires token and kicks existing watchers.                                |

## 12. Open questions

- **JSONL fsync**: the researched docs don't confirm synchronous flush. If hook + JSONL are ever out-of-order we'll see it in M1 integration tests; easy to fix with a short "quiet window" before reconciling.
- **Hook install scope**: merging into a user's existing `~/.claude/settings.json` safely. We'll use a namespaced `hooks` block (`claudeNet.mirror.hooks`) that the launcher splices in at invocation time rather than rewriting the user's file.
- **Multi-claude-on-same-host disambiguation**: `inject-<pid>.fifo` and the mirror-agent's per-session registry keyed on `session_id` handle this cleanly.
- **Phase M4 anchor stability**: an early spike to find the REPL-submit path will tell us whether patched injection is realistic or whether we should invest in tmux polish instead.
- **Does the user want a dedicated URL per device**: if yes, we issue separate reader tokens per device and show last-seen timestamps in `/mirror status`.

## 13. Minimal work-breakdown (for future-me)

1. M0 types + this doc promoted (`docs/MIRROR_SESSION_SPEC.md`).
2. `src/hub/mirror.ts` + tests.
3. `src/mirror-agent/agent.ts` + `bin/claude-net-mirror-push`.
4. Dashboard mirror view (can reuse current WS scaffolding).
5. Launcher hook-splicing.
6. Plugin `/mirror` tool (updates MCP tool surface — remember to update `README.md` tools table and `CLAUDE_NET_SPEC.md` FR-6).
7. tmux injection path.
8. Consent + redactor + token types.
9. (Later) M4 patch spike.
