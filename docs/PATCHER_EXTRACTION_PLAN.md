# Patcher Extraction Plan

Split the binary patcher and the model-splitter feature out of `claude-net`
into independently-installable packages, with a plugin contract so patch
definitions ship with the product that owns them.

## Target topology

Three packages, three repos, one shared Python environment at install time.

### 1. `cc-patcher` — the engine (new standalone repo)

The reusable core. Contains no product-specific patches.

- Module `cc_patcher`: `elf`, `bun`, `edits`, `context`,
  `diagnostics`, `cli`, and the `Patch` protocol + registry loader.
- **Discovery**: at runtime the registry enumerates
  `importlib.metadata.entry_points(group="cc_patcher.patches")`,
  loads each, and extends `PATCHES`. The built-in list becomes empty — every
  patch arrives from a provider package.
- Console script `cc-patcher`:
  - `cc-patcher <src> <dst>` — apply all discovered patches.
  - `--list-patches` — patches in registry order (now grouped by provider).
  - `--list-providers` — installed provider packages + their entry points.
  - `--emit-cache-key` — hash of the discovered registry (unchanged mechanism,
    now folds in provider `cache_key()`s so the cached-binary key tracks which
    providers are installed).
- **Launch/cache helper** (new, extracted from `bin/claude-channels` bash):
  a Python API + `cc-patcher launch -- <argv>` that resolves the real
  Claude binary, patches it, caches by `sha256(binary) + emit-cache-key`, and
  execs. Both downstream launchers reuse this instead of duplicating the bash.
- Engine unit tests move here.

### 2. `claude-net-patcher` — claude-net's channel patches (package inside the claude-net repo)

- New subdir `patcher-ext/` in this repo: `pyproject.toml` +
  `claude_net_patcher/` package.
- Depends on `cc-patcher`.
- Contains `channels.py` (the 6 channel patches) moved from
  `bin/patcher/patches/channels.py`.
- Exposes `PATCHES` via
  `[project.entry-points."cc_patcher.patches"] channels = "claude_net_patcher:PATCHES"`.
- `bin/claude-channels` rewired to call `cc-patcher launch` (or the
  Python API) instead of `bin/patch-binary.py`.
- Deleted from claude-net: `bin/patcher/` (whole engine), `bin/patch-binary.py`.

### 3. `cc-local-router` — the model splitter (new standalone repo)

- Depends on `cc-patcher`.
- Python package `cc_local_router` carrying `model_alias.py` +
  `availability.py` (moved from `bin/patcher/patches/`), exposed via the same
  entry-point group.
- The Bun proxy `src/proxy/index.ts` kept as-is (TypeScript/Bun). This repo is
  intentionally mixed-language: Python patches + a Bun proxy. Rewriting the
  proxy in Python is out of scope — the streaming behaviour is subtle and
  already working.
- The `claude-v2` / `claude-channels-v2` wrappers, proxy autostart, and
  `claude-net-proxy-restart` helper move here.

## How the pieces compose

Patch discovery is additive and environment-scoped:

- Install `claude-net-patcher` alone → patched binary gets the channel patches.
- Install `cc-local-router` alone → patched binary gets the model-alias
  patches.
- Install both in one env → the patcher discovers all of them and produces a
  binary with channels **and** the model alias (today's `claude-channels-v2`).

The two launchers differ only in the runtime environment they set (channel MCP
args + mirror-agent vs. model-picker env + proxy autostart). Both apply
whatever patches are present in the environment. The cache key folds in the
provider set, so a binary patched with one provider is not mistaken for one
patched with both.

## Load-bearing correctness constraints (carried unchanged)

- Same-length edits stay byte-exact; growable edits keep the StringPointer +
  ELF fix-up. The extraction must not alter any patch's `discover()` output for
  a given input binary.
- Idempotence: re-running on an already-patched binary is a no-op / byte-stable.
- Partial-success semantics: a missed patch stays non-fatal (exit 2).
- `--version` still reports the real Claude Code version after patching.

## Execution — code workflow

Multi-agent workflow, model-tiered per the coding-workflow convention:

- **Phase 1 — Scaffold (sonnet).** Create the `cc-patcher` skeleton:
  package layout, `pyproject.toml`, the entry-point discovery loader, the
  `Patch` protocol import path, and the launch/cache helper signature. This
  must land first because both providers import from it.
- **Phase 2 — Extract & wire (sonnet, parallel per package, no path overlap).**
  - Patcher: move engine modules, implement discovery + launch/cache, empty the
    built-in registry, generalize the cache key.
  - `claude-net-patcher`: move `channels.py`, declare the entry point, rewire
    `bin/claude-channels`, delete `bin/patcher/` + `bin/patch-binary.py`.
  - `cc-local-router`: move `model_alias.py` + `availability.py`,
    declare the entry point, move the proxy + wrappers.
- **Phase 3 — Test (haiku).** Engine unit tests (edit/context roundtrip,
  overlap detection); a discovery test proving both providers register when
  installed together; a cache-key test proving the key changes with the
  provider set; an end-to-end patch of the real local Claude binary
  (fixture available on this machine) asserting `--version` + the existing
  behaviour greps still pass.
- **Phase 4 — Review (opus, standard + adversarial).** Focus: the extraction is
  behaviour-preserving (no `discover()` drift), the entry-point contract is
  correct, the cache key is sound, and no byte-level patch logic changed.
- **Loop.** Opus findings → sonnet fixes → re-run haiku tests → re-review with
  opus, until reviews are clean and tests pass.

## Not in this plan (explicit)

- No `git push` and no GitHub repo creation — new repos are scaffolded locally
  only. Publishing is a separate, explicitly-authorized step.
- Proxy stays Bun/TS; no Python rewrite.
- Cosmetic model-picker label patches (the "Sonnet" display) remain deferred.

## Open items to confirm before launch

- Repo locations: `~/cc-patcher` and `~/cc-local-router` as
  siblings of `~/claude-net`; the claude-net extension lives in-repo at
  `patcher-ext/`.
- Package/module names as above.
