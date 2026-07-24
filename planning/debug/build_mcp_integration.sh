#!/usr/bin/env bash
set -euo pipefail
PKG=/home/anl/picolet/packages/picolet-runtime
SUB=$PKG/micropython
UNIX=$SUB/ports/unix
VARIANT_DIR=$PKG/variants/mcp/unix
BUILD=build-mcp-integration
SCRATCH=/tmp/claude-1000/-home-anl-picolet/5a3497ce-2c19-4975-be72-6023e3f69502/scratchpad
export PICOLET_RUNTIME_ROOT=$PKG
echo "=== integration sha ==="; git -C "$SUB" rev-parse --short integration
echo "=== [1] mpy-cross ==="; make -C "$SUB/mpy-cross" -j >/dev/null
echo "=== [2] submodules (libffi + mbedtls) ==="
make -C "$UNIX" -j submodules VARIANT_DIR="$VARIANT_DIR" BUILD="$BUILD" MICROPY_STANDALONE=1 MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1 >/dev/null
echo "=== [3] empty romfs ==="; mkdir -p "$SCRATCH/empty_src"
python3 -m mpremote romfs --output "$SCRATCH/empty.romfs" build "$SCRATCH/empty_src" >/dev/null 2>&1
# The unix port derives the embedded-romfs symbol by mangling the ROMFS_IMG
# path (objcopy --redefine-sym _binary_<mangled>_start=romfs_embedded_data).
# A deep /tmp relative path with ../ and dots breaks the match, leaving
# romfs_embedded_data undefined at link. Use a clean, shallow, underscores-
# only filename in the port dir so the mangled name matches objcopy's symbol
# (mirrors build-runtime.sh's ROMFS_IMG_SAFE approach).
cp "$SCRATCH/empty.romfs" "$UNIX/picolet_romfs_empty.romfs"
ROMFS_REL="picolet_romfs_empty.romfs"
echo "=== [4] deplibs ==="
make -C "$UNIX" -j VARIANT_DIR="$VARIANT_DIR" BUILD="$BUILD" MICROPY_STANDALONE=1 PICOLET_RUNTIME_ROOT="$PKG" MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1 deplibs >/dev/null
echo "=== [5] main build ==="
make -C "$UNIX" -j VARIANT_DIR="$VARIANT_DIR" BUILD="$BUILD" ROMFS_IMG="$ROMFS_REL" PICOLET_RUNTIME_ROOT="$PKG" MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1 >/dev/null
echo "=== [6] strip + install to scratch ==="
cp "$UNIX/$BUILD/micropython" "$SCRATCH/picolet-mcp-integration"
strip --strip-unneeded "$SCRATCH/picolet-mcp-integration"
ls -la "$SCRATCH/picolet-mcp-integration"
echo "SIZE_BYTES=$(wc -c < "$SCRATCH/picolet-mcp-integration")"
echo "=== BUILD DONE ==="
