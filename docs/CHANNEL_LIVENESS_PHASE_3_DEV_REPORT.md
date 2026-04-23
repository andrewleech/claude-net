# CHANNEL_LIVENESS Phase 3 — Dev Report

**Phase:** 3 of 3 (plugin version reporting + upgrade nudge)
**Phase file:** `docs/CHANNEL_LIVENESS_PHASE_3.md`
**Spec:** `docs/CHANNEL_LIVENESS_SPEC.md` FR8
**Branch:** `feature/message-ack`

## Files changed

### Source

- `src/shared/types.ts`
  - `RegisterFrame` gains required `plugin_version: string` (FR8).
  - New `RegisterResponseData` interface documents the register-response `data` shape, including optional `upgrade_hint: string`.

- `src/hub/version.ts` — new module.
  - `PLUGIN_VERSION_CURRENT: string` sourced from `package.json` via `import pkg from "../../package.json"`. Bun's `resolveJsonModule: true` (already set in tsconfig) resolved this directly; no fallback needed.
  - `buildUpgradeHint(hubUrl, observedVersion)` builds the nudge text. Uses `"unknown"` for any falsy/missing `observedVersion`.

- `src/hub/ws-plugin.ts`
  - Imports `PLUGIN_VERSION_CURRENT`, `buildUpgradeHint`, `RegisterResponseData`.
  - New local helper `resolveHubUrlForHint(port)` — prefers `CLAUDE_NET_HOST` env var, adds `http://` scheme if missing, falls back to `http://localhost:<port>`. Deliberately does NOT use `resolveCanonicalHubUrl` (no request context on the WS register path, per phase file guidance).
  - `wsPlugin()` gains an optional `port: number` parameter (defaults to `Number(process.env.CLAUDE_NET_PORT) || 4815`) used only for the hint fallback URL.
  - Register handler now reads `data.plugin_version` (typed-string or undefined), compares against `PLUGIN_VERSION_CURRENT`, and appends `upgrade_hint` to the register response `data` on mismatch or missing. The response data object is now typed as `RegisterResponseData`.

- `src/hub/index.ts`
  - `CreateHubOptions` gains optional `port?: number` — threaded to `wsPlugin` so the upgrade-hint URL fallback reflects the same port the process is (or will be) listening on.
  - Module entrypoint passes `createHub({ port })` so the default runtime behavior matches.

- `src/plugin/plugin.ts`
  - `PLUGIN_VERSION = "0.1.0"` constant gains a prominent comment declaring it the single source of truth for both the MCP `Server({ version })` declaration and the register-frame `plugin_version`. Must be kept in lockstep with `package.json`.
  - `mapToolToFrame("register", …)` adds `plugin_version: PLUGIN_VERSION` to the frame.
  - `autoRegisterWithRetry` adds `plugin_version: PLUGIN_VERSION` on the register frame and now awaits the `data` payload to read `data.upgrade_hint`. If present, stores it on the new module-level `pendingUpgradeNudge`.
  - New module-level `pendingUpgradeNudge: string | null` parallels `pendingChannelsOffNudge` / `pendingRenameNudgeBase`. Never re-populated mid-lifetime — fires at most once per plugin startup.
  - `attachUpgradeNudgeIfPending(result)` — parallel to `attachChannelsOffNudgeIfPending`. Appends to `result.content`, clears the slot on first fire.
  - Exported the new attach helper + test-only `__setPendingUpgradeNudgeForTest` / `__getPendingUpgradeNudgeForTest` so unit tests can exercise attach-once-then-clear without standing up a real hub/WS.
  - Chained `attachUpgradeNudgeIfPending` alongside the existing two nudge-attachers in both `handleToolCall` call sites (whoami branch + general-tool success branch).

### Tests

- `tests/hub/version.test.ts` — new file. Covers:
  - `PLUGIN_VERSION_CURRENT` matches `package.json`'s version field.
  - `buildUpgradeHint` includes both versions, the hub URL + `/setup` suffix, and the curl/bash install command.
  - `"unknown"` substitution for `undefined`, empty-string, and `null` observed versions.
  - Output stays under 300 chars for a representative worst-case URL + pre-release version string.

- `tests/integration/liveness.test.ts` — three new integration tests (L7, L8, L9):
  - **L7** — plugin registers with `plugin_version === PLUGIN_VERSION_CURRENT`; asserts `data.upgrade_hint` is absent.
  - **L8** — plugin registers with `plugin_version: "0.0.1"`; asserts `data.upgrade_hint` is a string containing both `0.0.1` and `PLUGIN_VERSION_CURRENT`, plus `curl -fsSL`, `/setup`, `bash`.
  - **L9** — plugin omits `plugin_version` entirely (simulating an old pre-FR8 plugin). Register still succeeds; `data.upgrade_hint` contains `"unknown"` + `PLUGIN_VERSION_CURRENT` + the install command.
  - New helper `connectAgentWithVersion` — connects, registers with a custom `plugin_version` (or omits it via `null` sentinel), returns the register response verbatim so tests can inspect the `data` payload.

- `tests/plugin/plugin.test.ts`
  - Existing `mapToolToFrame("register", …)` test updated to match the new shape (adds `plugin_version: expect.any(String)`).
  - New test: `register: plugin_version is non-empty` — guards the contract with the hub.
  - New describe block `attachUpgradeNudgeIfPending (FR8)` — four tests covering: no-op when nothing pending, append when pending, clear-after-fire (two consecutive calls, second produces no duplicate), baseline null state. Uses `afterEach` to reset the module state between tests.

## `import pkg from "../../package.json"` verification

Worked out of the box. Sanity check inside the project:

```
$ bun run src/hub/_test-json-import.ts
0.1.0
```

tsconfig already had `resolveJsonModule: true` (verified up front per the phase file's guidance). No need for the `with { type: "json" }` attribute syntax or a hardcoded-constant fallback.

## `buildUpgradeHint` sample output

Mismatch case (`observedVersion: "0.0.1"`, `hubUrl: "http://hub.example:4815"`):

```
claude-net: your plugin (version 0.0.1) is out of date. The hub is on 0.1.0. To upgrade, re-run the install script: curl -fsSL http://hub.example:4815/setup | bash
```

Missing-version case (`observedVersion: undefined`):

```
claude-net: your plugin (version unknown) is out of date. The hub is on 0.1.0. To upgrade, re-run the install script: curl -fsSL http://hub.example:4815/setup | bash
```

Both are well under the 300-char cap the phase file requested.

## Deviations from the phase file

### 1. Exported test-only hooks for `pendingUpgradeNudge`

The phase file's test strategy calls for asserting `pendingUpgradeNudge starts null`, populates after a register response, and clears after attach. The plugin's other two nudge slots (`pendingRenameNudgeBase`, `pendingChannelsOffNudge`) are not exposed for direct testing, and the attach helpers for those are module-local. I chose to:

- Export `attachUpgradeNudgeIfPending` so its attach-once-then-clear contract is directly asserted.
- Export `__setPendingUpgradeNudgeForTest` / `__getPendingUpgradeNudgeForTest` as test-only surfaces so tests can seed the module state without standing up a real hub + WS + MCP stdio.

The alternative — refactoring `attachUpgradeNudgeIfPending` to be pure (take nudge text as an arg, return state transitions) — would have diverged stylistically from the two existing nudge attachers. Keeping them shaped consistently felt more important than minimizing exported surface. The `__`-prefixed names make the test-only intent clear at call sites.

### 2. Threaded `port` through `createHub` + `wsPlugin` rather than storing at `app.listen()` time

The phase file listed two options: thread the port through the hub-construction path, or store it in a module variable at `app.listen()` time. I went with the first (threading) because:

- It keeps `wsPlugin` a pure function of its deps, matching the existing style.
- There's no module-level mutable state in `ws-plugin.ts` today; adding one just for this felt backwards.
- Tests (`createHub({ pingIntervalMs: 100, staleThresholdMs: 400 })`) already treat `createHub` as the configuration entrypoint; adding `port` is the natural next field. Tests that don't pass `port` still work because the default falls back to `CLAUDE_NET_PORT` env var or `4815`.

### 3. `resolveHubUrlForHint` swallows a trailing slash on `CLAUDE_NET_HOST`

Strictly speaking the phase file only asked for "add `http://` if no scheme". I additionally strip a trailing slash via `replace(/\/$/, "")` because `buildUpgradeHint` appends `/setup`, and a doubled `//setup` would look cosmetically wrong in the LLM-visible text. Defensive cleanup, not a behavior change.

## Test status

### Whole suite

```
bun test
→ 338 pass, 0 fail across 34 files (9.89s)
```

Baseline (end of Phase 2): 321 pass. Phase 3 additions:

- `tests/hub/version.test.ts` — 9 new tests.
- `tests/integration/liveness.test.ts` — 3 new tests (L7, L8, L9).
- `tests/plugin/plugin.test.ts` — 5 new tests (4 in the new `attachUpgradeNudgeIfPending` block + 1 for `register.plugin_version`).

Delta: +17. No regressions — one existing test (`mapToolToFrame > register: maps to register action`) needed its expected-frame literal updated for the new `plugin_version` field; done inline.

### Lint

```
bun run lint
→ clean (0 errors, 0 warnings)
```

Two iterations needed:
- Import order in `ws-plugin.ts` — biome sorts type imports alphabetically; `RegisterResponseData` sorts before `RegisteredFrame`.
- Operator precedence — `options.port ?? Number(x) || 4815` needed explicit parentheses around the `||` to appease biome's formatter.

## Notable implementation choices

1. **Comparison rule is exact string equality.** Per phase file: "any mismatch (older, newer, or missing/undefined) triggers `upgrade_hint`". No semver parsing, no "newer plugin talking to older hub is fine" lenience. The implementation is `if (reportedVersion !== PLUGIN_VERSION_CURRENT)` — `undefined` reported also triggers because `undefined !== "0.1.0"`.

2. **Nudge chain order in `handleToolCall`: upgrade is outermost.** Rename is innermost, then channels-off, then upgrade. No functional reason — each attach is independent and only reads its own slot. I picked this order so the upgrade hint (the most actionable "re-install to fix" message) shows up last on a tool result that happens to have all three nudges pending. In practice rename + channels-off + upgrade all firing on the same first tool call would mean a brand-new suffix-numbered session on a channels-off host with a stale plugin — extreme edge case, but readable.

3. **`resolveHubUrlForHint` is local to `ws-plugin.ts`, not in `version.ts`.** `version.ts` is a pure-function module; the env/port resolution is hub-wiring-specific (same sort of logic `setup.ts` does). Keeping the "where do we host" decision close to the WS handler makes the module boundaries clean.

4. **Plugin-side upgrade nudge population happens in `autoRegisterWithRetry` only.** Manual `register(name)` tool calls go through `handleToolCall` → `request(frame)` directly and do NOT re-read `upgrade_hint` from the response. Rationale:
   - The auto-register path is the guaranteed first-register on every startup (barring `CLAUDE_NET_HUB` unset), so the nudge slot will be populated before any user action.
   - If `pendingUpgradeNudge` is already set from the auto-register response, a subsequent manual register doesn't need to touch it — it's already riding on the next tool result, whichever one that is.
   - If the auto-register somehow skipped the upgrade_hint (e.g. the hub wasn't on the same version yet), a later manual register could observe it — but this is rare enough that the simpler code path wins.

   If the spec author wants manual register to ALSO refresh the nudge slot, it's a one-line addition in the `handleToolCall` success branch.

5. **`resolveJsonModule` relied on directly, no fallback.** I tested the import up front (the phase file explicitly asked to do so early); it worked, so the hardcoded-with-comment fallback path documented in the phase file's Risks section was not needed.

## Open questions

1. **Manual register refresh of `upgrade_hint`** — see Notable Choice #4. If the user performs `register(name)` mid-session on a stale plugin, should the nudge populate from that response? Current behavior: no. Defensible but not covered by the phase file explicitly.

2. **Does the plugin-side integration test for the one-shot attach belong in `tests/integration/liveness.test.ts` or `tests/plugin/plugin.test.ts`?** The phase file's L8 says "In a plugin-level test: simulate the register response → `pendingUpgradeNudge` is set → first tool-call result contains the hint text → second tool-call result does NOT." I covered the two halves separately:
   - The integration test (L8) asserts the hub emits the hint.
   - The plugin unit tests assert the attach-once-then-clear contract directly, seeded via `__setPendingUpgradeNudgeForTest`.

   A true end-to-end "plugin receives register response → surfaces hint on first tool result → does not on second" would need to drive the MCP stdio path and the hub WS simultaneously. That's significantly more harness than the phase file's other tests carry; the split-coverage approach gets the same assurance with much less test scaffolding. Flagging in case the tester wants full end-to-end coverage.

3. **`CLAUDE_NET_HOST` with a port already embedded.** If a user sets `CLAUDE_NET_HOST=http://hub.example.com:8443`, `resolveHubUrlForHint` returns it verbatim (strips trailing slash only) — good. If they set `CLAUDE_NET_HOST=hub.example.com:8443` (no scheme), it becomes `http://hub.example.com:8443` — also good. The one remaining weirdness is if `CLAUDE_NET_HOST=https://hub.example.com` and the listen port differs from 443; we emit `https://hub.example.com/setup` without a port, which is only correct if the user has a reverse proxy fronting the hub. Matches the phase file's stated acceptance that the hint URL is informational; no behavior change warranted.

## Success criteria checklist

- [x] `RegisterFrame.plugin_version` carried on every register (both auto-register and the `mapToolToFrame("register", …)` path).
- [x] `PLUGIN_VERSION_CURRENT` sourced from package.json via `import pkg from "../../package.json"`.
- [x] Register-response `data.upgrade_hint` absent on match, present and well-formed on mismatch or missing (integration tests L7/L8/L9 cover all three).
- [x] Plugin surfaces the nudge on exactly one tool result after a mismatch register — covered by `attachUpgradeNudgeIfPending` unit tests (seeded state + fire-and-clear assertions).
- [x] Integration tests L7–L9 pass.
- [x] Unit tests pass.
- [x] No regressions in full `bun test` — 338 pass (baseline 321 + 17 new).
- [x] `bun run lint` clean.
- [ ] Dev report committed — orchestrator handles commits; this file is in the working tree.
