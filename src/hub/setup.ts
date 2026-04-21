import { Elysia } from "elysia";
import { resolveCanonicalHubUrl } from "./hub-url";

export interface SetupDeps {
  port: number;
}

/**
 * `GET /setup` returns a bash script that a fresh host can pipe to bash
 * (`curl <hub>/setup | bash`) to end up with:
 *  - claude-channels + mirror binaries installed under ~/.local/share/claude-channels/
 *    and symlinked into ~/.local/bin/.
 *  - claude-net MCP server registered user-wide (points at this hub).
 *  - Mirror hooks merged into ~/.claude/settings.json (idempotent, backed up
 *    first). Mirror is always on whenever claude-channels runs.
 *
 * All binaries are fetched from this hub's /bin/* endpoints so no GitHub
 * auth or remote access is required for private hubs.
 */
export function setupPlugin(deps: SetupDeps): Elysia {
  const { port } = deps;

  return new Elysia().get("/setup", ({ request, set }) => {
    const envHost = process.env.CLAUDE_NET_HOST;
    const hubUrl = resolveCanonicalHubUrl(request, envHost, port);

    set.headers["content-type"] = "text/plain";

    return `#!/bin/bash
set -euo pipefail
# claude-net + mirror-session one-shot installer.
# Generated dynamically by ${hubUrl}/setup — do not cache.

if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: claude-net needs 'bun' on PATH." >&2
    echo "Install: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

HUB="${hubUrl}"
INSTALL_DIR="\$HOME/.local/share/claude-channels/bin"
BIN_DIR="\$HOME/.local/bin"
SETTINGS="\$HOME/.claude/settings.json"

mkdir -p "\$INSTALL_DIR" "\$BIN_DIR" "\$HOME/.claude"

echo "[1/4] Downloading claude-channels + mirror binaries from \${HUB}…"
for f in claude-channels claude-net-mirror-push claude-net-mirror-agent \\
         patch-binary.py mirror-agent.bundle.js; do
    curl -fsSL "\$HUB/bin/\$f" -o "\$INSTALL_DIR/\$f"
done
chmod +x "\$INSTALL_DIR/claude-channels" \\
         "\$INSTALL_DIR/claude-net-mirror-push" \\
         "\$INSTALL_DIR/claude-net-mirror-agent"

# Symlink into PATH (idempotent)
for f in claude-channels claude-net-mirror-push claude-net-mirror-agent; do
    ln -snf "\$INSTALL_DIR/\$f" "\$BIN_DIR/\$f"
done

# Retire any running mirror-agent daemon so the next claude-channels launch
# respawns against the just-installed bundle. The launcher's /health probe
# only detects liveness, not version, so a stale daemon would otherwise
# keep running the old code and the dashboard would show "NO MIRROR".
pkill -f 'claude-net-mirror-agent|mirror-agent\\.bundle\\.js' 2>/dev/null || true
rm -f /tmp/claude-net/mirror-agent-*.port 2>/dev/null || true

echo "[2/4] Registering claude-net MCP server…"
claude mcp add \\
    --scope user \\
    -e CLAUDE_NET_HUB="\$HUB" \\
    --transport stdio \\
    claude-net -- bash -c 'P=\$(mktemp /tmp/claude-net-plugin.XXXXXX.ts) && curl -fsSL '"\$HUB"'/plugin.ts -o "\$P" && exec bun run "\$P"' \\
    2>&1 | grep -v "already configured" || true

echo "[3/4] Merging mirror hooks into \${SETTINGS}…"
if [ ! -f "\$SETTINGS" ]; then
    echo '{}' > "\$SETTINGS"
fi
cp "\$SETTINGS" "\$SETTINGS.pre-mirror.bak"
python3 - "\$SETTINGS" "\$BIN_DIR/claude-net-mirror-push" <<'PY'
import json, os, sys
settings_path, push_bin = sys.argv[1], sys.argv[2]
with open(settings_path) as f:
    d = json.load(f)
d.setdefault("hooks", {})
entry = {"hooks": [{"type": "command", "command": push_bin, "timeout": 1}]}
for ev in ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
           "Stop", "SubagentStop", "Notification", "PreCompact", "PostCompact"):
    existing = d["hooks"].get(ev)
    if isinstance(existing, list):
        already = any(
            any(h.get("command") == push_bin for h in grp.get("hooks", []))
            for grp in existing
        )
        if not already:
            existing.append(entry)
    else:
        d["hooks"][ev] = [entry]
tmp = settings_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\\n")
os.replace(tmp, settings_path)
PY

echo "[4/4] Done."
echo ""
echo "Launch with 'claude-channels' instead of 'claude' to start a mirrored"
echo "session — the mirror-agent auto-starts and the session will appear on"
echo "the hub dashboard."
echo ""
echo "If anything looks wrong, restore the backup:"
echo "    cp \$SETTINGS.pre-mirror.bak \$SETTINGS"
`;
  });
}
