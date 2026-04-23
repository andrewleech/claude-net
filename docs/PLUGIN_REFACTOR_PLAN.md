# Plugin Class Refactor Plan

**Goal:** Encapsulate `src/plugin/plugin.ts`'s 12+ module-level mutable variables into a single `Plugin` class with grouped sub-state, making the file testable without backdoor exports and maintainable as features accumulate.

**Scope:** Single file (`src/plugin/plugin.ts`) + its test file (`tests/plugin/plugin.test.ts`). No functional changes — pure structural refactor. All 338 existing tests must pass identically before and after.

**Constraint:** The file has a single-file constraint. It's served by the hub at `GET /plugin.ts` and executed on client machines via `bun run http://hub:4815/plugin.ts`. It cannot import local project files. This refactor stays within one file.

## Problem

The plugin has accumulated module-level mutable state for every feature:

```
let ws: WebSocket | null               let channelCapable = false
let storedName = ""                     let mcpInitialized = false
let registeredName = ""                 let hubWsUrl = ""
let reconnectDelay = RECONNECT_INITIAL_MS   let reconnectTimer = null
let mcpServer: Server | null            export const pendingNudges: PendingNudge[] = []
const pendingRequests = new Map<...>()
```

Every function reads/writes these via closure. Adding a feature means adding 1–3 more `let`s, touching `handleToolCall` in multiple places, and sometimes exporting test-only backdoors. The exported helper `mapToolToFrame` has a hidden read of `channelCapable` — it appears pure but isn't.

## Target architecture

A `Plugin` class with state grouped into typed sub-objects:

```typescript
class Plugin {
  // ── Connection ────────────────────────
  private ws: WebSocket | null = null;
  private hubWsUrl = "";
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  // ── Identity ──────────────────────────
  private storedName = "";
  registeredName = "";  // public — tests inspect this

  // ── MCP lifecycle ─────────────────────
  private mcpServer: Server | null = null;
  private mcpInitialized = false;
  channelCapable = false;  // public — tests + mapToolToFrame read this

  // ── One-shot nudges ───────────────────
  readonly pendingNudges: PendingNudge[] = [];

  constructor(hubUrl: string | undefined) { ... }

  // Public methods (testable)
  drainNudges<T>(result: T): T { ... }
  handleToolCall(name: string, args: Record<string, string>): Promise<Result> { ... }
  mapToolToFrame(name: string, args: Record<string, string>): Record<string, unknown> | null { ... }

  // Internal methods (private, called by WS/MCP event handlers)
  private connectWebSocket(): void { ... }
  private maybeSendRegister(): void { ... }
  private autoRegisterWithRetry(baseName: string): Promise<void> { ... }
  private handleHubFrame(raw: string): void { ... }
  private request(frame: Record<string, unknown>): Promise<unknown> { ... }
  private scheduleReconnect(): void { ... }

  // Lifecycle
  shutdown(): void { ... }
}
```

`main()` instantiates `new Plugin(process.env.CLAUDE_NET_HUB)`, wires the MCP server, connects the transport, and sets up signal handlers.

## Pre-refactor test baseline

Before making any code changes, the refactor must establish a comprehensive behavioral test suite that covers every observable behavior of the plugin. These tests validate the contract; they must pass both before and after the refactor.

### Existing tests (tests/plugin/plugin.test.ts)

Currently tests these exported helpers:
- `buildDefaultName` — format, components
- `withSessionSuffix` — suffix insertion
- `createChannelNotification` — notification shape from InboundMessageFrame
- `mapToolToFrame` — all 10 tool name → frame action mappings + unknown-tool null return + `channel_capable` inclusion in register frame + `plugin_version` inclusion
- `detectChannelCapability` — truthy/falsy/missing/undefined experimental capability
- `buildChannelsOffNudge` — text content assertions
- `drainNudges` / `pendingNudges` — queue drain, guard skip, one-shot clear
- `writeSessionState` — file write shape and cleanup

### Tests to add BEFORE the refactor (Phase 1)

These tests should be written against the current module-level code so they establish the behavioral contract. They must pass on the current code AND on the refactored code.

**1. `mapToolToFrame` purity test:**
- Verify that `mapToolToFrame("register", { name: "x" })` includes `channel_capable` derived from the module state. Currently this is a hidden dependency. After refactor, `mapToolToFrame` will be a method on Plugin and read `this.channelCapable` explicitly. The test confirms the value flows through regardless of mechanism.

**2. Pure helper invariance tests:**
- `buildDefaultName`, `withSessionSuffix`, `createChannelNotification`, `detectChannelCapability`, `buildChannelsOffNudge` remain top-level exported functions (they have no state dependency). Write explicit tests confirming they are importable and return the same values before and after.

**3. `TOOL_DEFINITIONS` shape test:**
- Verify the tool list has the expected count (currently 10 tools) and each tool has `name`, `description`, `inputSchema`. This catches accidental tool-list mutations during the refactor.

**4. `INSTRUCTIONS` content test:**
- Verify the instructions string contains key phrases: "send_message", "register", "whoami", "ack", "install-channels", "channel_capable". Catches accidental truncation.

**5. `PLUGIN_VERSION` constant test:**
- Verify it matches the expected format and is a non-empty string.

### Integration-level behavioral tests

The integration tests in `tests/integration/liveness.test.ts` (L1–L9) and `tests/integration/e2e.test.ts` already exercise the plugin indirectly (they connect WS clients that simulate plugin behavior). These tests don't need changes — they're already part of the 338-test baseline and will catch regressions.

## Phase 1: Add pre-refactor baseline tests

**Files:** `tests/plugin/plugin.test.ts` only.
**Scope:** Add the tests described above. Run `bun test` — all must pass on the existing module-level code. Commit.

## Phase 2: Extract the Plugin class

**Files:** `src/plugin/plugin.ts` only.

Mechanical transformation:

1. Create `class Plugin { }` after the type/constant definitions.
2. Move all `let` variables into the class as fields (private where possible, public where tests or `mapToolToFrame` need access).
3. Move all non-exported functions that read/write those variables into the class as methods.
4. Convert bare variable references to `this.x` throughout the methods.
5. Keep `main()` as a top-level function that instantiates `new Plugin(hubUrl)` and wires MCP handlers, transport, and signal handlers.
6. Keep pure helpers (`buildDefaultName`, `withSessionSuffix`, `createChannelNotification`, `detectChannelCapability`, `buildChannelsOffNudge`) as top-level exports — they have no state dependency.
7. `mapToolToFrame` becomes a method on `Plugin` (it reads `this.channelCapable`). For backwards compatibility with existing tests, export a wrapper function that delegates to a module-level plugin instance. OR update the test to instantiate Plugin directly.
8. `drainNudges` becomes a method. `pendingNudges` becomes a public instance field.
9. `TOOL_DEFINITIONS` and `INSTRUCTIONS` remain top-level constants (they don't depend on instance state).
10. Export `Plugin` class for tests.

Key decisions:
- `handleToolCall` becomes a public method (MCP handler delegates to it).
- `request` stays private (internal WS plumbing).
- `connectWebSocket`, `scheduleReconnect`, `maybeSendRegister`, `autoRegisterWithRetry` stay private.
- `emitSystemNotification` becomes private.
- `handleHubFrame` becomes private.
- `isConnected` becomes a private getter or method.

The `main()` function:
```typescript
async function main(): Promise<void> {
  const plugin = new Plugin(process.env.CLAUDE_NET_HUB);
  await plugin.start();
  process.on("SIGINT", () => plugin.shutdown());
  process.on("SIGTERM", () => plugin.shutdown());
}
```

Where `plugin.start()` creates the MCP server, connects transport, and initiates WS connection.

## Phase 3: Update tests

**Files:** `tests/plugin/plugin.test.ts`.

1. Import `Plugin` class.
2. For tests that need instance state (nudge queue, mapToolToFrame with channelCapable):
   - Instantiate `new Plugin(undefined)` (no hub URL — skips WS connection).
   - Set `plugin.channelCapable = true/false` directly instead of backdoor exports.
   - Call `plugin.drainNudges(result)` instead of the top-level function.
   - Call `plugin.mapToolToFrame(...)` instead of the top-level function.
3. For pure helper tests: keep importing top-level exports. No changes needed.
4. Confirm TOOL_DEFINITIONS and INSTRUCTIONS tests still pass (they import top-level constants).
5. Run `bun test` — full 338+ test suite must pass.

## Phase 4: Cleanup

1. Remove any remaining module-level state that moved into the class.
2. Verify no `__set/__get` test exports remain (none should — the nudge queue refactor already removed them).
3. Run `bun run lint` and `bun run fmt`.
4. Verify the module-level entry point (`main()`) still works under `bun run http://hub:4815/plugin.ts`.

## Success criteria

- [ ] All 338+ existing tests pass identically before and after.
- [ ] `mapToolToFrame` no longer has a hidden module-scope dependency (reads `this.channelCapable` explicitly).
- [ ] No module-level `let` variables remain (all moved into the Plugin class).
- [ ] Tests instantiate `Plugin` directly — no backdoor exports needed.
- [ ] Pure helpers remain top-level exports (no unnecessary class coupling).
- [ ] `bun run lint` clean.
- [ ] The plugin still works end-to-end via `bun run http://hub:4815/plugin.ts` (manual smoke test).

## Risks

- **`this` binding in callbacks.** WS event handlers (`ws.on("open", ...)`) passed as method references lose `this`. Use arrow functions or `.bind(this)`. This is the most likely source of bugs — test the WS reconnect flow carefully.
- **Circular reference in constructor.** The MCP server's tool handlers reference `plugin.handleToolCall` — if the server is created in the constructor, `this` must be fully initialized. Safest: create the server in `start()`, not the constructor.
- **Import order.** If tests import `Plugin` and also import top-level helpers, the module executes once. As long as `main()` is gated behind `if (import.meta.main)` (or the existing pattern of calling `main()` at module bottom), this is fine.

## Estimated effort

- Phase 1 (baseline tests): ~30 minutes
- Phase 2 (class extraction): ~1.5 hours (mechanical but cross-cutting)
- Phase 3 (test updates): ~30 minutes
- Phase 4 (cleanup): ~15 minutes

Total: ~2.5–3 hours. Single developer, single commit per phase.

---
*Drafted 2026-04-23. Derived from architecture planning agent analysis of approaches 1–4 (class-based won over functional, subsystem-grouping, and event-driven).*
