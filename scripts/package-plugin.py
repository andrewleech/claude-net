#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mpremote>=1.24"]
# ///
"""Package the claude-net MicroPython plugin as a single-file executable.

Produces one file: a copy of the picolet `mcp` runtime binary with the
plugin's own romfs (plugin.py, its `_*.py` helpers, the bundled CA, and the
`lib/{mpyjsonrpc,mpyschema,mpyws,mpyfastmcp}` packages) appended, using
picolet's append-at-end trailer format (24-byte "PYLT" trailer: magic,
version, payload size, CRC32 -- see
`packages/picolet-runtime/variants/common/romfs_trailer.h` in the picolet
repo). The runtime's own romfs-trailer detection auto-mounts the appended
payload at `/rom` and adds `/rom` + `/rom/lib` to `sys.path`, so the
packaged binary needs no sys.path setup beyond what `plugin.py` already
does for its own `lib/` directory.

This script does not build or modify the picolet runtime; it only reads an
already-built runtime binary (passed via --runtime) and appends the plugin
romfs to a copy of it.

Version lockstep: PLUGIN_VERSION (src/plugin-mpy/_version.py) must equal
the hub version (package.json). A mismatch fails the build -- see
`docs/history` in picolet and `planning/DECISIONS.md` (Q4) here for why the
two are versioned together instead of independently.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_SRC = REPO_ROOT / "src" / "plugin-mpy"
PACKAGE_JSON = REPO_ROOT / "package.json"

DEFAULT_RUNTIME = Path(
    "/home/anl/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-mcp"
)
DEFAULT_OUTPUT = REPO_ROOT / "build" / "claude-net-plugin-linux-x64"

# picolet's append-at-end romfs trailer format (FR-BP-5 in the picolet spec).
# Mirrors packages/picolet-runtime/variants/common/romfs_trailer.h byte for
# byte: magic "PYLT", u16 version, u16 flags (reserved), u64 payload_size,
# u32 payload_crc32, u32 pad (reserved). 24 bytes, little-endian.
_TRAILER_MAGIC = b"PYLT"
_TRAILER_VERSION = 1
_TRAILER_FMT = "<4sHHQII"
_TRAILER_SIZE = struct.calcsize(_TRAILER_FMT)
assert _TRAILER_SIZE == 24, f"trailer size mismatch: {_TRAILER_SIZE}"

# Runtime-owned files copied verbatim to the romfs root.
_ROOT_FILES = [
    "plugin.py",
    "_hub.py",
    "_identity.py",
    "_instructions.py",
    "_statusline.py",
    "_stdin_shim.py",
    "_version.py",
    "isrg_root_x1.der",
]

# lib/<pkg>/ directories shipped as-is (minus the exclusion patterns below),
# preserving the source layout so plugin.py's own `sys.path.insert(0,
# _HERE + "/lib")` bootstrap resolves `import mpyfastmcp` etc. unchanged.
_LIB_PACKAGES = ["mpyjsonrpc", "mpyschema", "mpyws", "mpyfastmcp"]

# Test/dev-only files that must never reach the shipped romfs.
_EXCLUDE_PATTERNS = [
    "test_*.py",
    "tests",
    "proof_taxonomy.py",
    "example_echo.py",
    "example_*.py",
    "demo_server.py",
    "mock_hub.py",
    "README.md",
    "__pycache__",
    ".pytest_cache",
    "*.pyc",
    # TLS fixtures used only by mpyws's own test suite (a self-signed
    # localhost cert/key) -- production TLS uses the bundled ISRG Root X1
    # CA (isrg_root_x1.der) via _hub.py, not these.
    "localhost_cert.der",
    "localhost_cert.pem",
    "localhost_key.pem",
]

_MAIN_PY = '''\
# Generated entry point -- see scripts/package-plugin.py.
#
# picolet's app-runner mode auto-runs /rom/main.py when present. plugin.py
# is imported as a module (not run as the top-level script) so its
# `if __name__ == "__main__":` guard does not fire; `plugin.main()` is
# invoked directly instead.
import asyncio

import plugin

asyncio.run(plugin.main())
'''


class VersionMismatch(RuntimeError):
    pass


def read_plugin_version() -> str:
    text = (PLUGIN_SRC / "_version.py").read_text()
    m = re.search(r'^PLUGIN_VERSION\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not m:
        raise RuntimeError(f"could not find PLUGIN_VERSION in {PLUGIN_SRC / '_version.py'}")
    return m.group(1)


def read_hub_version() -> str:
    data = json.loads(PACKAGE_JSON.read_text())
    return data["version"]


def check_version_lockstep() -> str:
    plugin_version = read_plugin_version()
    hub_version = read_hub_version()
    if plugin_version != hub_version:
        raise VersionMismatch(
            f"version lockstep failed: PLUGIN_VERSION={plugin_version!r} "
            f"(src/plugin-mpy/_version.py) != hub version={hub_version!r} "
            f"(package.json)"
        )
    return plugin_version


def _excluded(name: str) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in _EXCLUDE_PATTERNS)


def _copy_tree_filtered(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for entry in sorted(src.iterdir()):
        if _excluded(entry.name):
            continue
        if entry.is_dir():
            _copy_tree_filtered(entry, dst / entry.name)
        else:
            shutil.copy2(entry, dst / entry.name)


def build_romfs_staging(staging: Path, verbose: bool) -> None:
    staging.mkdir(parents=True, exist_ok=True)
    for name in _ROOT_FILES:
        src = PLUGIN_SRC / name
        if not src.is_file():
            raise RuntimeError(f"expected runtime file missing: {src}")
        shutil.copy2(src, staging / name)

    (staging / "main.py").write_text(_MAIN_PY)

    lib_root = staging / "lib"
    for pkg in _LIB_PACKAGES:
        src = PLUGIN_SRC / "lib" / pkg
        if not src.is_dir():
            raise RuntimeError(f"expected lib package missing: {src}")
        _copy_tree_filtered(src, lib_root / pkg)

    # FR-BP-6-style determinism: mpremote's romfs builder embeds file
    # mtimes in directory entries, so pin every file/dir to epoch 0. Same
    # inputs then produce byte-identical romfs images regardless of when
    # the build runs.
    for item in staging.rglob("*"):
        os.utime(item, (0, 0))
    os.utime(staging, (0, 0))

    if verbose:
        print("  romfs staging tree:", file=sys.stderr)
        for item in sorted(staging.rglob("*")):
            if item.is_file():
                print(f"    {item.relative_to(staging)}", file=sys.stderr)


def build_romfs_image(staging: Path, output: Path, verbose: bool) -> None:
    # --no-mpy: ship raw .py sources rather than mpy-cross-compiled .mpy.
    # The runtime binary reused here (P8 hard scope: no rebuilding
    # micropython) is built from a specific micropython commit; the
    # mpy-cross available on the packaging host is not guaranteed to emit
    # the same .mpy bytecode version, and a mismatch fails at import time
    # with "incompatible .mpy file". Raw .py avoids that risk entirely --
    # main.c's romfs import path supports both main.py and main.mpy, and
    # the same holds for every other module.
    cmd = [
        sys.executable,
        "-m",
        "mpremote",
        "romfs",
        "--no-mpy",
        "--output",
        str(output),
        "build",
        str(staging),
    ]
    if verbose:
        print(f"  {' '.join(cmd)}", file=sys.stderr)
    subprocess.run(cmd, check=True, capture_output=not verbose)


def pack_trailer(payload: bytes) -> bytes:
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    return struct.pack(
        _TRAILER_FMT,
        _TRAILER_MAGIC,
        _TRAILER_VERSION,
        0,  # flags
        len(payload),
        crc,
        0,  # pad
    )


def append_with_trailer(runtime_path: Path, romfs_path: Path, out_path: Path) -> None:
    """Write runtime || romfs payload || 24-byte trailer to out_path.

    Writes to a sibling temp path first and renames atomically so a failed
    or interrupted run never leaves a partially-written artifact at
    out_path.
    """
    runtime = runtime_path.read_bytes()
    payload = romfs_path.read_bytes()
    trailer = pack_trailer(payload)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.parent / f".{out_path.name}.tmp"
    with open(tmp_path, "wb") as f:
        f.write(runtime)
        f.write(payload)
        f.write(trailer)
    os.replace(tmp_path, out_path)
    out_path.chmod(0o755)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--runtime",
        type=Path,
        default=DEFAULT_RUNTIME,
        help=(
            "Path to the pre-built picolet linux-x64/mcp runtime binary "
            f"(default: {DEFAULT_RUNTIME})"
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Path to write the packaged single-file binary (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--keep-staging",
        action="store_true",
        help="Do not delete the romfs staging directory (debugging aid).",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    try:
        version = check_version_lockstep()
    except VersionMismatch as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not args.runtime.is_file():
        print(f"error: runtime binary not found: {args.runtime}", file=sys.stderr)
        return 1

    staging_parent = Path(tempfile.mkdtemp(prefix="claude-net-plugin-romfs-"))
    staging = staging_parent / "romfs_root"
    try:
        build_romfs_staging(staging, args.verbose)
        romfs_img = staging_parent / "plugin.romfs"
        build_romfs_image(staging, romfs_img, args.verbose)
        append_with_trailer(args.runtime, romfs_img, args.output)
    finally:
        if not args.keep_staging:
            shutil.rmtree(staging_parent, ignore_errors=True)
        elif args.verbose:
            print(f"  staging kept at: {staging_parent}", file=sys.stderr)

    size = args.output.stat().st_size
    print(f"PLUGIN_VERSION={version}")
    print(f"hub version={version}")
    print(f"runtime={args.runtime}")
    print(f"output={args.output} ({size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
