#!/usr/bin/env python3
"""
Same-length binary patcher for Claude Code's compiled Bun binary.

All replacements are exactly the same byte length as the original,
preserving the binary's embedded payload offsets and checksums.
"""
import re
import shutil
import sys


def apply_patches(data: bytes) -> tuple[bytes, list[str]]:
    log = []
    orig_len = len(data)

    # ── Patch 1: Channels feature gate (tengu_harbor → true) ─────────
    pat = rb'\{return [a-zA-Z0-9_$]+\("tengu_harbor",!1\)\}'
    matches = list(re.finditer(pat, data))
    if matches:
        log.append(f"  Patch 1: Feature gate (tengu_harbor) — {len(matches)} match(es)")
        for m in reversed(matches):
            repl = b"{return!0" + b" " * (len(m.group(0)) - 10) + b"}"
            data = data[: m.start()] + repl + data[m.end() :]
    else:
        log.append("  Patch 1: Feature gate — pattern not found")

    # ── Patch 2: Org policy channelsEnabled inversion ────────────────
    old, new = b"channelsEnabled!==!0", b"channelsEnabled===!0"
    count = data.count(old)
    if count:
        log.append(f"  Patch 2: Org policy (channelsEnabled) — {count} replacement(s)")
        data = data.replace(old, new)
    else:
        log.append("  Patch 2: Org policy — pattern not found")

    # ── Patch 3: Bypass permissions gate (tengu_disable_bypass → false)
    pat = rb"\{return [a-zA-Z0-9_$]+\(\"tengu_disable_bypass_permissions_mode\"\)\}"
    matches = list(re.finditer(pat, data))
    if matches:
        log.append(f"  Patch 3: Bypass permissions gate — {len(matches)} match(es)")
        for m in reversed(matches):
            repl = b"{return!1" + b" " * (len(m.group(0)) - 10) + b"}"
            data = data[: m.start()] + repl + data[m.end() :]
    else:
        log.append("  Patch 3: Bypass permissions gate — pattern not found")

    # ── Patch 4: Channel allowlist bypass ────────────────────────────
    # Non-dev channels (--channels flag) hit an allowlist check:
    #   if(!f.dev)return{action:"skip",kind:"allowlist"...}
    # Replace !f.dev with false (same length) to skip the check.
    old4 = b'if(!f.dev)return{action:"skip",kind:"allowlist"'
    new4 = b'if(false )return{action:"skip",kind:"allowlist"'
    count4 = data.count(old4)
    if count4:
        log.append(f"  Patch 4: Channel allowlist bypass — {count4} replacement(s)")
        data = data.replace(old4, new4)
    else:
        log.append("  Patch 4: Channel allowlist — pattern not found")

    if len(data) != orig_len:
        log.append(f"  FATAL: size changed ({orig_len} → {len(data)})")
        return data, log

    log.append(f"  Size unchanged ({orig_len} bytes)")
    return data, log


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <source> <output>", file=sys.stderr)
        sys.exit(1)

    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        data = f.read()

    print(f"Patching Claude Code binary ({len(data)} bytes)...", file=sys.stderr)
    patched, log = apply_patches(data)
    for msg in log:
        print(msg, file=sys.stderr)

    if len(patched) != len(data):
        sys.exit(1)

    with open(dst, "wb") as f:
        f.write(patched)
    shutil.copymode(src, dst)


if __name__ == "__main__":
    main()
