# CHANNEL_LIVENESS — Phase 3: Plugin version reporting and upgrade nudge

**Part of:** `CHANNEL_LIVENESS_PLAN.md`
**Phase:** 3 of 3
**Estimated Time:** 1–1.5 hours (dev) + test
**Branch:** `feature/message-ack`

## Goal

Plugin sends `plugin_version: string` on register (sourced from the MCP `Server({ version })` declaration). Hub compares against `PLUGIN_VERSION_CURRENT` (sourced from `package.json`); on mismatch or missing, the register response includes an `upgrade_hint: string` telling the user how to re-install. Plugin stores the hint in `pendingUpgradeNudge` and surfaces it on the next tool result using the same one-shot attach-to-tool-result pattern as the existing rename and channels-off nudges. Fires exactly once per plugin startup.

## Prerequisites

- [ ] Phase 1 and Phase 2 merged to `feature/message-ack` and green.
- [ ] Read `docs/CHANNEL_LIVENESS_SPEC.md` — FR8.
- [ ] Read `docs/CHANNEL_LIVENESS_PLAN.md`.

## Authoritative spec reference

FR8 in `docs/CHANNEL_LIVENESS_SPEC.md`. Spec wins on ambiguity.

## Files to modify

- `src/shared/types.ts` — `RegisterFrame` gains required `plugin_version: string`; document `RegisterResponseData` shape (`upgrade_hint?: string`).
- `src/hub/ws-plugin.ts` — register handler compares versions, constructs `upgrade_hint` on mismatch, includes it in the response `data`.
- `src/plugin/plugin.ts` — inline type duplication; new module constant `pluginVersion` (single source of truth, used in both `new Server({ version })` and register frame); `pendingUpgradeNudge: string | null`; `attachUpgradeNudgeIfPending(result)`; read `data.upgrade_hint` after successful register.

## Files to create

- `src/hub/version.ts` — exports `PLUGIN_VERSION_CURRENT` (sourced from `package.json` via `resolveJsonModule: true`) and a helper `buildUpgradeHint(hubUrl, observedVersion): string`.

## Test files to extend

- `tests/integration/liveness.test.ts` — add L7, L8, L9.
- `tests/hub/` — add `version.test.ts` for `buildUpgradeHint` output formatting.
- `tests/plugin/plugin.test.ts` — add upgrade-nudge attach/clear behavior.

## Key requirements

1. **`RegisterFrame.plugin_version`: required string.** Plugin sends the same value it declares via `new Server({ name: "claude-net", version: pluginVersion }, ...)`. Keep both in sync by referencing a single module constant.

2. **Hub `PLUGIN_VERSION_CURRENT`:**
   - Sourced from `package.json` at build time. tsconfig.json already has `resolveJsonModule: true` (verified in plan). Use:
     ```
     import pkg from "../../package.json";
     export const PLUGIN_VERSION_CURRENT: string = pkg.version;
     ```
   - If the import-from-json path proves fragile under Bun's module resolution (test this early), fall back to hardcoding and adding a comment to keep it in sync.

3. **Comparison rule:** exact string equality. Any mismatch (older, newer, or missing/undefined) triggers `upgrade_hint`.

4. **Hub URL for hint text:**
   - At register time, the hub has `process.env.CLAUDE_NET_HOST` and the listen port available. Construct the hint URL as: prefer `CLAUDE_NET_HOST` if set (add `http://` if no scheme), otherwise fall back to `"http://localhost:" + port`.
   - Do NOT attempt to use `resolveCanonicalHubUrl` from `hub-url.ts` here — that helper requires a `request` context and we're on the WS register path. The env-var fallback is fine for the hint text (it's informational; if the URL is wrong the user can correct locally).
   - Expose the port to the register handler by threading it through the hub-construction path, or store it in a module variable at `app.listen()` time.

5. **`buildUpgradeHint(hubUrl, observedVersion)` format:**
   ```
   `claude-net: your plugin (version ${observedVersion || "unknown"}) is out of date. The hub is on ${PLUGIN_VERSION_CURRENT}. To upgrade, re-run the install script: curl -fsSL ${hubUrl}/setup | bash`
   ```
   Adjust wording as needed — this is the developer-facing text that agents / users will read. Keep it under ~300 chars.

6. **Plugin-side plumbing:**
   - Add `const pluginVersion = "0.1.0"` at the top of `plugin.ts` (or equivalent single-source constant). Use in the `Server` constructor AND in the register frame construction.
   - `let pendingUpgradeNudge: string | null = null;`
   - After successful register response (`request({ action: "register", ... }).then(data => ...)` branch in `autoRegisterWithRetry` or `maybeSendRegister`), read `data.upgrade_hint` and set `pendingUpgradeNudge` if present.
   - `function attachUpgradeNudgeIfPending<T>(result: T): T { ... }` — parallel to `attachRenameNudgeIfPending` (plugin.ts:619–630). Appends to result content, clears on first fire.
   - Chain with other nudge-attachers in `handleToolCall`: apply rename, channels-off, and upgrade nudges in sequence (each clears its own slot).

7. **Once-per-startup behavior:** `pendingUpgradeNudge` is set at most once (by the register response). Cleared on first tool-result attach. Never re-populated by anything else, including the FR9 (MESSAGE_ACK) silent re-register path (irrelevant for this spec, but mentioning for robustness).

## Integration points

- **`package.json` version field** — currently `"0.1.0"`. This is the source of truth.
- **`Server({ version })` declaration in plugin.ts** — currently `"0.1.0"` hardcoded. Refactor to the shared `pluginVersion` constant.
- **Existing nudge pattern** — `attachRenameNudgeIfPending` (plugin.ts:619–630) and the Phase-2-added `attachChannelsOffNudgeIfPending` are the templates.
- **Register-response handling** — the plugin's `autoRegisterWithRetry` helper (plugin.ts:383 area, PR-#1 code) is where register response data is consumed. Add `data.upgrade_hint` reading there.

## Implementation guidance

Recommended sequence:

1. **Types:** update `src/shared/types.ts` with `plugin_version` on RegisterFrame and document the register response shape. Mirror in plugin.ts inline types.

2. **Hub version module (new):**
   - Create `src/hub/version.ts` with `PLUGIN_VERSION_CURRENT` and `buildUpgradeHint`.
   - Sanity-check: `import pkg from "../../package.json"` — if TS complains despite `resolveJsonModule`, try `import pkg from "../../package.json" with { type: "json" }` (ESNext). If both fail under Bun, hardcode with a comment pointing at package.json.
   - Unit test `buildUpgradeHint`.

3. **Hub register handler update:** at the top of the register `case`, after successful `registry.register` call, compare `data.plugin_version` against `PLUGIN_VERSION_CURRENT`; if mismatch, set `upgrade_hint` and include in the `sendResponse` data.

4. **Plugin constants:** refactor `pluginVersion` as a module-level const; use in `Server` constructor; use in register frame payload.

5. **Plugin nudge:** add `pendingUpgradeNudge` state, `attachUpgradeNudgeIfPending` helper, chain into `handleToolCall` and `whoami` alongside existing attachers. Read `upgrade_hint` from register response data.

6. **Tests:** add `version.test.ts`; extend plugin tests; add integration tests L7–L9.

## Testing strategy

### Integration tests (`tests/integration/liveness.test.ts`)

**L7 — Version match, no hint:**
- Create hub (uses real `PLUGIN_VERSION_CURRENT` from package.json).
- Connect a plugin-like WS client; send register with `plugin_version: <same as PLUGIN_VERSION_CURRENT>`.
- Assert: register response's `data.upgrade_hint` is absent (or undefined).
- Plugin behavior (mock or test-in-plugin-test): subsequent tool results do NOT contain upgrade nudge text.

**L8 — Version mismatch, hint once:**
- Hub on real version; plugin-like WS client registers with `plugin_version: "0.0.1"` (older).
- Assert: response `data.upgrade_hint` contains expected text (version numbers + hub URL + curl command).
- In a plugin-level test: simulate the register response → `pendingUpgradeNudge` is set → first tool-call result contains the hint text → second tool-call result does NOT (one-shot behavior verified).

**L9 — Missing `plugin_version` field, hint with `unknown`:**
- Send a register frame that omits `plugin_version` entirely (simulated old plugin).
- Assert: response `data.upgrade_hint` is present, the version text reads `"unknown"` (per `buildUpgradeHint` signature), the rest of the hint is well-formed.

### Unit tests

- `tests/hub/version.test.ts` — `buildUpgradeHint("http://hub:4815", "0.0.1")` returns the expected string with both versions, correct URL, and the install command. `buildUpgradeHint("http://hub:4815", undefined)` or `("", undefined)` uses `"unknown"` for the observed version.
- `tests/plugin/plugin.test.ts` — `pendingUpgradeNudge` starts null; after register response sets `upgrade_hint`, it's populated; `attachUpgradeNudgeIfPending` appends once and clears. Chained nudges fire independently.

### Manual smoke

- Bump plugin version locally to `"0.0.1"`, connect, observe the nudge appears on whoami result.
- Restore plugin version, reconnect, observe no nudge.

## Dev report artifact

Save to `docs/CHANNEL_LIVENESS_PHASE_3_DEV_REPORT.md`. Include:

- Files changed + one-line summaries.
- Did `import pkg from "../../package.json"` work directly or need a fallback?
- `buildUpgradeHint` text form (paste the output for a sample mismatch).
- Test + lint status.
- Open questions.

## Agent review gate

**No separate review gate.** This is mechanical work paralleling an existing pattern (`attachRenameNudgeIfPending`). The scrum-tester pass is sufficient.

Orchestrator may still trigger `principal-code-reviewer` at their discretion, but the plan does not mandate it.

## Success criteria

- [ ] `RegisterFrame.plugin_version` carried on every register.
- [ ] `PLUGIN_VERSION_CURRENT` sourced from package.json.
- [ ] Register-response `data.upgrade_hint` absent on match, present and well-formed on mismatch or missing.
- [ ] Plugin surfaces the nudge on exactly one tool result after a mismatch register.
- [ ] Integration tests L7–L9 pass.
- [ ] Unit tests pass.
- [ ] No regressions in full `bun test`.
- [ ] `bun run lint` clean.
- [ ] Dev report committed.

## Dependencies

- Internal: Phase 2 (register frame already modified there; Phase 3 adds another required field to the same frame — keep changes additive, no rename of existing fields).
- External: none.

## Risks and mitigations

- **Risk:** JSON import from package.json fails under Bun's module resolution. **Mitigation:** fallback plan documented — hardcode with comment. Test early.
- **Risk:** Hardcoded hub URL fallback (`"http://localhost:PORT"`) is wrong for remote users. **Mitigation:** accept the imprecision; the nudge is informational, not authoritative. `CLAUDE_NET_HOST` env var handles the common remote case.
- **Risk:** Nudge text is too wordy and bloats tool results. **Mitigation:** keep under ~300 chars; verify manually.

## Next steps

After this phase is merge-ready:

1. Orchestrator commits the phase.
2. Runs full `bun test` across the branch.
3. Runs `bun run lint` and `bun run fmt`.
4. Pushes branch, opens PR against main (or squash-plan, depending on integration strategy at that point).

No further phases — spec is fully implemented.
