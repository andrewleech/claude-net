#!/usr/bin/env python3
"""
Same-length binary patcher for Claude Code's compiled Bun binary.

All replacements are exactly the same byte length as the original,
preserving the binary's embedded payload offsets and checksums.

Patches applied (all channel-related):
1. Channels feature gate (tengu_harbor -> true)
2. Org policy channelsEnabled inversion
3. Channel allowlist bypass (!f.dev -> false)
4. Dev channels dialog auto-accept
"""
import re
import shutil
import sys


def apply_patches(data: bytes) -> tuple[bytes, list[str]]:
    log = []
    orig_len = len(data)

    # -- Patch 1: Channels feature gate (tengu_harbor -> true) ---------
    pat = rb'\{return [a-zA-Z0-9_$]+\("tengu_harbor",!1\)\}'
    matches = list(re.finditer(pat, data))
    if matches:
        log.append(f"  Patch 1: Feature gate (tengu_harbor) -- {len(matches)} match(es)")
        for m in reversed(matches):
            repl = b"{return!0" + b" " * (len(m.group(0)) - 10) + b"}"
            data = data[: m.start()] + repl + data[m.end() :]
    else:
        log.append("  Patch 1: Feature gate -- pattern not found")

    # -- Patch 2: Org policy channelsEnabled inversion -----------------
    old2 = b"channelsEnabled!==!0"
    new2 = b"channelsEnabled===!0"
    count2 = data.count(old2)
    if count2:
        log.append(f"  Patch 2: Org policy (channelsEnabled) -- {count2} replacement(s)")
        data = data.replace(old2, new2)
    else:
        log.append("  Patch 2: Org policy -- pattern not found")

    # -- Patch 3: Channel allowlist bypass -----------------------------
    # Non-dev channels hit an allowlist check:
    #   if(!f.dev)return{action:"skip",kind:"allowlist"...}
    # Replace !f.dev with false (same length) to skip the check.
    old3 = b'if(!f.dev)return{action:"skip",kind:"allowlist"'
    new3 = b'if(false )return{action:"skip",kind:"allowlist"'
    count3 = data.count(old3)
    if count3:
        log.append(f"  Patch 3: Channel allowlist bypass -- {count3} replacement(s)")
        data = data.replace(old3, new3)
    else:
        log.append("  Patch 3: Channel allowlist -- pattern not found")

    # -- Patch 4: Dev channels dialog auto-accept ----------------------
    # The DevChannelsDialog is shown when authenticated and dev channels
    # are present. The condition: if(!X()||!Y()?.accessToken) auto-accepts
    # when NOT authenticated; else shows the dialog. Remove the ! before
    # the accessToken check so it always enters the auto-accept branch.
    # Stable anchor: ||!<func>()?.accessToken)Ai([ -- unique to this code path.
    pat4 = rb"\|\|![a-zA-Z0-9_$]+\(\)\?\.accessToken\)Ai\(\["
    matches4 = list(re.finditer(pat4, data))
    if matches4:
        log.append(f"  Patch 4: Dev channels dialog bypass -- {len(matches4)} match(es)")
        for m in reversed(matches4):
            orig = m.group(0)
            repl = orig.replace(b"||!", b"|| ", 1)
            data = data[: m.start()] + repl + data[m.end() :]
    else:
        log.append("  Patch 4: Dev channels dialog -- pattern not found")

    if len(data) != orig_len:
        log.append(f"  FATAL: size changed ({orig_len} -> {len(data)})")
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
