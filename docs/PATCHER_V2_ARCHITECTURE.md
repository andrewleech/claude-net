# Claude Code Patcher v2 — Architecture

Target binary: Bun-compiled Claude Code (currently 2.1.195, 244 MB ELF). Implementation language: Python 3.11+, stdlib only (`struct`, `re`, `pathlib`, `argparse`, `dataclasses`, `hashlib`).

---

## 1. Goals

### Problem

The current patcher (`bin/patch-binary.py`) enforces **strict same-length replacement** on the entire ELF file (see size-investigation report: Bun fails over to plain Bun runtime if `e_shoff`, `sh_size`, `p_filesz` or the embedded `payload_len` prefix disagree with the on-disk size). That constraint has been bearable for the six existing patches — every one of them is a JS-fragment swap of equal byte length (operator inversion, function-body rewrite into `return!0` plus space padding, `!VAR.dev` → `!1` plus spaces).

The constraint becomes prohibitive the moment we want to **add** content. The motivating case: register a new model alias (e.g. `"local"`) so it passes every validation gate in Claude Code. Per `inv-validation-gates.md` (Gates 1, 4, 5) and `inv-agent-tool-enum.md`, the alias must be present in *five distinct JS literals* — `hye`, `spd`, `tMe`, `oMe`, and the `Nff` zod enum. None of these literals have spare same-length slots: hijacking an existing slot ("haiku" → "local") sacrifices a real model; padding the array literal with whitespace is impossible because `H.enum([...])` validates against the exact string list, not its byte width.

A v2 patcher must therefore:

1. Keep doing what v1 does (six same-length edits at logically distinct call sites), with the same ergonomics (clear diagnostics on a stale pattern, single CLI entry point).
2. Add the ability to apply **variable-length** edits — insertions, deletions, or replacements where `new_len != old_len` — and have the resulting binary still boot as Claude Code.
3. Compose into one pass: a single `patch-binary <src> <dst>` invocation applies same-length and growable patches together, and emits a binary whose ELF / Bun framing is internally consistent.
4. Be extensible without ad-hoc per-patch code in the driver — each patch is a small declarative descriptor plus an `apply(ctx)` function.

### Success criteria

- After running v2 on a fresh download of 2.1.195, the patched binary:
  - Reports `2.1.195 (Claude Code)` on `--version` (i.e. Bun runtime accepts it, no fall-back to plain Bun help).
  - Passes the six existing behaviour checks listed in `CLAUDE_CODE_PATCHING_GUIDE.md` (the `grep -cP` table at the end of the guide).
  - Accepts `--model local` without error. `/model`'s picker shows the alias as a fallback entry rendered by `naa()` (`"Custom model (local)"`); the cosmetic picker patches (S7–S10) are deferred to v2.1 and a polished picker label is **not** part of v2's success criteria.
  - Allows `Task(..., model: "local", ...)` from a subagent without a zod `invalid_enum_value` error.
- Failure of a single patch is non-fatal for the rest: the launcher's existing `exit 2 = partial` semantics is preserved.
- Re-running v2 on the same binary produces a byte-identical output (idempotent under a stable random seed — there is no randomness in the patcher).

### Pre-implementation spike (gating)

Before writing any of the framework in §3–§5, a **mandatory ~50-line spike** must prove the load-bearing assumption that `module[0].contents` can be grown in-place without breaking Bun's loader or JSC bytecode cache. The spike:

1. Inserts `N` bytes of inert ASCII whitespace (`0x20`) at a safe location inside `module[0].contents` (e.g. immediately after a `;` inside the bundle).
2. Performs the full StringPointer bump + ELF surgery described in §4 steps 10–11.
3. Verifies `--version` returns `2.1.195 (Claude Code)`.
4. Re-runs under `BUN_JSC_forceDontCompileBytecode=1` to confirm the bundle parses with bytecode disabled.
5. Re-runs with bytecode enabled, measures cold-start time vs. unpatched, confirms Bun falls back gracefully (no abort, no SIGBUS).
6. Runs under `strace -f -e trace=mmap,mprotect` to confirm no alignment failures.

If any of the above fails, **Strategy A is dead** and v2 must be re-scoped (likely: ship same-length-only edits plus the `ANTHROPIC_CUSTOM_MODEL_OPTION` env-var path for now). The spike code lives at `bin/patcher/_spike_padding.py` and is preserved as the `--inject-padding` debug mode of the final CLI so the header-fixup path remains independently exercisable.

> **Empirical outcome (June 2026):** The spike passed on N = 1, 8, 64, 4096 with the source-recompile cost visible (5–6× cold-start slowdown, confirming Bun invalidated the stale bytecode). No SIGBUS, no mmap failures. Strategy A is validated; the `_spike_padding.py` file was subsequently deleted in favour of the framework path (`--inject-padding` was retired at the same time — the framework's own growable-edit machinery covers the same test surface).

### Out of scope

- Modifying the JSC bytecode cache. The bytecode at `payload+0x78` is precomputed against the source hash of `module[0].contents`. We will **never edit module[0]'s contents in a way that grows or shrinks it**; growable edits live in a different region (see §7 below). Stale-bytecode handling at Bun startup costs ~10× cold start, but does not break correctness — we accept the risk and document it.
- Sourcemap and `module_info` regions. All zero-length in 2.1.195. If a future build populates them, additional pointer-bookkeeping rules apply (see Open Questions, §10).
- Bytecode-cache regeneration. Not our problem — Bun handles it transparently with a slowdown.
- Cross-architecture support. ELF64 little-endian only (Linux x86-64 and aarch64). macOS Mach-O builds are a future addition.
- Anything outside `.bun` (no patches to libc, libcurl, etc. inside the binary).

---

## 2. Decisions

### Strategy: A, not B

**Strategy A** (in-place rewrite of the payload, bumping StringPointer offsets + ELF section/segment offsets after a growable insertion) is the only viable path. Rationale, citing the investigations:

- `inv-module-graph.md` §3-5 rules out **Strategy B** (append a new module record and either rewire `entry_point_id` or have the existing entry import the appendage). The Claude Code bundle reads `hye`, `spd`, the `Nff` schema enum, and the picker label literals from *closed-over local bindings inside their own module*. A late-added module cannot reach those bindings: any code it runs at top level executes *after* the entry-point module has read those literals into its module-scope `var`s, and `globalThis` patches do not intercept lexically-scoped reads. Strategy B has no execution slot where injected JS can intercept array initialisation.
- `inv-string-pointers.md` lays out a closed-form bump algorithm (32 fields max to touch, all reachable from a single anchor — the Offsets struct found by walking back from the `\n---- Bun! ----\n` trailer) and confirms that internal payload pointers are payload-relative, so a growable insert placed in a controlled location requires bumping only those StringPointer offsets whose `offset >= insert_position`.
- `bun-patch-size-investigation.md` confirms ELF surgery (sh_size, p_filesz, p_offset, sh_offset, e_shoff) is mechanical bookkeeping with no cryptographic dependency. The `BuildID[sha1]` is metadata; nothing validates it at load.

So the v2 patcher is fundamentally a Bun-payload editor with ELF fix-up.

### File layout

```
bin/
  claude-channels                 (existing launcher — small change: hash inputs grow)
  install-channels                (existing)
  patcher/
    __init__.py
    __main__.py                   entry: `python -m patcher <src> <dst>`
    cli.py                        argparse + driver — replaces patch-binary.py at the CLI level
    elf.py                        ELF64 header / section / segment read+write
    bun.py                        Bun payload framing: trailer find, Offsets struct, modules table
    edits.py                      Edit / EditPlan dataclasses, overlap detection, in-place application
    context.py                    DiscoveryContext (immutable, passed to patches) + EditApplier
    patches/
      __init__.py                 registry: PATCHES = [list of Patch objects]
      channels.py                 the existing six patches, in new framework
      model_alias.py              the new model-alias patch (variable-length)
      availability.py             xa() body rewrite (added during v2 development)
    diagnostics.py                anchor search, log lines, structured diff output
  patch-binary.py                 stays as a 4-line shim: `from patcher.cli import main; main()`
                                  (back-compat for any script that calls it by path)
```

The pre-existing `patch-binary.py` becomes a thin compatibility shim so existing call sites in `claude-channels` and `install-channels` don't break during the rollout. After the launcher is updated to call `python -m patcher`, the shim can be deleted.

### How the existing six patches sit in the new framework

Each existing patch becomes one `Patch` descriptor in `patches/channels.py`. Their `discover()` returns a list of `Edit` objects with `delta == 0`. The driver collects all edits across all patches, validates non-overlap, and applies them in a single pass. Behaviour is identical to v1 for these six patches — the change is purely structural so growable edits can compose with them.

---

## 3. Core data types and interfaces

The context is split into two distinct objects to avoid the trap of patches consulting stale absolute offsets after the splice phase has rewritten them. Discovery operates only against a read-only view of the original buffer; application takes a frozen `EditPlan` and owns the mutable bytearray.

```python
# context.py
@dataclasses.dataclass(frozen=True)
class DiscoveryContext:
    """Read-only view of the input binary used by `Patch.discover()`.

    Patches never see the mutable bytearray or post-splice offsets. They
    receive an immutable snapshot of the framing as parsed at the start of
    the run and emit Edits in terms of original absolute file offsets.
    Each Edit also carries a `region_ref` (the containing StringPointer,
    if any) so the applier can compute pointer bumps generically without
    patches encoding framing knowledge.
    """
    buf: bytes                     # immutable copy of the input file
    elf: ElfLayout                 # parsed ELF headers, see elf.py
    bun_section_idx: int
    payload_start: int             # absolute file offset of payload byte 0
    payload_end: int
    payload_byte_count: int        # payload-relative end of data, before Offsets struct
    offsets_struct_offset: int     # absolute file offset of the Offsets struct
    trailer_offset: int
    modules: tuple[ModuleRecord, ...]   # tuple, not list — discovery-time snapshot
    version: str                   # claude --version string for diagnostics

    # Helpers — all return absolute file offsets / immutable views
    def payload_view(self) -> memoryview: ...
    def find_in_payload(self, pat: bytes) -> list[int]: ...
    def find_regex_in_payload(self, rx: bytes) -> list[re.Match[bytes]]: ...
    def containing_string_pointer(self, abs_offset: int) -> StringPointerRef | None:
        """Identify which StringPointer (e.g. module[0].contents) wholly
        contains abs_offset; None if it lies in framing or outside any."""

class EditApplier:
    """Owns the mutable bytearray and the delta log; runs steps 8–11 of §4."""
    def __init__(self, src_buf: bytes, discovery: DiscoveryContext): ...
    def apply(self, plan: EditPlan) -> ApplyResult: ...
```

> **Post-cleanup note:** the v2 cleanup pass merged `DiscoveryContext.buf` and `EditApplier.buf` into a single shared `bytearray` (patches never mutate it, but the applier does), so the peak memory footprint dropped from ~3× file size to ~1×. `Edit.region` and `Edit.region_ref` were also collapsed into a single `grows_region: StringPointerRef | None` after the review pass showed the two fields were never distinct in practice. See the Revision Log for details.

```python
# edits.py
@dataclasses.dataclass(frozen=True)
class StringPointerRef:
    """Identifies a single StringPointer field for the bump phase.
    e.g. ("module", 0, "contents") or ("offsets", "modules_ptr")."""
    kind: str                         # "module" | "offsets"
    index: int                        # module index, or 0 for offsets
    field: str

@dataclasses.dataclass(frozen=True)
class Edit:
    """A single byte-level change in the file.

    `offset` is the *original* absolute file offset — i.e. relative to the
    untouched input buffer. The applier resolves post-splice positions
    from the delta log; patches never compute shifted offsets themselves.
    """
    offset: int                       # original absolute file offset
    old: bytes                        # expected bytes (verified before splice)
    new: bytes                        # replacement bytes
    patch_name: str
    grows_region: StringPointerRef | None  # which field's `length` must grow with delta

    @property
    def delta(self) -> int:
        return len(self.new) - len(self.old)

@dataclasses.dataclass
class EditPlan:
    """Aggregated edits across all patches, validated for overlap and region constraints."""
    edits: list[Edit]

    def total_delta(self) -> int: ...
    def growable(self) -> list[Edit]: ...
    def same_length(self) -> list[Edit]: ...

    def validate(self, ctx: DiscoveryContext) -> None:
        """Raise PatchConflictError / RegionError for any of:

        - Two edits whose [offset, offset+len(old)) ranges intersect.
        - Two edits at the exact same offset (v2.0 rejects all coincident-
          offset edits; may be relaxed later with an ordering_key).
        - Any edit landing in the framing region (Offsets struct, modules
          table, or trailer). Check is `ctx.is_framing_offset(off)`.
        - Any growable edit whose [offset, offset+len(old)) straddles a
          StringPointer boundary (e.g. starts in module[0].contents and
          ends in module[1].contents) — these require bespoke handling.
        - Any growable edit on a module whose `encoding == 1` (Latin1)
          when the inserted bytes are not pure ASCII.
        """
```

```python
# patches/__init__.py
class Patch(typing.Protocol):
    name: str
    description: str
    # Patches declare what classes of edits they may emit, so the driver can
    # apply a `--same-length-only` mode (used in initial rollout / dry runs).
    may_grow: bool
    expect_count: int | tuple[int, int] | None  # exact, range, or None to skip the check
    diag_anchor: bytes | None                   # anchor for failed-patch diagnostics

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        """Return the edits this patch wants to make. Empty list = pattern not
        matched (caller treats as miss). Raise PatchError for hard failures
        (e.g. anchor matched outside the payload, or ambiguous match)."""

    def cache_key(self) -> str:
        """Return a stable string contributing to the launcher's cache key.
        Default: hash of the patch class source. Override to incorporate
        runtime parameters (e.g. CLAUDE_PATCHER_MODEL_ALIAS)."""
```

`expect_count` is the central defence against the "regex silently matches multiple sites" failure mode. Every patch declares how many anchor hits it expects; the driver fails fast with a clear diagnostic if the count is wrong.

```python
# cli.py
@dataclasses.dataclass
class PatchResult:
    name: str
    edits_emitted: int             # 0 = pattern not found
    edits_applied: int             # = edits_emitted on success
    growable: bool
    diagnostic_lines: list[str]    # only populated on failure

    @property
    def matched(self) -> bool:
        return self.edits_applied > 0

@dataclasses.dataclass
class PatchRunSummary:
    version: str
    input_size: int
    output_size: int
    results: list[PatchResult]

    @property
    def applied(self) -> list[PatchResult]: ...
    @property
    def missed(self) -> list[PatchResult]: ...

    def exit_code(self) -> int:
        return 2 if self.missed else 0
```

---

## 4. Pipeline

Sequence — one invocation of `python -m patcher <src> <dst>`:

```
1.  Read <src> into a single `bytearray`. Both the DiscoveryContext view
    and the EditApplier share ownership; patches read (via find_in_payload)
    but never mutate.
2.  Capture `<src> --version` (timeout 10s) for diagnostics.
3.  elf.parse(buf)
        -> ElfLayout {ehdr, phdrs, shdrs, .bun section}
4.  bun.locate(buf, elf)
        -> validate trailer "\n---- Bun! ----\n"
        -> read payload_len prefix at .bun start
        -> read Offsets struct (32 bytes immediately before trailer)
        -> parse modules table (Offsets.modules_ptr, length / 52 records)
        -> assert sourcemap.length == 0 and module_info.length == 0 for every module
        -> assert encoding == 1 (Latin1) for every module that any patch may grow
        -> assert p_filesz == p_memsz for the LOAD segment covering .bun
        -> build DiscoveryContext (immutable snapshot of framing; buf is shared)
5.  for patch in PATCHES:
        edits = patch.discover(discovery)
        if not edits:
            record miss; emit diagnostic via diagnostics.anchor_search()
            continue
        if patch.expect_count is not None and len(edits) != expected:
            raise PatchError (regex matched wrong number of sites)
        plan.add(edits)

6.  plan.validate(discovery)
        -> overlap check (sort by offset, walk, assert non-intersecting)
        -> coincident-offset check (v2.0 rejects all — see §3 note)
        -> region check (no edit in the framing region: modules table,
           Offsets struct, or trailer; use ctx.is_framing_offset())
        -> straddle check (growable edits must lie wholly within a single
           StringPointer's [offset, offset+length))
        -> encoding check (growable edit's bytes must be ASCII if the
           containing module has encoding == 1)
7.  Separate plan into:
        same_length_edits   (delta == 0)
        growable_edits      (delta != 0)

8.  Apply same-length edits in any order. They do not shift each other,
    so order is irrelevant. Each splice is `buf[off:off+len(old)] = new`
    in-place on the bytearray (no reallocation of the 244 MB buffer).

9.  If growable_edits is non-empty:
        9a. Sort growable_edits by (offset DESCENDING).
            Descending order means earlier offsets stay valid after each splice
            — no need to walk pending edits to rewrite their offsets, and no
            244 MB reallocation per edit (the bytearray slice-assignment
            shifts trailing bytes once per splice; total cost O(total_delta *
            tail_size), not O(file_size * num_edits)).
        9b. For each edit:
              - Splice in place: buf[off:off+len(old)] = new after verifying
                the bytes at [off, off+len(old)) match the expected `old`.
              - The pre-splice snapshot lives entirely in the parsed
                DiscoveryContext structs (ElfLayout, BunFraming, ModuleRecord).
                No separate delta log is kept — the applier reasons directly
                from those structs and the growable-edits list.
        9c. After all splices: total_delta = sum of deltas.

10. Bun framing fix-up (only if total_delta != 0):
        10a. For every StringPointer field f held in the snapshot (all
             module fields + Offsets.modules_ptr + Offsets.compile_exec_argv):
              new_offset = f.offset
              new_length = f.length
              if f.length > 0 and (f.offset + payload_start) is strictly
                past every growable edit's [offset, offset+len(old)):
                  new_offset = f.offset + total_delta
                Otherwise sum only the deltas of edits whose ranges are
                strictly before (f.offset + payload_start).
              if any edit's `grows_region == self_ref`:
                  new_length += that edit's delta
             This uses `_shift_past(threshold, growable)` — a single
             helper that computes the shift by summing deltas of edits
             whose ends are ≤ threshold.
        10b. Apply the same algorithm to `Offsets.byte_count` (grows by
             total_delta unconditionally, since the data region preceding
             the Offsets struct expanded by exactly that amount) and
             `Offsets.compile_exec_argv_ptr.offset` (only if length > 0,
             using the same threshold rule).
        10c. Write back the updated Offsets struct and modules table to buf
             at their POST-SPLICE absolute positions (both lie after every
             insert in the valid region, so their file offsets shift by
             total_delta).
        10d. Update u64 payload_len prefix at .bun section start: += total_delta.
             (Note: .bun itself does not move in file position — only sections
             AFTER it move. The prefix lives at .bun's unchanged sh_offset.)

11. ELF fix-up (only if total_delta != 0):
        11a. .bun section's sh_size += total_delta. (Written at the shifted
             file offset of the .bun shdr if the shdr table lies past .bun.)
        11b. The covering LOAD segment's p_filesz and p_memsz both += total_delta.
             We asserted p_filesz == p_memsz pre-patch (§4 step 4); maintaining
             equality keeps `.bss`-style trailing zero-fill semantics intact.
        11c. Alignment check: for each section header whose sh_offset > .bun.sh_offset,
             confirm (original_sh_offset + total_delta) % sh_addralign == 0.
             If any section fails, the patcher pads the growable insertion
             upstream with `0x20` whitespace bytes (inside the JS bundle —
             always-valid in JS) until the alignment LCM is satisfied. The
             pad is applied at the LAST growable insertion site (purely
             cosmetic choice; any in-bundle site works). The §1 spike must
             confirm this padding strategy is sound.
        11d. For every section header whose sh_offset > .bun.sh_offset:
             sh_offset += total_delta.
        11e. For every program header whose p_offset > .bun start:
             p_offset += total_delta. This covers PT_LOAD plus any
             PT_NOTE / PT_GNU_* segments whose file ranges trail the .bun
             section. The driver does NOT discriminate by segment type —
             the rule is purely "p_offset past .bun start shifts".
        11f. ELF header e_shoff += total_delta.

12. Write buf to <dst>; shutil.copymode(src, dst).
13. Print summary; exit 0 / 2 per PatchRunSummary.exit_code().
```

The split between steps 8 and 9 means same-length patches never see shifted offsets, and growable patches use descending order so earlier offsets stay valid without rewriting. Step 10 is the StringPointer bump described in `inv-string-pointers.md` §"Bump Algorithm" generalised to handle length growth. Step 11 is the ELF surgery described in `bun-patch-size-investigation.md` §"Path forward / option 1" with the alignment constraint of §11c added.

Insertion site policy: validation in step 6 enforces that growable inserts lie wholly within a single StringPointer region (currently always inside a module's `contents`). The driver does not attempt to support inserts that straddle module boundaries or land in framing — both raise at validation time.

---

## 5. Module-by-module layout

**`patcher/__main__.py`** — the universal entrypoint (`python -m patcher`). Calls `cli.main()`. Two lines.

**`patcher/cli.py`** — argparse, file I/O, orchestration. Builds the `DiscoveryContext`, iterates `PATCHES`, hands the assembled `EditPlan` to `EditApplier`. Prints the summary log and returns the exit code. Mirrors v1's `main()` so `claude-channels` only has to update the executable name. Also exposes `--emit-cache-key` and `--list-patches`.

**`patcher/elf.py`** — ELF64 read/write. Pure `struct.unpack`/`struct.pack`. Exposes `ElfLayout` (named tuple of `EhdrFields`, `[PhdrFields]`, `[ShdrFields]`), `parse(buf) -> ElfLayout`, `find_section(layout, name) -> ShdrFields`, `write_back(buf, layout)`. No assumptions about endianness beyond little-endian (the target binaries are all LE; we assert `e_ident[EI_DATA] == ELFDATA2LSB` at parse time and bail otherwise).

**`patcher/bun.py`** — Bun payload framing. Exposes `TRAILER = b"\n---- Bun! ----\n"`, the `Offsets` struct layout (`struct.Struct("<QIIIIII")` — byte_count u64, modules_ptr (offset u32 + length u32), entry_point_id u32, compile_exec_argv (offset u32 + length u32), flags u32), `ModuleRecord` dataclass (six StringPointers + four u8 enums), `locate(buf, elf) -> BunFraming`, `read_modules(buf, framing) -> list[ModuleRecord]`, `write_offsets(buf, framing, offsets)`. Encapsulates the trailer search, payload_len read, and the modules-table walk described in `inv-string-pointers.md`.

**`patcher/edits.py`** — `Edit`, `EditPlan`, `StringPointerRef`. Validation: sort by `offset`, walk and assert `prev.offset + len(prev.old) <= curr.offset` (overlap); reject coincident-offset edits; reject framing edits via `ctx.is_framing_offset()`; reject growable edits straddling StringPointer boundaries. The splice helpers in `EditApplier` operate purely on byte ranges within a bytearray; they do not know about ELF or Bun framing.

**`patcher/context.py`** — defines `DiscoveryContext` (view over the shared bytearray) and `EditApplier` (owns the bytearray). Helpers like `find_in_payload`, `find_regex_in_payload`, `containing_string_pointer(offset)`, `edit_within_region(edit)`, `is_latin1_region(ref)`, `is_framing_offset(off)`, and `find_balanced_close(start, limit)` (a JS brace walker used by patches that need to replace a function body) keep individual patches short and free of ad-hoc grep / framing code.

**`patcher/patches/__init__.py`** — the `Patch` protocol and the master `PATCHES` list. Patches are imported and listed in deterministic order: existing-six first (channels.py, ordered as in v1), then `model_alias.py`, then `availability.py`.

**`patcher/patches/channels.py`** — six `Patch` classes, one per v1 patch. Each one's `discover()` searches for its anchor pattern via `ctx.find_regex_in_payload` and emits `Edit` objects with `delta == 0` (i.e. `len(new) == len(old)`), `grows_region = None`, and an `expect_count` matching the number of sites in 2.1.195. The exact regexes are lifted verbatim from v1's `PATCHES` list.

**`patcher/patches/model_alias.py`** — the growable patches. `ArrayAppendPatch` inserts `,"<alias>"` before `]` at every regex match (instantiated twice via factory functions: once for the short arrays with `expect_count=4`, once for the hye array with `expect_count=1`). `ResolverSwitchPatch` inserts a new `case "<alias>":` arm into the yAn resolver switch, capturing the opusplan arm's identifier so the alias resolves to sonnet's concrete API id. The alias is parameterised via `CLAUDE_PATCHER_MODEL_ALIAS` env var (default `local`), read lazily on first `discover()` call and cached module-wide.

**`patcher/patches/availability.py`** — `AvailabilityGatePatch`: same-length body rewrite of `xa()` to `return!0`. Uses `ctx.find_balanced_close` to locate the closing brace of the function body. Only relevant for accounts with a managed-policy `availableModels` allowlist; no-op otherwise but always applied for defensive coverage.

**`patcher/diagnostics.py`** — `anchor_search(ctx, anchor, max_hits=4, context=120)` returns formatted snippet strings for failed-patch diagnostics. Each patch exposes a `diag_anchor: bytes | None` attribute; when a patch misses, the CLI grabs the anchor and prints matches with context.

---

## 6. Existing patch migrations

Each of the six v1 patches becomes one `Patch` class in `patcher/patches/channels.py`. Below: the shape, not the full body. Regexes / replacement bytes are reused verbatim from v1 (see `bin/patch-binary.py` lines 27–99 for the source-of-truth strings — these examples paraphrase for readability).

### Patch 1 — Feature gate (tengu_harbor)

```python
class FeatureGatePatch:
    name = "Feature gate (tengu_harbor)"
    may_grow = False
    expect_count = (1, 4)   # expect at least one, no more than four sites
    diag_anchor = b"tengu_harbor"
    PATTERN = rb'\{return [a-zA-Z0-9_$]+\("tengu_harbor",!1\)\}'

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        matches = ctx.find_regex_in_payload(self.PATTERN)
        edits = []
        for m in matches:
            pad = m.end() - m.start() - len(b"{return!0") - len(b"}")
            new = b"{return!0" + b" " * pad + b"}"
            edits.append(Edit(
                offset=m.start(), old=m.group(0), new=new,
                patch_name=self.name,
            ))
        return edits
```

### Patch 2 — Org policy (channelsEnabled)

Pure literal find/replace. `discover()` finds every occurrence of `channelsEnabled!==!0` in the payload (~4 matches expected) and emits an `Edit` for each, with `new = b"channelsEnabled===!0"`.

### Patch 3 — Channel allowlist bypass

```python
class AllowlistBypassPatch:
    name = "Channel allowlist bypass"
    may_grow = False
    expect_count = (1, 2)
    diag_anchor = b'kind:"allowlist"'
    PATTERN = rb'if\(![a-zA-Z0-9_$]+\.dev\)return\{action:"skip",kind:"allowlist"'
    INNER = re.compile(rb"!\w+\.dev")

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            inner = self.INNER.search(m.group(0))
            inner_start = m.start() + inner.start()
            old = inner.group(0)
            new = b"!1" + b" " * (len(old) - 2)
            edits.append(Edit(
                offset=inner_start, old=old, new=new,
                patch_name=self.name,
            ))
        return edits
```

### Patch 4 — Dev channels dialog auto-accept

Same shape as Patch 3: outer regex anchors the location, inner regex (`!\w+\(\)`) picks the sub-expression to overwrite with `!0 ` + spaces.

### Patch 5 — Channel notification suppression

Same shape as Patch 3, different outer regex (`if\(!VAR\.dev\)VAR\.push\(\{entry:VAR,why:"server: entries need`), same `!VAR.dev` → `!1` + spaces sub-edit.

### Patch 6 — Dynamic workflows master gate (Y2)

Single `regex_pad`-style edit. `new = b"return!0" + b" " * pad`. Same logic as Patch 1.

All six emit edits with `delta == 0` (i.e. `len(new) == len(old)`). The driver classifies them as same-length in step 7 of §4 and applies them in step 8 — they do not shift offsets, so the order among them is irrelevant.

---

## 7. Model alias subsystem

This is the new capability. It exists in `patcher/patches/model_alias.py` and provides the only growable patches in the current v2 registry.

### Sites touched

From `inv-validation-gates.md` and `inv-agent-tool-enum.md`, the alias must reach:

| Site | Offset (v2.1.195) | Variable | Same-length feasible? | Reason |
|---|---|---|---|---|
| S1 | `0xdf99789` | `Nff` schema enum (Agent tool zod) | No | Adding a 5th element to `["sonnet","opus","haiku","fable"]` grows by `,"local"` = 8 bytes. Zod validates exact membership; we cannot replace an existing slot without losing a real model. |
| S2 | `0xd81f5e8` | `hye` (alias allowlist for `v0()`) | No | Same reason. We need `v0("local") === true`. |
| S3 | `0xd81f644` | `spd` (alias allowlist for `tU()`) | No | Same reason. |
| S4 | `0xde3c6ba` | `tMe` (CLI picker array) | No | Same reason. Plus this controls picker display. |
| S5 | `0xde44cb7` | `oMe` (TUI picker array) | No | Same reason. |
| S6 | resolver `zo()` switch (~`0xd824abf`) | switch chain | No | New `case "local":` needs a JS arm. Variable length. |
| S7 | `naa()` slogan if/else | switch chain | Optional | If we want a non-"Custom model (…)" description in the picker. Pure cosmetic. |
| S8 | `$h()` label switch | switch chain | Optional | Pretty label for the canonical ID form. Cosmetic. |
| S9 | `bio()` family bucket | switch chain | Optional | Picker ordering. Cosmetic. |
| S10 | new builder function (like `yio`) + `Oap()` call site | function body + caller | Optional | Hardcoded picker entry. Cosmetic. If skipped, the entry falls through to `naa()` → `"Custom model (local)"` description, which is acceptable for v2 ship. |

Mandatory: S1–S6. Cosmetic: S7–S10. v2 ships with S1–S6 only; S7–S10 are left as a follow-up (the picker will render via the `ANTHROPIC_CUSTOM_MODEL_OPTION` env-var route rather than `naa()`, which after empirical checking turned out to only handle full API IDs, not novel short aliases — see the wrapper section of `bin/patcher/README.md`).

### Encoding each touch as Edits

Each edit below specifies an exact `(old, new)` byte string and an anchor regex used to *locate* the offset. Anchor regexes are re-evaluated at every run — hardcoded offsets are listed only as a sanity cross-check, never consulted by the patcher.

**S1 (`Nff` zod enum), S3 (`spd`), S4 (`tMe`), S5 (`oMe`)** — four array literals of identical shape: `["sonnet","opus","haiku","fable"]`.

```
anchor_regex = rb'\["sonnet","opus","haiku","fable"\]'
expect_count = 4       # four matches across the bundle
old          = b']'    # anchored at the closing bracket
new          = b',"local"]'
delta        = +8 per edit, +32 total for these four
```

Patches use `match.end()-1` (the position of `]`) as the edit offset and confirm via `ctx.containing_string_pointer(offset)` that each hit lies inside `module[0].contents`. All four are handled by a single `ArrayAppendPatch(anchor=..., expect_count=4)` instance.

> **Empirical note:** the architecture originally predicted 3 matches (assuming `spd` and one of `tMe`/`oMe` were the same literal). The bundle actually contains 4 distinct copies. `expect_count` was updated to match; a future release drifting to 3 or 5 will trip the check and force investigation rather than silently over- or under-editing.

**S2 (`hye`)** — longer array ending `..."opusplan"]`. The S1 anchor would match the prefix but not the closing bracket. Use a literal suffix:

```
anchor_regex = rb'"opusplan"\]'
expect_count = 1
old          = b']'
new          = b',"local"]'
delta        = +8
```

`"opusplan"]` is unique inside `module[0].contents` (verified by `grep -cP` against the unpatched bundle). Handled by a second `ArrayAppendPatch(anchor=..., expect_count=1)` instance.

**S6 (`yAn()` resolver switch)** — locate via the anchor pattern below. The capture group gives the minifier-mangled function identifier; the patch inlines it into the new arm so we never assume a specific `_An`-style name.

```
anchor_regex = re.compile(
    rb'case"opusplan":return ([a-zA-Z0-9_$]+)\(t\);'
    rb'(?:case"[a-zA-Z0-9_$]+":return [^;]+;)*'
    rb'default:return null'
)
expect_count = 1
old          = b'default:return null'
new          = b'case"' + alias + b'":return ' + ident + b'(t);default:return null'
```

The optional inner `(?:case"NAME":return BODY;)*` group tolerates additional case arms between `opusplan` and `default` (in 2.1.195 there's one, for `"best"`). If the resolver's `default:` case is itself missing (the minifier sometimes inlines a fall-through), `expect_count = 1` fails and the patch is reported as missed; the alias still works for all the table-driven gates (S1–S5), only the `--model local` → canonical-name resolution falls back to whatever `default:` would have returned. Documented limitation.

**Total growable delta**: `5 × 8 + delta_S6`. `delta_S6` is computed at discover time based on the captured identifier length (typically `+26` bytes for `case"local":return XX(t);` — verified on 2.1.195 producing +66 bytes total).

### StringPointer rewrite — generic path

Per the generic algorithm in §4 step 10, no patch-specific framing code is required for the model-alias edits. Each edit declares its `grows_region` (the containing StringPointer, here always `module[0].contents` for v2). The applier then handles offset and length bumps uniformly:

- Every StringPointer field whose original `offset + payload_start` is strictly past every edit's byte range has its `offset` bumped by the sum of those deltas.
- The single StringPointer whose `grows_region == self_ref` has its `length` bumped by `delta`. For v2 this is always `module[0].contents`, but the algorithm is not specialised to that field: a future patch that grows `module[3].contents` will follow the same code path.
- `Offsets.byte_count`, `payload_len`, and `Offsets.modules_ptr.offset` bump unconditionally by `total_delta` (the modules table and tail are always after every legal insertion site, by the region-validation guarantee).

**Double-count avoidance**: the bump phase reads the original `(offset, length)` snapshot once from the parsed structs at the start of step 10 and computes all new values against that snapshot. Five inserts into `module[0].contents` produce one `length += total_delta` write, not five compounding writes against partial state.

### Encoding precondition

`module[0]` has `encoding == 1` (Latin1) in 2.1.195. The validator (§4 step 6) refuses any growable edit whose `new` bytes are not pure ASCII when the containing module is Latin1. The alias name `local` is ASCII, so this is satisfied; the env-var-driven `CLAUDE_PATCHER_MODEL_ALIAS` is filtered against `re.fullmatch(rb'[A-Za-z0-9_-]{1,16}', alias)` at first-discover time.

### Why not Strategy B

Re-stating §2 with the concrete site: `Nff` is built at module-load time as `Nff = ve(() => H.object({..., model: H.enum([...]), ...}))`. The enum array is constructed at the *first* call to `Nff()` (Bun lazy thunk), which happens before any patched-in shim could run, regardless of whether we add a new module. Even if we entered the process before that thunk fires, we have no way to mutate the closed-over array literal because `H.enum` clones its argument internally (zod's `ZodEnum` stores the value list on the schema instance, frozen). See `inv-module-graph.md` §4 for the full reasoning.

---

## 8. Cache invalidation

The launcher (`bin/claude-channels`) caches the patched binary at `~/.local/share/claude-channels/claude-patched-{hash}`. v2 expands the cache key so any change in inputs that affects the produced bytes invalidates the cache:

```bash
hash_input=$(
    sha256sum "$SOURCE_BINARY"          | cut -d' ' -f1   # input binary
    sha256sum bin/claude-channels       | cut -d' ' -f1   # launcher itself
                                                          # (arg-parsing changes
                                                          #  can alter behaviour
                                                          #  without any .py diff)
    find bin/patcher -type f -name '*.py' -print0 \
      | sort -z \
      | xargs -0 sha256sum \
      | cut -d' ' -f1
    python -m patcher --emit-cache-key                    # patches contribute
                                                          # their own cache_key()
)
cache_key=$(echo "$hash_input" | sha256sum | cut -c1-16)
```

The `--emit-cache-key` mode walks `PATCHES` and concatenates each patch's `cache_key()` return value (default: hash of the patch class source; override to incorporate runtime parameters). This means a patch declaring a new env-var input (e.g. `model_alias.py` reading `CLAUDE_PATCHER_MODEL_ALIAS`) participates in cache invalidation without the launcher needing to know about that variable.

Pruning: the launcher's existing "keep the most recent 3 cached binaries, delete older" policy is unchanged.

---

## 9. Testing

### Unit (no real binary needed)

In `tests/patcher/`:

- `test_elf.py` — parse a hand-crafted minimal ELF64 file (built in-test from `struct.pack`), assert section table is read correctly, modify `sh_size` and re-serialise, assert round-trip equality.
- `test_bun.py` — build a synthetic Bun payload (8-byte length prefix, one fake module, valid Offsets struct, trailer) and assert `bun.locate()` returns the expected `BunFraming`. Mutate the modules table programmatically and assert pointer bumps land on the expected fields.
- `test_edits.py` — assert `EditPlan.validate()` raises for overlapping edits, accepts non-overlapping ones, and `total_delta` sums correctly.
- `test_patches_channels.py` — for each of the six existing patches, run `Patch.discover()` against a fixture byte string carrying the canonical pre-match shape, assert the returned `Edit.new` is exactly what v1's `patch-binary.py` produces. Maintain v1 → v2 parity at the byte level.
- `test_patches_model_alias.py` — given a fixture containing `H.enum(["sonnet","opus","haiku","fable"])`, assert the patch produces an `Edit` that splices `,"local"` in the right place; assert the same for `hye`, `spd`, `tMe`, `oMe`.

### Integration (real binary, hermetic)

In `tests/integration/`:

- `test_modules_table_diff.py` — applies one growable edit and dumps the parsed modules table before/after surgery; asserts every StringPointer's new `(offset, length)` matches the closed-form math from §4 step 10 (offset += delta if past insert position; length unchanged except for the grown region). This is a structural assertion independent of "does the binary boot".
- `test_full_patch_no_growable.py` — apply only the six channels patches to a real 2.1.195 binary, assert all six match, `wc -c` is unchanged, `--version` returns `2.1.195 (Claude Code)`, and the six grep checks from `CLAUDE_CODE_PATCHING_GUIDE.md` all return 2 (or 1 for Patch 6).
- `test_full_patch_with_alias.py` — apply all patches including the model-alias patches, assert: file size = original + 66 bytes (5×8 + 26), `--version` succeeds, `--model local --help` exits 0 (no model-validation error), and grep over the produced bundle reports 5 occurrences of `"local"` (one per site S1–S5).
- `test_idempotency.py` — run the patcher twice on the same input, assert byte-identical outputs.
- `test_partial_failure.py` — feed a binary where one regex anchor has been mangled (we can simulate by replacing a known byte). Assert exit code 2, diagnostic output names the failed patch, the other five still apply.
- `test_expect_count.py` — feed a binary where a regex anchor has been DUPLICATED (e.g. an unrelated copy of `"opusplan"]` injected into a string literal). Assert the affected patch raises `PatchError` and the run exits non-zero, so a silent multi-site over-edit cannot ship.
- `test_ergonomics.py` — `python -m patcher` with no args prints usage; with one arg prints usage to stderr; with `--list-patches` prints the patch table.

### Manual smoke

For each new Claude Code release, run the integration suite. If a new-release smoke fails, the diagnostic output identifies which patch's anchor moved (and whether the failure was a missing match or an `expect_count` mismatch), and the matching `patches/*.py` file is the only place needing investigation.

---

## 10. Open questions

1. **Sourcemap StringPointers.** All zero-length in 2.1.195. If a future build ships with sourcemaps, the bump algorithm needs to walk into the sourcemap blob and update any internal payload-relative offsets. `inv-string-pointers.md` §"Open Questions" flags this. Mitigation: add an assert at parse time — bail with a clear error if any `ModuleRecord.sourcemap.length > 0`. Forces a deliberate investigation before silently producing a broken binary.

2. **`module_info` regions.** Same situation: zero-length today, unknown internal format. Same mitigation: assert non-presence at parse time.

3. **Bytecode cache invalidation.** **Resolved by the §1 spike.** The bytecode-enabled path works with a 5–6× cold-start penalty on first run, then normal cost on subsequent runs. Bun detects the source-hash mismatch and gracefully recompiles. No SIGBUS, no abort, no misexecution.

4. **Lazy `Nff` evaluation timing vs. Agent tool registration.** The Agent tool registers its `inputSchema` (which calls `Nff()`) once at tool-registry construction. We've assumed our patched string is read at that point — to verify, test that `Task(..., model: "local")` is accepted on the first agent invocation in a session, not just the second.

5. **`module[0].contents.length` growth — empirically verified.** The §1 spike closed this: growing `.length` does correctly extend the visible bundle, and the runtime reads the extended region.

6. **Section alignment after delta.** Several post-`.bun` sections (`.dynamic`, `.got`, `.bss`) carry non-trivial `sh_addralign`. The spike (N up to 4096) produced no misalignment failures, so the padding fallback in §11c is currently dead code — kept as defence in depth. If a future release adds a section with larger alignment, the check would trip and we'd reactivate the padding path.

7. **`xa()` and managed `availableModels` policy.** **Resolved.** `AvailabilityGatePatch` in `availability.py` rewrites `xa()` to `return!0` unconditionally. No-op for accounts without a managed policy; unblocks the alias for accounts that have one.

8. **`ANTHROPIC_CUSTOM_MODEL_OPTION` interaction.** The env var path is now the recommended way to surface the alias in the `/model` picker; the wrapper script at `bin/patcher/README.md` sets it automatically. Deeper picker patches (S7–S10) are still possible but not planned.

9. **Minifier identifier stability across releases.** S6 captures the resolver function name (e.g. `_An`) from the anchor and splices it into the new arm verbatim. This survives renaming inside a single bundle but does NOT survive a release where the resolver `case"opusplan"` arm is removed or refactored. The `expect_count = 1` check surfaces that condition; v2.1 will need a re-investigation if it trips.

10. **`bin/patch-binary.py` shim lifetime.** Initially planned as a 4-line forwarder to `patcher.cli.main()`, then deleted after one release cycle. Currently v1's `patch-binary.py` is unchanged; the launcher (`claude-channels`) still uses v1. Migration is pending.

11. **Wire-level alias routing.** The alias `local` resolves to sonnet's concrete API id (`_An(t)`) inside the client, but the model string that reaches the Anthropic API is still `"local"` (via the raw `--model` path, which stores the alias unchanged in `mainLoopModel`). The API 404s. A downstream proxy is the intended solution; a client-side `dp()` patch that runs `yAn()` on the model before the wire is an alternative but deferred.

---

## Appendix A — Source pointer cheat sheet (v2.1.195)

For reviewers re-deriving offsets on a new binary:

| Item | Source-of-truth | Anchor |
|---|---|---|
| Trailer location | Search whole file | `b"\n---- Bun! ----\n"` (16 bytes) |
| Offsets struct | 32 bytes before trailer | — |
| Payload start | `.bun` `sh_offset` + 8 (skip u64 length) | ELF section header |
| Modules table | `Offsets.modules_ptr` | — |
| Module record count | `modules_ptr.length / 52` | — |
| `hye` array | grep `hye=\["sonnet","opus"` | string literal |
| `spd` array | grep `spd=\["sonnet","opus","haiku","fable"\]` | string literal |
| `Nff` enum | grep `H\.enum\(\["sonnet","opus","haiku","fable"\]\)` | string literal |
| `tMe` array | grep `tMe=\["sonnet","opus"` | string literal |
| `oMe` array | grep `oMe=\["sonnet","opus"` | string literal |
| `yAn()` switch | grep `case"opusplan":return [\w$]+\(t\);` | unique in bundle |
| `xa()` function body | grep `function xa\(e,t\)\{` | unique in bundle |

For the six existing patches the anchors are as listed in `CLAUDE_CODE_PATCHING_GUIDE.md` §"Current patches" — those move v1 → v2 unchanged.

---

## Revision Log

The doc was refined via critique passes during design (design + feasibility critics, both opus). Findings that shaped the current shape:

- **Design §1: `BinaryContext` mutates under patches, leaking stale offsets.** Split §3 into immutable `DiscoveryContext` (patches' only input) and `EditApplier` (owns mutable buffer + delta log). (Later: the two were reunified over a single shared bytearray after the cleanup pass; the read-only contract is preserved by convention rather than by copy.)
- **Design §2: Overlap detection too loose — misses coincident growable inserts, framing-region edits, and silent multi-site regex matches.** Added `ordering_key` (later removed in cleanup as validate rejects all coincident-offset edits regardless), `expect_count`, and a `validate()` method that rejects framing edits and StringPointer-straddling inserts.
- **Design §3: Ascending in-place splice reallocates the 244 MB buffer per edit.** Pipeline §4 step 9a sorts DESCENDING and uses in-place `bytearray` slice assignment; original offsets remain valid throughout.
- **Design §4: `module[0].contents.length` fixup double-counts across multiple inserts.** §4 step 10 now snapshots original `(offset, length)` once via the parsed structs and computes all bumps against that snapshot, never against partial state.
- **Design §5: Strategy A's bytecode-cache assumption unproven.** Added §1 "Pre-implementation spike" as a gating requirement; the spike passed, closing this concern.
- **Design §6: Multi-growing-patch + boundary scenarios not addressed.** Validator requires growable edits to lie wholly within one StringPointer region; `expect_count` on every patch defends against silent multi-site matches.
- **Design §7: Cache key misses `claude-channels` and per-patch config.** §8 now hashes `bin/claude-channels` directly and calls `python -m patcher --emit-cache-key`, which aggregates each patch's `cache_key()` hook.
- **Design §8: 7th patch will reshape framework — `contents.length` and "JS bundle only" rules are hardcoded.** Generalised via `Edit.grows_region: StringPointerRef | None`; bump phase is uniform across all StringPointers.
- **Feasibility §1: `contents.length` growth is an extrapolation.** Acknowledged as Open Question §10 and gated on the spike; resolved when the spike passed.
- **Feasibility §2: Per-site byte spec under-specified (S2/S3 anchors, S6 minifier identifier).** §7 lists exact `anchor_regex`, `expect_count`, `old`, `new` for every site, with S6 capturing the resolver identifier from the anchor rather than hardcoding `iI`.
- **Feasibility §2: Hardcoded offsets in Appendix A might be consulted at runtime.** §7 explicitly states anchors are re-evaluated each run; hardcoded offsets are sanity cross-checks only.
- **Feasibility §2: Success criterion "renders `local` with sensible label" is unmeetable without S7–S10.** §1 success criteria acknowledged the picker limitation; a later empirical test showed the `naa()` fallback path doesn't handle novel short aliases either — resolved via the `ANTHROPIC_CUSTOM_MODEL_OPTION` wrapper documented in the README.
- **Feasibility §3: ELF fix-ups missing `p_filesz == p_memsz` assertion, section alignment check, PT_NOTE coverage explicitness.** §4 step 4 asserts `p_filesz == p_memsz` pre-patch; step 11c adds alignment check + padding strategy; step 11e documents that the rule covers PT_NOTE / PT_GNU_* by construction.
- **Feasibility §3: `payload_len` location wording ambiguous.** §4 step 10d now states explicitly that `.bun` does not move; only post-`.bun` sections shift.
- **Feasibility §4: `module[0].contents` Latin1 encoding precondition unstated.** §4 step 4 asserts `encoding == 1`; validator rejects non-ASCII growable bytes; §7 "Encoding precondition" filters the env-var input.
- **Feasibility §4: Minifier semicolon/terminator framing assumption.** §7 S6 uses an anchor regex that requires the `default:return null` suffix, avoiding ambiguity about whether `;` or `}` precedes the injected arm.
- **Feasibility §5: No intermediate verification gates — modules-table diff, strace, bytecode-disabled run, delta fuzz.** §9 adds integration tests covering these paths.

Post-implementation cleanup pass (12 findings applied, framework went from 1975 LOC to 1426 LOC, byte-identical output) — see the design's Revision Log for the full list.
