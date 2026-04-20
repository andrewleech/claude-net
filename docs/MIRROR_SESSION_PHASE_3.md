# Mirror-Session — Phase M3: Security & Persistence Hardening

**Part of:** `MIRROR_SESSION_IMPLEMENTATION_PLAN.md`
**Phase:** 3 of 4
**Estimated Time:** 2 days

## Goal

Harden the M1+M2 feature for general use: split tokens into owner / reader roles, ship an optional redactor in the mirror-agent, enable opt-in disk persistence for transcripts, add WSS/TLS support when the hub is configured with it, rate-limit mutating endpoints, and tighten the local-surface permissions. Nothing new in *user-facing behavior*; this phase is about closing security and operational gaps so the feature is safe outside a single-dev Tailnet.

## Prerequisites

- [ ] Phases M1 and M2 complete and merged.
- [ ] Spec sections 8 ("Security model") and 4.3 ("Storage") re-read.

## Codebase Patterns to Follow

- **Token types via discriminated union** — `MirrorToken { value, type: "owner" | "reader", ... }` from M0. Tokens are looked up by value (hex string → entry) in `MirrorRegistry`.
- **Config via env vars** — existing pattern (`CLAUDE_NET_HOST`, `CLAUDE_NET_PORT`). Add `CLAUDE_NET_MIRROR_STORE`, `CLAUDE_NET_TLS_CERT`, `CLAUDE_NET_TLS_KEY`, `CLAUDE_NET_MIRROR_INJECT_RPM`.
- **Result-tuple** return values for validation in `MirrorRegistry.validateToken()`.
- **Stderr-prefixed** logging for redactor hits (privacy-preserving — log counts, not matches).

## Files to Create

- `src/mirror-agent/redactor.ts` — regex-based redactor. Loads `~/.claude-net/redact.json` (per-user) + optional per-project `.claude-net/redact.json`. Applies before events leave the host.
- `src/mirror-agent/redact-defaults.ts` — small starter regex set (AWS access key, GitHub PAT, generic PEM header, `ssh-rsa` / `ssh-ed25519` public-key body suffixes, OpenAI / Anthropic key prefixes).
- `src/hub/mirror-store.ts` — pluggable transcript-persistence backend. Interface `MirrorStore { save(sid, events), load(sid), list(), close() }`. Two implementations: `NullStore` (default) and `FileStore` (JSONL under `CLAUDE_NET_MIRROR_STORE`).
- `src/hub/rate-limit.ts` — tiny token-bucket per (sid, ip) used on inject and on `POST /api/mirror/session`.
- `tests/mirror-agent/redactor.test.ts` — correctness on the default regex set plus custom extensions.
- `tests/hub/mirror-tokens.test.ts` — owner/reader role enforcement, revoke, expired.
- `tests/hub/mirror-store.test.ts` — FileStore save/load/replay.
- `tests/integration/mirror-tls.test.ts` — start hub with cert/key, confirm mirror-agent connects via `wss://`.

## Files to Modify

- `src/hub/mirror.ts` — split token issuance into owner vs reader; add `POST /api/mirror/{sid}/share` (owner-only) to mint reader tokens; add `POST /api/mirror/{sid}/revoke` (owner-only) with optional `{ token }`. Integrate `MirrorStore`: on every transcript change, async `store.save(sid, deltaEvents)`; on session open, if store has history for this sid (after restart), replay to new watchers. Integrate `rate-limit.ts` on inject and session-creation endpoints.
- `src/hub/index.ts` — if `CLAUDE_NET_TLS_CERT` and `CLAUDE_NET_TLS_KEY` are set, bind Elysia with TLS (Bun supports this via `tls` option on `serve`); hub reports `wss://` in generated mirror URLs. If unset, preserve current behavior.
- `src/hub/setup.ts` — setup script updates: generate `https://` URLs when TLS is enabled; install a per-user `~/.claude-net/redact.json` starter if missing.
- `src/mirror-agent/agent.ts` — wire redactor into the event pipeline (`hook-ingest.ts` → redactor → hub WS). Watch redaction config files with `fs.watch` for live reload.
- `src/hub/dashboard.html` — add a "Share" button on `/mirror/{sid}` for owners (prompts `read-only` checkbox, returns reader URL to copy). Show token-revoke control.
- `src/plugin/plugin.ts` — new tools: `mirror_share` (owner → reader token), `mirror_revoke` (by token).
- `docs/CLAUDE_NET_SPEC.md` — document the token roles, redactor config format, persistence flag, TLS env vars.
- `README.md` — add a short security section linking the config knobs.

## Key Requirements

1. **Token roles.** Every token has `type: "owner" | "reader"`. The single M1 token is implicitly an owner. Reader tokens are minted by owners via `POST /api/mirror/{sid}/share`. Reader tokens allow `GET /transcript`, `WS /ws/mirror/{sid}` read subscription, but NOT `POST /inject` or `POST /share` or `POST /revoke` or `POST /close`.
2. **Token entropy.** 128 bits minimum (32 hex chars). Generated with `crypto.randomBytes(16).toString('hex')`.
3. **Token lifecycle.** Tokens persist for the session's lifetime. `POST /api/mirror/{sid}/revoke` expires a specific token; revoked WS watchers are kicked immediately. Closing a session revokes all tokens.
4. **URL-fragment delivery.** The generated URL embeds the token in the fragment (`#token=...`), never the query string. Mirror view JS reads `location.hash` and converts to the WS query param `?t=...` for the connection upgrade only.
5. **Redactor pipeline.**
   - Config: array of `{ name, pattern, flags?, replacement?: "«REDACTED:name»" }` objects.
   - Default on, loaded from `redact-defaults.ts` plus the user config file.
   - Applied in the mirror-agent — never the hub — so redaction happens before anything leaves the host.
   - Redacts event payload string fields (prompt, assistant text, tool_input stringified, tool_response stringified). Does NOT touch tool names, timestamps, or UUIDs.
   - Logs aggregate counters per regex (`[claude-net/mirror] redacted 3× AWSKey`), never the match content.
6. **Persistence (opt-in).**
   - Enabled by `CLAUDE_NET_MIRROR_STORE=/path/to/dir`.
   - `FileStore` writes one `<sid>.jsonl` per session, appends as events arrive, with atomic rename on batch.
   - Retention window default 24h; cleanup task runs hourly; configurable via `CLAUDE_NET_MIRROR_RETENTION_HOURS`.
   - On hub restart, `MirrorRegistry` does NOT auto-restore sessions; watchers must hit a new `GET /api/mirror/archive/{sid}?t=<token>` endpoint to fetch the archived transcript (read-only, owner token only, post-mortem use). Live sessions must be re-opened by a fresh `POST /api/mirror/session` from the mirror-agent.
7. **TLS (opt-in).**
   - `CLAUDE_NET_TLS_CERT` + `CLAUDE_NET_TLS_KEY` switch Elysia to TLS binding.
   - Mirror URLs change to `https://` / `wss://`.
   - Mirror-agent honors `CLAUDE_NET_HUB=https://...` and uses `wss://` automatically.
   - No cert-pinning in this phase — relies on standard TLS trust.
8. **Rate limiting.**
   - `POST /api/mirror/session` — 30 per 5 minutes per remote IP.
   - `POST /api/mirror/{sid}/inject` — default 20 per minute per session; configurable via `CLAUDE_NET_MIRROR_INJECT_RPM`.
   - On breach, respond `429` with `Retry-After`.
9. **Local surface tightening.**
   - Mirror-agent bind explicitly to `127.0.0.1` (not `0.0.0.0`). Refuse to start if only `0.0.0.0` is available.
   - Port file `/tmp/claude-net/mirror-agent-<uid>.port` has mode `0600`.
   - Consider adding a UNIX-socket alternative (`/tmp/claude-net/mirror-agent-<uid>.sock`) behind an opt-in flag for users who want no loopback TCP at all.

## Integration Points

- `MirrorStore` backs `MirrorRegistry.recordEvent()` transparently. In-memory ring remains authoritative for live watchers; store is a write-through.
- Redactor sits between `hook-ingest.ts` and `hub-client.ts` — it must run before anything hits the network.
- Tokens now thread through every mirror route; extract a `requireToken(type)` middleware so the logic is centralized.
- Rate limits are cross-cutting: share the token-bucket implementation between mirror routes and any future hub routes that need rate limiting.

## Implementation Guidance

**Solution Quality Standards:**
- Implement general solutions that work for all valid inputs, not just test cases.
- Use standard tools directly; avoid creating helper scripts as workarounds.
- If requirements are unclear or tests appear incorrect, note this for the implementer to raise with the user.

**Redactor performance.** Compile regexes once at load time. Run them over a merged string field only when the field is non-empty. Measure redactor overhead on a 64 KB payload — target < 1ms. If measured > 5ms, consider lazy redaction or streaming matching.

**FileStore durability.** Write via `O_APPEND`, flush with `fdatasync` at most every N events (batch size N, configurable default 50). Explicit fsync on session close. Stores are not required to survive machine crashes precisely — this is convenience, not audit.

**TLS dev ergonomics.** Document how to generate a self-signed cert for Tailnet dev (`mkcert` integration note in README). Mirror-agent should print a helpful warning if it sees a self-signed cert and rejects it (suggest `NODE_EXTRA_CA_CERTS`).

**Token rotation.** Not in scope for M3. Explicit revoke-and-reissue is the flow.

## Testing Strategy

**What to Test:**

- Redactor: default regex set correctly redacts known-bad formats; custom regex additions loaded; live reload on file change.
- Token roles: reader token returns 403 on all mutating endpoints; owner token works; expired token returns 401; revoked token kicks WS.
- FileStore: events persisted, replayed via archive endpoint, retention cleanup removes old sessions.
- TLS: hub with cert serves `https://`; mirror-agent connects via `wss://`; URL generator emits `https://` scheme.
- Rate limit: burst exceeding limit returns 429 with `Retry-After`; window resets after the period.
- Security surface: mirror-agent refuses to start on non-loopback bind; port file is 0600.

**How to Test:**

- `bun test tests/mirror-agent/redactor.test.ts`, `tests/hub/mirror-tokens.test.ts`, `tests/hub/mirror-store.test.ts`, `tests/integration/mirror-tls.test.ts`.
- Manual: self-signed cert, real local hub, real mirror-agent — verify green padlock behavior and connectivity.
- Manual: paste a synthetic API key into a prompt, confirm the web view shows `«REDACTED:…»`.
- Manual: owner URL → "Share" button → reader URL → try inject as reader → denied.

**Success Criteria:**

- [ ] Reader tokens cannot mutate; owner tokens can.
- [ ] Redactor hides default-list secrets from the web view without needing user config.
- [ ] `CLAUDE_NET_MIRROR_STORE` enables durable transcripts and archive retrieval.
- [ ] `CLAUDE_NET_TLS_CERT`/`KEY` switch the hub to TLS and mirror-agent connects over `wss://`.
- [ ] Rate-limit 429 returned after breach; normal traffic unaffected.
- [ ] All new tests green; Biome green.

## Dependencies

**External:** none new required for runtime. Bun's built-in `tls` option handles certs.

**Internal:** Phases M1 + M2 (registry, agent, endpoints, web view).

## Risks and Mitigations

- **Risk:** Redactor over-redacts and obscures legitimate content (e.g., `AWS` substring in docs).
  - **Mitigation:** Default regexes are tight; users can disable specific defaults via config; each redaction logs a counter so over-redaction is visible.
- **Risk:** Redactor misses novel secret formats.
  - **Mitigation:** Documented as best-effort; redaction is NOT a compliance control. If users need a stricter guarantee, disable mirror for that session.
- **Risk:** FileStore corrupts the JSONL on crash.
  - **Mitigation:** Append-only + periodic fsync; corrupt tail is truncated on next open with a warning.
- **Risk:** TLS cert renewal forgotten → hub silently stops working.
  - **Mitigation:** Hub logs cert expiry at startup; dashboard footer shows days-to-expiry if TLS enabled.
- **Risk:** Rate limits trip legitimate automation.
  - **Mitigation:** Configurable; defaults are generous; 429 response is clear.

## Next Steps

After completing this phase:
1. Run the testing strategy and verify all success criteria.
2. Commit on `feat/mirror-m3-hardening`.
3. Consider this the stable release — tag `v<current>+mirror.1`.
4. Optionally proceed to `MIRROR_SESSION_PHASE_4.md` if the tmux injection constraint becomes a pain point.
