#!/usr/bin/env bash
# Build the single-file claude-net plugin binary: the picolet linux-x64/mcp
# runtime with the plugin's app romfs appended.
#
# Thin wrapper around package-plugin.py, which does the actual work (romfs
# staging, version-lockstep check, trailer append). Requires `uv` on PATH;
# `uv run --script` installs the script's declared dependency (mpremote)
# into an ephemeral/cached venv, so no host packages are mutated.
#
# Usage:
#   scripts/package-plugin.sh [--runtime PATH] [--output PATH] [-v]
#
# See package-plugin.py's module docstring for the packaging contract.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec uv run --script "$SCRIPT_DIR/package-plugin.py" "$@"
