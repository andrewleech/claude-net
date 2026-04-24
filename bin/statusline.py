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

    # Fallback: glob for any state file matching cwd.
    # Multiple plugins can write state for the same cwd (concurrent
    # sessions, the claude-net-host control socket, stale files from
    # crashed processes). Collect every cwd-match within the 24h window
    # and pick the one that best reflects the live session: prefer
    # online > disconnected > error, and within a tier the most
    # recently updated. Returning the first glob hit blindly means the
    # statusline will flap to whatever ordering readdir happened to
    # give — including stale 'disconnected' files shadowing a live
    # 'online' write.
    status_rank = {"online": 0, "disconnected": 1, "error": 2}
    best = None
    best_key = None
    try:
        for path in glob.glob(os.path.join(state_dir, "state-*.json")):
            try:
                with open(path) as f:
                    state = json.load(f)
                if state.get("cwd") != cwd:
                    continue
                updated = state.get("updated_at", "")
                ts = 0.0
                if updated:
                    try:
                        ts = time.mktime(
                            time.strptime(updated[:19], "%Y-%m-%dT%H:%M:%S")
                        )
                        if time.time() - ts > 86400:
                            continue
                    except (ValueError, OverflowError):
                        pass
                key = (status_rank.get(state.get("status", ""), 99), -ts)
                if best_key is None or key < best_key:
                    best_key = key
                    best = state
            except (json.JSONDecodeError, OSError):
                continue
    except OSError:
        pass

    return best


# ── Colors ──────────────────────────────────────────────────────────────

GREEN = "\033[32m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"

# ── Build fields ────────────────────────────────────────────────────────
# Each field is (display_text, visible_length) where display_text includes
# ANSI codes and visible_length is the printable character count.

ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def vlen(s):
    """Visible length of a string (strip ANSI escape codes, count emoji as 2)."""
    clean = ANSI_RE.sub("", s)
    length = 0
    for ch in clean:
        cp = ord(ch)
        # Emoji and wide chars take 2 columns
        if cp > 0xFFFF or (0x1F300 <= cp <= 0x1FAFF) or (0x2600 <= cp <= 0x27BF):
            length += 2
        else:
            length += 1
    return length


used_str = fmt_tokens(current_tokens)
total_str = fmt_tokens(window_size)
model = short_model(model_name)
ctx_clock = clock_emoji(ctx_pct)

fields = []
fields.append(f"{GREEN}{hostname}{RESET}: {CYAN}{dirname}{RESET}")
if session_label:
    fields.append(f"({session_label})")
fields.append(f"[{MAGENTA}{model}{RESET}]")
fields.append(f"{ctx_clock} {used_str}/{total_str}")

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
    fields.append(f"{rl_clock} {rl_color}5h:{rl_int}%{reset_str}{RESET}")

# claude-net section (only if state file exists)
cn_state = read_claude_net_state(project_dir)
if cn_state:
    status = cn_state.get("status", "")
    name = cn_state.get("name", "")
    short_name = name.split("@")[0] if name else ""
    if status == "online" and short_name:
        fields.append(f"{GREEN}{short_name}●{RESET}")
    elif status == "error":
        fields.append(f"{RED}!clash{RESET}")
    elif status == "disconnected" and short_name:
        fields.append(f"{YELLOW}{short_name}○{RESET}")

# ── Layout: wrap fields to fit terminal width ───────────────────────────
# stdin/stdout/stderr are all pipes so os.get_terminal_size() fails.
# /dev/tty connects to the controlling terminal regardless of redirections.


def get_terminal_cols():
    """Get terminal width via /dev/tty (works even when stdio is piped)."""
    try:
        import fcntl, termios, struct
        with open("/dev/tty") as tty:
            result = fcntl.ioctl(tty.fileno(), termios.TIOCGWINSZ, b"\x00" * 8)
            return struct.unpack("HHHH", result)[1]
    except Exception:
        return 0


term_cols = get_terminal_cols()

if term_cols <= 0:
    print(" ".join(fields))
else:
    lines = []
    current_line = ""
    current_len = 0
    for field in fields:
        flen = vlen(field)
        needed = flen + (1 if current_len > 0 else 0)  # space separator
        if current_len > 0 and current_len + needed > term_cols:
            lines.append(current_line)
            current_line = field
            current_len = flen
        else:
            if current_len > 0:
                current_line += " " + field
                current_len += 1 + flen
            else:
                current_line = field
                current_len = flen
    if current_line:
        lines.append(current_line)
    print("\n".join(lines))
