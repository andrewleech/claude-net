# Mirror-Session — Phase M0: Types & Scaffolding

**Part of:** `MIRROR_SESSION_IMPLEMENTATION_PLAN.md`
**Phase:** 0 of 4 (plus this scaffolding phase)
**Estimated Time:** 2–4 hours

## Goal

Land the shared type definitions, naming convention, and documentation stubs that later phases depend on. No behavioural changes in this phase — all additions are exported but unused until Phase M1 wires them in. This phase exists so that M1 can start with a stable, reviewed contract rather than inventing types mid-implementation.

## Prerequisites

- [ ] Spec read: `docs/MIRROR_SESSION_PLAN.md`
- [ ] Main plan read: `docs/MIRROR_SESSION_IMPLEMENTATION_PLAN.md`
- [ ] Local `bun install` successful, `bun test` green on `main`

## Codebase Patterns to Follow

**Discriminated unions for frames** — `src/shared/types.ts` already exports `PluginFrame` (action-discriminated) and `HubFrame` / `DashboardEvent` (event-discriminated). Add mirror frames to the *existing* unions rather than creating parallel top-level unions.

**Snake_case for wire fields, camelCase for internal types.** Existing code mixes both (`requestId` vs `message_id`); for new types, follow the rule: anything serialized to JSON across the wire is snake_case (`session_id`, `mirror_token`, `reply_to`), anything internal-TS-only stays camelCase (`ownerAgent`, `createdAt` on the in-memory `MirrorSession` class). Call out the convention in a top-of-file comment in `src/shared/types.ts`.

**ISO-8601 strings for timestamps** — see `AgentInfo.connectedAt`.

**`type` aliases for unions, `interface` for object shapes** — preserve this style.

## Files to Create

- `docs/MIRROR_SESSION_PHASE_0.md` (this file)
- No new source files. (All additions in this phase are edits to existing files.)

## Files to Modify

- `src/shared/types.ts` — add mirror frame/event types and data models (see "Types to Add").
- `docs/CLAUDE_NET_SPEC.md` — add stub section **FR-8 Mirror Sessions** with the wire-format definitions copied from the new types (short form — detailed behavior lands in M1 phase file, not here).
- `CLAUDE.md` — add `src/hub/mirror.ts` and `src/mirror-agent/` entries to the architecture tree as *planned* locations (with `(planned)` marker). Phase M1 removes the marker.

## Types to Add

Add to `src/shared/types.ts`:

**Mirror event kinds (union literal):**
```
MirrorEventKind =
  | "session_start" | "session_end"
  | "user_prompt" | "assistant_message"
  | "tool_call" | "tool_result"
  | "notification" | "compact"
```

**Per-kind payload types** — one object interface per kind. Each carries the fields that hook or JSONL reconciliation will surface. User-prompt payload: `{ prompt: string, cwd: string }`. Assistant-message payload: `{ text: string, stop_reason: string }`. Tool-call/result payloads: `{ tool_use_id: string, tool_name: string, input?: unknown, response?: unknown }`. Session-start: `{ source: "startup"|"resume"|"clear"|"compact", transcript_path: string, cwd: string }`. Keep payloads minimal; refinements land in M1.

**Frame types** — extend the existing unions:
- `MirrorEventFrame` (plugin→hub, `action: "mirror_event"`) — fields: `action`, `sid`, `uuid`, `kind`, `ts` (number, ms), `payload` (kind-discriminated), optional `requestId`. Join `PluginFrame` union.
- `MirrorInjectFrame` (hub→mirror-agent, `event: "mirror_inject"`) — fields: `event`, `sid`, `text`, `origin: { watcher: string; ts: number }`. Join `HubFrame` union.
- `MirrorControlFrame` (hub→mirror-agent, `event: "mirror_control"`) — fields: `event`, `sid`, `op: "pause" | "resume" | "close"`. Join `HubFrame` union.
- `MirrorDashboardEvent` — new dashboard events: `"mirror:session_started"`, `"mirror:session_ended"`, `"mirror:event"`, `"mirror:watcher_joined"`, `"mirror:watcher_left"`. Join `DashboardEvent` union.

**Data models (hub-internal):**
- `MirrorSessionSummary` (API response): `{ sid, owner_agent, cwd, created_at, last_event_at, watcher_count, transcript_len }`.
- `MirrorToken`: `{ value: string, type: "owner" | "reader", sid: string, created_at: string, revoked_at?: string }`. (Storage-only — tokens are never serialized to dashboard clients with the `value` field.)

Do **not** add the hub-internal `MirrorSession` class type here — it's implementation detail landing in Phase M1's `src/hub/mirror.ts`.

## Key Requirements

1. All new types exported from `src/shared/types.ts`.
2. Top-of-file comment in `src/shared/types.ts` documenting the snake_case (wire) / camelCase (internal) convention.
3. Biome clean (`bun run lint`).
4. `bun run build` / `bun test` pass — no behavioural changes, no new tests yet.
5. Spec doc stub (FR-8) lists the kinds and frame shapes; it is a *stub*, not the final spec.

## Integration Points

- The new types are imported by (future) `src/hub/mirror.ts`, `src/mirror-agent/agent.ts`, and potentially `src/plugin/plugin.ts` (which will need to duplicate types inline because of the single-file constraint — document this in the file comment: "if you add a mirror type used by the plugin, mirror the definition in `src/plugin/plugin.ts` too").

## Implementation Guidance

**Solution Quality Standards:**
- Implement general solutions that work for all valid inputs, not just test cases.
- Use standard tools directly; avoid creating helper scripts as workarounds.
- If requirements are unclear or tests appear incorrect, note this for the implementer to raise with the user.

Keep this phase small. Resist the temptation to pre-add classes, registries, or routes; those belong in their respective phases. The only artefacts this phase produces are:
- Type definitions (wire contract).
- A short docs stub (so reviewers can see the wire contract without reading `.ts`).
- A `(planned)` marker in `CLAUDE.md`'s architecture section.

When adding to existing `PluginFrame` / `HubFrame` / `DashboardEvent` unions, ensure the discriminator narrowing still works — test with a small type-only sample if unsure.

## Testing Strategy

**What to Test:**
- Type-only. No runtime tests in this phase.

**How to Test:**
- `bun run lint` — Biome passes.
- `bun tsc --noEmit` (or `bun run build`) — no compile errors.
- `bun test` — existing tests still pass.
- A throwaway scratch file (not committed) can exhaustively narrow `PluginFrame` on `action` to confirm the new `mirror_event` arm is included.

**Success Criteria:**
- [ ] `bun tsc --noEmit` green.
- [ ] `bun run lint` green.
- [ ] `bun test` green (no new tests added, existing tests unaffected).
- [ ] FR-8 stub appears in `docs/CLAUDE_NET_SPEC.md`.
- [ ] `CLAUDE.md` architecture tree mentions planned mirror files with `(planned)`.

## Dependencies

**External:** none.
**Internal:** none new; only additions to `src/shared/types.ts`.

## Risks and Mitigations

- **Risk:** Bikeshed on naming conventions stalls progress.
  - **Mitigation:** The convention is decided in this phase (snake_case wire / camelCase internal). Landed together with the types so M1+ don't re-litigate.
- **Risk:** Payload shape is wrong; M1 needs to change types.
  - **Mitigation:** Payload types are intentionally minimal (just the fields the hook/JSONL guaranteedly provides). Extensions in M1 are additive.

## Next Steps

After completing this phase:
1. Run the testing strategy above.
2. Commit on a feature branch (`feat/mirror-m0-types`). The commit should be small and easy to review.
3. Proceed to `MIRROR_SESSION_PHASE_1.md`.
