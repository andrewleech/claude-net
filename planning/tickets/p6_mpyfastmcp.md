# Ticket: P6 — `mpyfastmcp`

- Phase: P6
- Owner-model (impl / test / review): sonnet / haiku / opus
- Depends on: P4, P5
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: 2026-07-23 @ pre-commit
- Revalidated:

## Goal

The reusable FastMCP-style layer: an `MCPServer` object with
`@server.tool(...)` / `@server.prompt(...)` decorators (specs per P5),
instructions string, capabilities declaration, initialize/oninitialized hook
exposing client capabilities, tools/list, tools/call (with validation +
isError result shape), prompts/list, prompts/get, and a public
`server.notify(method, params)` for custom notifications. This composes P4 +
P5 and is the last reusable layer before the app (P7).

## Preconditions

- P4 (`mpyjsonrpc`, the async readline JSON-RPC 2.0 stdio peer with
  correlation and notifications) is Done and its ticket revalidated.
- P5 (`mpyschema`, the param-spec-to-inputSchema emitter and argument
  validator) is Done and its ticket revalidated.

## Work items

1. `MCPServer(name, version, instructions, capabilities)` built over
   mpyjsonrpc; implement the initialize handshake (protocolVersion
   negotiation matching the MCP spec and the bun SDK's observed behaviour)
   and an `oninitialized` callback exposing `getClientCapabilities()`.
2. `@tool(name, description, params=...)` decorator: registry + schema
   emission (via mpyschema) + argument validation + the
   `{content:[{type:"text",...}], isError?}` result convention, plus helpers
   equivalent to plugin.ts's `toolResult` / `notConnectedError`.
3. `@prompt(...)` decorator + `prompts/get` returning messages, matching the
   bun plugin's `rename` prompt shape.
4. A result post-processing hook: the plugin's nudge-drain behaviour needs to
   append content blocks to outgoing tool results. Expose this as a
   middleware-ish hook on the layer rather than hard-coding claude-net
   behaviour into mpyfastmcp.
5. A notification API used for `notifications/claude/channel` — the layer
   must not hard-code this (or any) non-standard method name; it is app
   (P7) behaviour layered on a generic `server.notify(method, params)`.
6. Ergonomics/docs pass: README with a minimal example server. This is the
   headline reusable deliverable of the stack — hold an API review with
   Andrew before freezing the surface.

## Interfaces / contracts

Public surface consumed by P7 (the claude-net plugin):

- `MCPServer(name, version, instructions, capabilities)` constructor.
- `@server.tool(name, description, params=...)` and `@server.prompt(...)`
  decorators.
- `oninitialized` hook returning `getClientCapabilities()`.
- Result post-processing / middleware hook for mutating outgoing tool
  results before they are written to stdout.
- `server.notify(method, params)` for emitting arbitrary notifications
  (method name is caller-supplied, not baked into the layer).
- Standard MCP method coverage: `initialize`, `tools/list`, `tools/call`,
  `prompts/list`, `prompts/get`, and unknown-method → JSON-RPC `-32601`.

## Tests

- Harness acting as an MCP client over stdio, run against the demo server:
  full initialize handshake, capability echo, `tools/list` golden output,
  `tools/call` success case, `tools/call` validation-error case, `tools/call`
  handler-exception case → `isError`, prompts round-trip, notification
  emission ordering (a notification emitted mid-request must not corrupt
  stdio framing), unknown method → `-32601`.
- Cross-check: run the same client script against the bun plugin (in
  hubless mode) and against the mpyfastmcp demo server; diff behaviours for
  parity.
- Targets: prebuilt cli binary for dev iteration; `mcp` binary (P2) for CI.

## Exit criteria

- MCP conformance suite green on both the prebuilt cli binary and the `mcp`
  binary.
- API reviewed and accepted by Andrew — this is the project's reuse surface
  and is treated as frozen after acceptance.
- The demo server documented in the README runs on the `mcp` binary.

## Open questions consumed

- Q5 — Schema-spec surface: DECIDED option (c). mpyfastmcp's `@tool(...)`
  decorator consumes P5's explicit spec-object API (ground truth, required
  regardless of hints) as its `params=...` argument; the optional CPython
  codegen DX layer is additive and does not gate this phase.
- Q7 — Library names: DECIDED. The layer built here is `mpyfastmcp` (fixed
  name); it depends on `mpyjsonrpc` and `mpyschema` (working names, also
  settled).
- Q4 — Where the reusable libs live: DECIDED option (a), the claude-net-mpy
  worktree, shipped via the app romfs. mpyfastmcp is laid out and packaged
  under that convention, with no picolet manifest/freeze change required.

## Risks

- Not itemised separately for P6 in the roadmap's risk register (the
  nearest entries — schema DX disappointment and parity drift vs the bun
  plugin — are owned by P5 and P7 respectively). The risk specific to this
  phase, surfaced while writing this ticket: mpyfastmcp is the project's
  designated reuse surface (work item 6), so an API accepted here and then
  reworked during P7 integration is expensive — the API review gate with
  Andrew before freeze exists specifically to catch this before P7 starts
  building against it.
