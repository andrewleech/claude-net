#!/usr/bin/env python3
import json, sys, io, os, socket, re, glob, time

if os.environ.get("VSCODE_PID"):
    sys.exit(0)

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

try:
    data = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

# ── Data extraction ─────────────────────────────────────────────────────

model_name = data.get("model", {}).get("display_name", "?")
ctx = data.get("context_window", {})
ctx_pct = round(ctx.get("used_percentage", 0) or 0)
window_size = ctx.get("context_window_size", 200000) or 200000

hostname = socket.gethostname()
project_dir = (data.get("workspace") or {}).get("project_dir") or data.get("cwd") or "?"
dirname = os.path.basename(project_dir) if project_dir != "?" else "?"
session_name = data.get("session_name") or ""
session_id = data.get("session_id") or ""
session_label = session_name if session_name else session_id[:8]

usage = ctx.get("current_usage")
if usage:
    current_tokens = (
        (usage.get("input_tokens") or 0)
        + (usage.get("cache_creation_input_tokens") or 0)
        + (usage.get("cache_read_input_tokens") or 0)
    )
else:
    current_tokens = 0

# Suppress output on startup (no API call yet) to avoid Ink layout glitch
if current_tokens == 0 and ctx_pct == 0:
    sys.exit(0)

# Rate limits (may be absent on older Claude Code / API users)
rl = (data.get("rate_limits") or {}).get("five_hour") or {}
rl_pct = rl.get("used_percentage")  # None if missing
resets_at = rl.get("resets_at")  # Unix epoch seconds, None if missing


# ── Helpers ─────────────────────────────────────────────────────────────

def fmt_tokens(n):
    if n == 0:
        return "0K"
    k = n / 1000
    if k >= 1000:
        return f"{k / 1000:.1f}M"
    if k >= 10:
        return f"{round(k)}K"
    return f"{k:.1f}K"


_KNOWN_MODELS = {"opus": "opus", "sonnet": "sonnet", "haiku": "haiku"}


def short_model(name):
    if not name:
        return "?"
    s = name.replace("Claude", "").strip()
    s = re.sub(r"\s*\[[^\]]+\]", "", s)  # strip [1m]
    s = re.sub(r"\s*\([^)]+\)", "", s)  # strip (1M context)
    s = re.sub(r"-\d{8}$", "", s)  # strip -20250514
    lower = s.lower()
    for key, canon in _KNOWN_MODELS.items():
        if key in lower:
            return canon
    return s.split()[0].lower() if s else "?"


CLOCKS = list("🕛🕐🕑🕒🕓🕔🕕🕖🕗🕘🕙🕚")


def clock_emoji(pct):
    idx = round((pct / 100) * 12) % 12
    return CLOCKS[idx]


def fmt_reset(epoch):
    if epoch is None:
        return ""
    remaining = epoch - time.time()
    if remaining <= 0:
        return ""
    minutes = int(remaining / 60)
    if minutes < 60:
        return f"({minutes}m)"
    hours = minutes // 60
    mins = minutes % 60
    if mins:
        return f"({hours}h{mins}m)"
    return f"({hours}h)"


def read_claude_net_state(cwd):
    """Read claude-net plugin state file. Returns dict or None."""
    state_dir = "/tmp/claude-net"
    ppid = os.getppid()

    # Primary: PPID-keyed file (plugin and statusline share Claude Code as parent)
    primary = os.path.join(state_dir, f"state-{ppid}.json")
    if os.path.exists(primary):
        try:
            with open(primary) as f:
                state = json.load(f)
            # Ignore stale files (>24h)
            updated = state.get("updated_at", "")
            if updated:
                try:
                    age = time.time() - time.mktime(
                        time.strptime(updated[:19], "%Y-%m-%dT%H:%M:%S")
                    )
                    if age > 86400:
                        return None
                except (ValueError, OverflowError):
                    pass
            return state
        except (json.JSONDecodeError, OSError):
            pass

    # Fallback: glob for any state file matching cwd
    try:
        for path in glob.glob(os.path.join(state_dir, "state-*.json")):
            try:
                with open(path) as f:
                    state = json.load(f)
                if state.get("cwd") == cwd:
                    updated = state.get("updated_at", "")
                    if updated:
                        try:
                            age = time.time() - time.mktime(
                                time.strptime(updated[:19], "%Y-%m-%dT%H:%M:%S")
                            )
                            if age > 86400:
                                continue
                        except (ValueError, OverflowError):
                            pass
                    return state
            except (json.JSONDecodeError, OSError):
                continue
    except OSError:
        pass

    return None


# ── Colors ──────────────────────────────────────────────────────────────

GREEN = "\033[32m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"

# ── Build output ────────────────────────────────────────────────────────

used_str = fmt_tokens(current_tokens)
total_str = fmt_tokens(window_size)
model = short_model(model_name)
ctx_clock = clock_emoji(ctx_pct)

parts = []
parts.append(f"{GREEN}{hostname}{RESET}")
parts.append(f": {CYAN}{dirname}{RESET}")
if session_label:
    parts.append(f" ({session_label})")
parts.append(f" [{MAGENTA}{model}{RESET}]")
parts.append(f" {ctx_clock} {used_str}/{total_str}")

# Rate-limit section (only if data present)
if rl_pct is not None:
    rl_int = round(rl_pct)
    rl_clock = clock_emoji(rl_int)
    reset_str = fmt_reset(resets_at) if resets_at and rl_int >= 50 else ""
    if rl_int >= 90:
        rl_color = RED
    elif rl_int >= 70:
        rl_color = YELLOW
    else:
        rl_color = DIM
    parts.append(f" {rl_clock} {rl_color}5h:{rl_int}%{reset_str}{RESET}")

# claude-net section (only if state file exists)
cn_state = read_claude_net_state(project_dir)
if cn_state:
    status = cn_state.get("status", "")
    name = cn_state.get("name", "")
    short_name = name.split("@")[0] if name else ""
    if status == "online" and short_name:
        parts.append(f" {GREEN}{short_name}●{RESET}")
    elif status == "error":
        parts.append(f" {RED}!clash{RESET}")
    elif status == "disconnected" and short_name:
        parts.append(f" {YELLOW}{short_name}○{RESET}")

print("".join(parts))
