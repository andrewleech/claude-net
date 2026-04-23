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

if ! command -v tmux >/dev/null 2>&1; then
    case "\$(uname -s)" in
        Darwin) tmux_hint="brew install tmux" ;;
        Linux)  tmux_hint="sudo apt install tmux  # or your package manager" ;;
        *)      tmux_hint="install tmux via your package manager" ;;
    esac
    echo "NOTE: tmux is not installed. The install will continue, but" >&2
    echo "      remote inject from the web dashboard will not work" >&2
    echo "      until you install tmux: \$tmux_hint" >&2
fi

HUB="${hubUrl}"
INSTALL_DIR="\$HOME/.local/share/claude-channels/bin"
BIN_DIR="\$HOME/.local/bin"
SETTINGS="\$HOME/.claude/settings.json"

mkdir -p "\$INSTALL_DIR" "\$BIN_DIR" "\$HOME/.claude"

echo "[1/5] Downloading claude-channels + mirror binaries from \${HUB}…"
for f in claude-channels claude-net-mirror-push claude-net-mirror-agent \\
         patch-binary.py mirror-agent.bundle.js; do
    curl -fsSL "\$HUB/bin/\$f" -o "\$INSTALL_DIR/\$f"
done
chmod +x "\$INSTALL_DIR/claude-channels" \\
         "\$INSTALL_DIR/claude-net-mirror-push" \\
         "\$INSTALL_DIR/claude-net-mirror-agent"

# Statusline script lives in ~/.claude/ because that's where Claude Code
# resolves relative paths from in settings.json.statusLine.command.
echo "[1b/5] Installing statusline script…"
curl -fsSL "\$HUB/bin/statusline.py" -o "\$HOME/.claude/statusline.py"
chmod +x "\$HOME/.claude/statusline.py"

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

echo "[2/5] Registering claude-net MCP server…"
claude mcp add \\
    --scope user \\
    -e CLAUDE_NET_HUB="\$HUB" \\
    --transport stdio \\
    claude-net -- bash -c 'T=\$(mktemp /tmp/claude-net-plugin.XXXXXXXXXX) && P="\$T.ts" && mv "\$T" "\$P" && curl -fsSL '"\$HUB"'/plugin.ts -o "\$P" && exec bun run "\$P"' \\
    2>&1 | grep -v "already configured" || true

echo "[3/5] Merging mirror hooks + launch config into \${SETTINGS}…"
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

# Seed claudeNet.workspaces + claudeNet.launch when absent so users
# can discover + edit them from settings.json. Don't overwrite existing
# user configuration.
d.setdefault("claudeNet", {})
cn = d["claudeNet"]
if "workspaces" not in cn:
    cn["workspaces"] = {"roots": ["~/projects"]}
if "launch" not in cn:
    cn["launch"] = {"allow_dangerous_skip": True}

tmp = settings_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\\n")
os.replace(tmp, settings_path)
PY

echo "[4/5] Configuring statusline in \${SETTINGS}…"
python3 - "\$SETTINGS" "\$HOME/.claude/statusline.py" <<'PY'
import json, sys
settings_path, script = sys.argv[1], sys.argv[2]
with open(settings_path) as f:
    d = json.load(f)
command = f'python3 "{script}"'
cur = d.get("statusLine") or {}
cur_cmd = cur.get("command", "")
if cur_cmd == command:
    print(f"  Statusline already points at {script!s} — no change.")
elif cur_cmd and "statusline.py" not in cur_cmd:
    # User already has a custom statusLine — don't stomp on it. They
    # miss out on the dashboard's live context/5h indicator; the
    # mirror-agent accepts POSTs from any process so a motivated user
    # can wire forward_to_mirror_agent() into their own script.
    print(
        "  WARN: a custom statusLine.command is already set; "
        "leaving it in place. Remove it from settings.json and re-run "
        "/setup to opt in to the claude-net statusline."
    )
else:
    d["statusLine"] = {"type": "command", "command": command}
    with open(settings_path, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\\n")
    print("  Installed claude-net statusline.")
PY

echo "[5/5] Done."
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
