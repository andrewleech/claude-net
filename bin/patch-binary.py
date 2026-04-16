#!/usr/bin/env python3
"""
Same-length binary patcher for Claude Code's compiled Bun binary.

All replacements are exactly the same byte length as the original,
preserving the binary's embedded payload offsets and checksums.

Patches applied (all channel-related):
1. Channels feature gate (tengu_harbor -> true)
2. Org policy channelsEnabled inversion
3. Channel allowlist gate bypass
4. Dev channels dialog auto-accept
5. Channel notification suppression (stale allowlist toast)

Exit codes:
  0 = all patches applied
  1 = fatal error (size changed, write failed)
  2 = some patches did not match (partial success, diagnostics printed)
"""
import re
import shutil
import subprocess
import sys


PATCHES = [
    {
        "name": "Feature gate (tengu_harbor)",
        "pattern": rb'\{return [a-zA-Z0-9_$]+\("tengu_harbor",!1\)\}',
        "type": "regex_pad",
        "replacement_prefix": b"{return!0",
        "replacement_suffix": b"}",
        # For diagnostics: search for this string nearby if the pattern fails
        "diag_anchor": b"tengu_harbor",
    },
    {
        "name": "Org policy (channelsEnabled)",
        "pattern": b"channelsEnabled!==!0",
        "type": "literal",
        "replacement": b"channelsEnabled===!0",
        "diag_anchor": b"channelsEnabled",
    },
    {
        "name": "Channel allowlist bypass",
        # Variable name before .dev changes per build (f in 2.1.108, z in 2.1.87)
        "pattern": rb'if\(![a-zA-Z0-9_$]+\.dev\)return\{action:"skip",kind:"allowlist"',
        "type": "regex_replace",
        "find": b"if(!", # 4 bytes
        "replace": b"if( ", # 4 bytes (space replaces !, makes condition always falsy)
        "diag_anchor": b'kind:"allowlist"',
    },
    {
        "name": "Dev channels dialog auto-accept",
        "pattern": rb"\|\|![a-zA-Z0-9_$]+\(\)\?\.accessToken\)[a-zA-Z0-9_$]+\(\[",
        "type": "regex_replace",
        "find": b"||!",
        "replace": b"|| ",
        "diag_anchor": b"accessToken)Ai(\x5b",  # Ai may change; anchor is just for diag search
        "diag_fallback_anchor": b".accessToken)",
    },
    {
        "name": "Channel notification suppression",
        # The TJ1 function generates UI notifications about channel problems.
        # For server-type entries, it pushes a "server: entries need
        # --dangerously-load-development-channels" message when !Y.dev.
        # Same technique as patch 3: replace if(!VAR.dev) with if( VAR.dev)
        "pattern": rb'if\(![a-zA-Z0-9_$]+\.dev\)[a-zA-Z0-9_$]+\.push\(\{entry:[a-zA-Z0-9_$]+,why:"server: entries need',
        "type": "regex_replace",
        "find": b"if(!",
        "replace": b"if( ",
        "diag_anchor": b'why:"server: entries need',
    },
]


def extract_diagnostics(data: bytes, anchor: bytes, context: int = 120) -> list[str]:
    """Find all occurrences of anchor in the binary and return surrounding context."""
    results = []
    start = 0
    while True:
        idx = data.find(anchor, start)
        if idx == -1:
            break
        lo = max(0, idx - context)
        hi = min(len(data), idx + len(anchor) + context)
        snippet = data[lo:hi]
        # Filter to printable ASCII for readability
        clean = "".join(chr(b) if 32 <= b < 127 else "." for b in snippet)
        results.append(f"    offset {idx}: ...{clean}...")
        start = idx + 1
        if len(results) >= 4:
            break
    return results


def apply_patches(data: bytes) -> tuple[bytes, list[str], int, int]:
    """Returns (patched_data, log_lines, applied_count, missed_count)."""
    log = []
    orig_len = len(data)
    applied = 0
    missed = 0

    for i, patch in enumerate(PATCHES, 1):
        name = patch["name"]
        ptype = patch["type"]

        if ptype == "regex_pad":
            pat = patch["pattern"]
            matches = list(re.finditer(pat, data))
            if matches:
                log.append(f"  Patch {i}: {name} -- {len(matches)} match(es)")
                prefix = patch["replacement_prefix"]
                suffix = patch["replacement_suffix"]
                for m in reversed(matches):
                    pad = len(m.group(0)) - len(prefix) - len(suffix)
                    repl = prefix + b" " * pad + suffix
                    data = data[: m.start()] + repl + data[m.end() :]
                applied += 1
            else:
                missed += 1
                log.append(f"  Patch {i}: {name} -- PATTERN NOT FOUND")

        elif ptype == "literal":
            old = patch["pattern"]
            new = patch["replacement"]
            count = data.count(old)
            if count:
                log.append(f"  Patch {i}: {name} -- {count} replacement(s)")
                data = data.replace(old, new)
                applied += 1
            else:
                missed += 1
                log.append(f"  Patch {i}: {name} -- PATTERN NOT FOUND")

        elif ptype == "regex_replace":
            pat = patch["pattern"]
            matches = list(re.finditer(pat, data))
            if matches:
                log.append(f"  Patch {i}: {name} -- {len(matches)} match(es)")
                for m in reversed(matches):
                    orig = m.group(0)
                    repl = orig.replace(patch["find"], patch["replace"], 1)
                    data = data[: m.start()] + repl + data[m.end() :]
                applied += 1
            else:
                missed += 1
                log.append(f"  Patch {i}: {name} -- PATTERN NOT FOUND")

        # Print diagnostics for failed patches
        if ptype in ("regex_pad", "regex_replace") and not (
            (ptype == "regex_pad" and matches) or
            (ptype == "regex_replace" and matches)
        ):
            for anchor_key in ("diag_anchor", "diag_fallback_anchor"):
                anchor = patch.get(anchor_key)
                if not anchor:
                    continue
                snippets = extract_diagnostics(data, anchor)
                if snippets:
                    log.append(f"    Diagnostic: found {len(snippets)} occurrence(s) of anchor '{anchor.decode('ascii', errors='replace')}':")
                    log.extend(snippets)
                    break
            else:
                log.append(f"    Diagnostic: no anchor strings found in binary")

        elif ptype == "literal" and data.count(patch["pattern"]) == 0 and missed > 0 and log[-1].endswith("PATTERN NOT FOUND"):
            anchor = patch.get("diag_anchor", patch["pattern"][:30])
            snippets = extract_diagnostics(data, anchor)
            if snippets:
                log.append(f"    Diagnostic: found {len(snippets)} occurrence(s) of anchor '{anchor.decode('ascii', errors='replace')}':")
                log.extend(snippets)
            else:
                log.append(f"    Diagnostic: anchor '{anchor.decode('ascii', errors='replace')}' not found in binary")

    if len(data) != orig_len:
        log.append(f"  FATAL: size changed ({orig_len} -> {len(data)})")
        return data, log, applied, missed

    log.append(f"  Size unchanged ({orig_len} bytes)")
    return data, log, applied, missed


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <source> <output>", file=sys.stderr)
        sys.exit(1)

    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        data = f.read()

    # Get version for diagnostics
    try:
        ver = subprocess.run(
            [src, "--version"], capture_output=True, text=True, timeout=10
        ).stdout.strip().split("\n")[0]
    except Exception:
        ver = "unknown"

    print(f"Patching Claude Code binary ({ver}, {len(data)} bytes)...", file=sys.stderr)
    patched, log, applied, missed = apply_patches(data)
    for msg in log:
        print(msg, file=sys.stderr)

    if len(patched) != len(data):
        sys.exit(1)

    if missed:
        print(f"\n  {applied} patch(es) applied, {missed} FAILED", file=sys.stderr)
        print(f"  Binary: {src}", file=sys.stderr)
        print(f"  Version: {ver}", file=sys.stderr)
        print(f"  Copy the output above to diagnose and fix the failed patch(es).", file=sys.stderr)

    with open(dst, "wb") as f:
        f.write(patched)
    shutil.copymode(src, dst)

    # Exit 2 for partial success so the launcher can distinguish
    sys.exit(2 if missed else 0)


if __name__ == "__main__":
    main()
