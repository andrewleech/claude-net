#!/usr/bin/env bash
# Native (non-docker) TLS-enabled build of the picolet cli variant.
# SSL flags overridden on the make command line (cli .mk sets them =0).
# Builds into a fresh build dir so no docker-compiled objects are mixed in.
set -euo pipefail

PKG=/home/corona/picolet/packages/picolet-runtime
SUB=$PKG/micropython
UNIX=$SUB/ports/unix
VARIANT_DIR=$PKG/variants/cli/unix
BUILD=build-picolet-mcp
SCRATCH=/tmp/claude-1000/-home-anl-picolet/5a3497ce-2c19-4975-be72-6023e3f69502/scratchpad

export PICOLET_RUNTIME_ROOT=$PKG

echo "=== [1] mpy-cross (already built, ensure) ==="
make -C "$SUB/mpy-cross" -j >/dev/null

echo "=== [2] submodules (libffi + mbedtls) ==="
make -C "$UNIX" -j submodules \
    VARIANT_DIR="$VARIANT_DIR" BUILD="$BUILD" MICROPY_STANDALONE=1 \
    MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1 >/dev/null

echo "=== [3] empty romfs ==="
mkdir -p "$SCRATCH/empty_src"
python3 -m mpremote romfs --output "$SCRATCH/empty.romfs" build "$SCRATCH/empty_src"
ROMFS_REL=$(realpath --relative-to="$UNIX" "$SCRATCH/empty.romfs")
echo "romfs rel: $ROMFS_REL"

echo "=== [4] deplibs (libffi build) ==="
make -C "$UNIX" -j \
    VARIANT_DIR="$VARIANT_DIR" BUILD="$BUILD" MICROPY_STANDALONE=1 \
    PICOLET_RUNTIME_ROOT="$PKG" \
    MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1 \
    deplibs

echo "=== [5] main build (SSL on) ==="
make -C "$UNIX" -j \
    VARIANT_DIR="$VARIANT_DIR" BUILD="$BUILD" \
    ROMFS_IMG="$ROMFS_REL" \
    PICOLET_RUNTIME_ROOT="$PKG" \
    MICROPY_PY_SSL=1 MICROPY_SSL_MBEDTLS=1

echo "=== [6] strip + install ==="
cp "$UNIX/$BUILD/micropython" "$SCRATCH/picolet-mcp-tls"
strip --strip-unneeded "$SCRATCH/picolet-mcp-tls"
ls -la "$SCRATCH/picolet-mcp-tls"
echo "SIZE_BYTES=$(wc -c < "$SCRATCH/picolet-mcp-tls")"
echo "=== BUILD DONE ==="
