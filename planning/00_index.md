# Planning folder index

This file is the map of `planning/` and the conventions that govern how
entries get added to it. Read this before adding or editing anything else
under `planning/`.

## Document map

- **`ROADMAP.md`** — the execution plan: goal, verified current-state facts,
  design decisions (settled + open), the phase sequence P0–P9 with per-phase
  goal/work-items/targets/tests/exit-criteria/workflow-shape, the risk
  register, and the progress-tracking procedure. Updated in place as phases
  complete and questions close; never forked into a `ROADMAP-v2.md` or
  similar.
- **`DECISIONS.md`** — the decision log. Each closed open-question (Qk) from
  the roadmap gets one dated section here: the verbatim decision, its
  rationale, and the owner phase. A reversed decision is a new dated entry,
  not an edit to the old one.
- **`20260723_spike-results.md`** — the findings write-up for the 4-agent
  de-risking spike that preceded this plan: what was measured, on what
  binary, with what artifact. Anchors the roadmap's "Current state (verified
  facts...)" section to specific spike files.
- **`spike/`** — the spike's actual scripts and artifacts (`ws.py`,
  `combined.py`, `mock_hub.py`, `mp_wss.py`, `build_tls.sh`,
  `isrg_root_x1.der`/`.pem`, etc.), carried into this worktree as starting
  code for P1/P3/P4. Not rewritten in place; P1/P3/P4 extract and rewrite
  into proper packages under `src/plugin-mpy/lib/`.
- **`tickets/`** — per-phase ticket files, one per substantive work item,
  named `<phaseN>_<slug>.md`, following the template below. Written at
  Phase 0 for P1–P8 (P9 is deferred and gets no ticket yet — see below) and
  revalidated at each phase's entry per the procedure below.

## Conventions

### Findings files

Any phase that produces findings, measurements, or learnings not already
captured as a ticket or a decision writes them to
`planning/YYYYMMDD_<topic>.md`, stamped with the date and the worktree HEAD
short SHA at the time of writing. These files are not edited after the fact
to reflect later findings — a follow-up measurement is a new dated file, or
an update to `ROADMAP.md`/`DECISIONS.md` if it changes the plan itself.

### Commit policy

This repo (claude-net) has no enforced commit sign-off. `CLAUDE.md` in the
repo root documents commands, architecture, and conventions for identity,
patching, and self-inject, but states no commit-message or `-s` sign-off
requirement — unlike picolet, where `CLAUDE.md` mandates `git commit -s` and
a `[PHnn]`-tagged subject line. Commits in this worktree follow whatever
convention is normal for claude-net (imperative subject, no enforced
sign-off, no phase-tag requirement), not picolet's commit policy.

### The roadmap is updated in place

`ROADMAP.md` is the single execution plan. Phase completion, question
closure, and scope changes are edits to that file, never a forked or
versioned copy. Ticket files reference the roadmap by section, not by
copying roadmap text out of sync with it.

### Ticket template

Every ticket in `planning/tickets/` uses exactly this block:

```
# Ticket: <PHASE_ID> — <title>

- Phase: <PHASE_ID>
- Owner-model (impl / test / review): <e.g. sonnet / haiku / opus>
- Depends on: <phase ids or "none">
- Roadmap anchor: claude-net main @ 4f564a56b9, picolet dev @ 2fe3ef5d14
- Written: <YYYY-MM-DD> @ <worktree HEAD short sha, or "pre-commit">
- Revalidated: <appended at phase entry; empty at creation>

## Goal
<one paragraph, lifted/condensed from the roadmap phase Goal>

## Preconditions
<what must be true before this phase starts; which prior tickets must be Done>

## Work items
<numbered, each an independently reviewable unit; carry the roadmap's file:line anchors where the roadmap gives them>

## Interfaces / contracts
<public API surface this phase must expose for downstream phases; "" if none>

## Tests
<the test obligations from the roadmap phase, made concrete: harness shape, fixtures, adversarial briefs>

## Exit criteria
<binary, checkable; copied and sharpened from the roadmap phase>

## Open questions consumed
<which Qk this phase decides/uses, and the DECIDED value it should assume (see planning/DECISIONS.md)>

## Risks
<phase-specific risks from the roadmap risk register + any surfaced while writing the ticket>
```

### Ticket revalidation at phase entry

Condensed from `ROADMAP.md`'s "Progress tracking" section. Before a phase's
tickets feed a workflow:

1. `git log <ticket SHA>..HEAD` and `git diff <ticket SHA>..HEAD -- <anchors>`
   in **both** repos referenced by the ticket's Roadmap anchor line
   (claude-net worktree and picolet), checked against every file:line anchor
   the ticket carries.
2. Check planning docs dated after the ticket's Written stamp, and check
   whether any Qk the ticket depends on has changed value in
   `DECISIONS.md` since the ticket was written.
3. If drift is found but doesn't reshape the ticket's work items or exit
   criteria, update the ticket in place and append a `Revalidated:
   <YYYY-MM-DD> @ <HEAD sha>` stamp.
4. If drift is big enough to reshape the ticket (a changed Qk decision, a
   moved anchor whose surrounding code changed shape, a roadmap phase-goal
   edit), that is a roadmap update, not a silent ticket rewrite — surface it
   before proceeding.
5. Only tickets revalidated at the current HEAD feed a workflow. A ticket
   with a stale or missing Revalidated stamp is not handed to agents.

### Execution model

Each phase's revalidated tickets feed a dynamic multi-agent workflow with
this default model tiering:

- Implementation → `sonnet`.
- Automated testing → `haiku`.
- Review (standard + adversarial) → `opus`.
- Loop: opus review findings feed back to the sonnet implementer(s), haiku
  re-runs the tests, opus re-reviews; repeat until reviews surface no
  remaining findings and tests pass.

Per-phase overrides documented in `ROADMAP.md` take precedence over this
default — e.g. Phase 1 (async-TLS spike) runs implementation on `opus`
because TLS/event-loop state-machine subtlety is the project's top
technical risk and may cross into C internals; Phase 9's initial spike also
runs on `opus` before falling back to the standard tiering.

### P9 (Windows) has no ticket yet

P9 is explicitly deferred (see `ROADMAP.md` Phase 9); by design it gets no
ticket file until it is scheduled and its own de-risking spike has run.
