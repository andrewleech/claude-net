# Ticket: P5 — Schema layer (`mpyschema`)

- Phase: P5
- Owner-model (impl / test / review): sonnet / haiku / opus
- Depends on: P0
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: 2026-07-23 @ pre-commit
- Revalidated:

## Goal

A small, tested library that turns explicit parameter specs into MCP
`inputSchema` JSON-Schema fragments and validates/coerces incoming tool
arguments against them. Shaped by the verified fact that MicroPython
retains neither annotations nor parameter-name introspection (S4):
`f.__annotations__` raises `AttributeError` on the prebuilt binary, and
MicroPython exposes no parameter names, no defaults, and no `inspect`
module, so schemas cannot be derived from decorated function signatures.
`mpyschema` takes explicit param specs as ground truth instead.

## Preconditions

- P0 complete: worktree, planning scaffold, and decision closure (Q1, Q2,
  Q4, Q5, Q7) landed.
- Q5 and Q7 DECIDED (see `planning/DECISIONS.md`) before work items 1 and 4
  start — both are already closed as of this ticket's Written stamp.

## Work items

1. Spec API (ground truth, per Q5(a)): `Str(desc=..., required=True)`,
   `Num(...)`, `Bool(...)`, defaults, optional fields — enough to express
   all 11 existing tool schemas exactly (they use only object/string/number,
   required lists, descriptions) (plugin.ts:562–743).
2. Emitter: spec → `{"type":"object","properties":{...},"required":[...]}`
   matching plugin.ts's literals byte-for-byte where semantics allow (parity
   tests diff the emitted tools/list against the bun plugin's literals at
   plugin.ts:562–743).
3. Validator: check + coerce incoming `arguments` (MCP clients send strings/
   numbers; the bun plugin treats everything as strings — match its observed
   leniency, e.g. `hub_events`'s `since_minutes` arrives as a number).
4. Q5(b) decision point: if chosen, a CPython codegen tool (uv/PEP 723
   script) that parses the plugin source's real type hints and emits spec
   literals as a build step — additive, not required for P6/P7.
5. Docs: the "why not type hints" note (annotations verified absent at
   runtime) so future readers don't re-litigate it.

## Interfaces / contracts

- Spec classes (`Str`, `Num`, `Bool`, and any additional field types needed
  to cover the 11 tool schemas) importable from `mpyschema`, each accepting
  `desc`, `required`, and a default value.
- An emitter function: spec object/mapping → JSON-Schema-fragment dict
  (`inputSchema`), consumed by `mpyfastmcp`'s `@server.tool(...)` decorator
  in P6.
- A validator function: `(spec, arguments) -> coerced_arguments`, raising on
  missing-required / wrong-type / extra-key violations, consumed by P6's
  tool-dispatch path and by P7's plugin.
- No TLS/WS/JSON-RPC dependency — this library is pure Python and standalone
  from `mpyws`/`mpyjsonrpc`.

## Tests

- Golden tests: emit schemas for all 11 claude-net tools + the `rename`
  prompt and diff against the literals extracted from plugin.ts:562–743.
- Validator matrix: missing required field, wrong type, extra keys, empty
  object tools (tools with no parameters).
- Round-trip under the MicroPython binary, not just CPython: golden and
  validator-matrix tests run against the prebuilt
  `picolet-runtime-linux-x64-cli` binary, not only under a CPython dev
  interpreter.

## Exit criteria

- Emitted `tools/list` JSON is semantically identical to the bun plugin's
  (key-order-insensitive diff clean) for all 11 tools + the `rename` prompt.
- Validator matrix green on the MicroPython binary.
- Q5 DECIDED — already satisfied per `planning/DECISIONS.md`; this ticket
  carries the decision into P5's implementation rather than re-opening it.

## Open questions consumed

- Q5 — Schema-spec surface given no runtime annotations. DECIDED 2026-07-23:
  option (c) — explicit spec objects are the ground truth (required
  regardless, since MicroPython retains no annotations, no parameter names,
  no `inspect`), with build-time CPython codegen from real type hints as an
  additive DX layer added later (work item 4). Codegen is additive and does
  not gate P6/P7.
- Q7 — Library names. DECIDED 2026-07-23: the schema library is named
  `mpyschema` (alongside `mpyws` / `mpyjsonrpc` for the WS client / JSON-RPC
  stdio libraries). Fixes the package/import name this ticket's work items
  build under.

## Risks

- Schema DX disappointment (no type hints at runtime) (risk register, P5).
  Mitigation: verified early (roadmap "Current state" section); the
  explicit-spec API plus optional CPython codegen (Q5) and golden-diff tests
  guarantee parity with the bun plugin regardless of how much hint-driven DX
  is layered on top.
