"""Identity resolution: default name, transcript discovery, name persistence.

Mirrors the identity half of the bun plugin (`plugin.ts:249-518,
1474-1560`): the default `cwd-basename:user@host` name, discovery of the
active Claude Code session transcript under `~/.claude/projects/`, the
persisted-name file kept next to that transcript, reading Claude Code's
own `/rename` custom-title out of the transcript JSONL, and picking the
freshest of those candidates at startup.

MicroPython has no `os.getpid`/`os.getppid`/`socket.gethostname` on this
runtime (the `mcp` variant's `os` module is the lean picolet build) — both
are read through `ffi.open(None)` against libc instead. Neither `inspect`
nor `os.path`-style annotations are needed here; `os.path` itself (join,
basename, dirname) is present and used directly.

MicroPython's `re` module has no `{m,n}` bounded-repetition support (only
`*`/`+`/`?`), so the UUID-shaped-filename check below is a manual
character scan rather than a regex, unlike the bun original's
`/^[0-9a-f-]{32,40}$/i`.
"""

import binascii
import json
import os
import time

import ffi

_libc = None


def _get_libc():
    global _libc
    if _libc is None:
        _libc = ffi.open(None)
    return _libc


def hostname():
    """Host name, via `gethostname(2)` through libffi.

    No `socket.gethostname()` on this runtime's `os`/`socket` modules
    (see module docstring) — hence the direct libc call, matching the
    bun plugin's `os.hostname()`.
    """
    buf = bytearray(256)
    fn = _get_libc().func("i", "gethostname", "pi")
    fn(buf, len(buf))
    return bytes(buf).split(b"\x00", 1)[0].decode()


_ppid_cache = None


def getppid():
    """Parent process id, via `getppid(2)` through libffi, cached on first
    call.

    The plugin is spawned as a stdio subprocess of Claude Code, so the
    first call's result *is* Claude Code's own pid — matches the bun
    plugin's `process.ppid`, a value fixed once at process start rather
    than a live-queried one. Caching is required for that parity: shutdown
    is driven by stdin EOF (the parent has exited), and by then a live
    `getppid()` syscall would return the reaper's pid, not Claude Code's —
    corrupting both the register frame's `cc_pid` and the
    `/tmp/claude-net/state-<ppid>.json` statusline filename key.
    """
    global _ppid_cache
    if _ppid_cache is None:
        fn = _get_libc().func("i", "getppid", "")
        _ppid_cache = fn()
    return _ppid_cache


def username():
    """OS username: `$USER`, falling back to the literal string `"user"`.

    The bun plugin falls back to `os.userInfo().username` when `$USER` is
    unset; MicroPython has no `os.userInfo()` equivalent, so an unset
    `$USER` here degrades to a fixed placeholder rather than a real
    lookup — a documented, deliberate divergence from bun for the
    (rare, `$USER`-unset) case.
    """
    return os.getenv("USER") or "user"


def build_default_name():
    """`cwd-basename:user@host` — the plugin's default identity."""
    session = os.path.basename(os.getcwd())
    return "%s:%s@%s" % (session, username(), hostname())


_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def encode_project_dir_name(cwd):
    """Encode `cwd` to the directory name Claude Code uses under
    `~/.claude/projects/`: every non-alphanumeric byte becomes `-`
    (each byte individually — no run-collapsing), matching the bun
    original's `cwd.replace(/[^A-Za-z0-9]/g, "-")`."""
    return "".join(ch if ch in _ALNUM else "-" for ch in cwd)


def _looks_like_uuid(name):
    """True if `name` is 32-40 chars, all hex digits or dashes.

    Manual scan standing in for the bun original's `/^[0-9a-f-]{32,40}$/i`
    — see the module docstring for why a regex can't express this here.
    """
    if not (32 <= len(name) <= 40):
        return False
    for ch in name:
        if ch not in "0123456789abcdefABCDEF-":
            return False
    return True


def find_active_session_for_cc_pid(cwd, home=None):
    """Locate the newest `.jsonl` transcript for `cwd` under
    `~/.claude/projects/<encoded>/`.

    Returns `(session_id, transcript_path)` or `None` when the directory
    is absent, empty, unreadable, or the newest file's name isn't
    UUID-shaped. The filename's UUID portion is the session_id Claude
    Code uses for this session.
    """
    if not cwd:
        return None
    if home is None:
        home = os.getenv("HOME") or ""
    project_dir = os.path.join(
        home, ".claude", "projects", encode_project_dir_name(cwd)
    )
    try:
        entries = os.listdir(project_dir)
    except OSError:
        return None
    best_name = None
    best_mtime = -1
    for name in entries:
        if not name.endswith(".jsonl"):
            continue
        try:
            mtime = os.stat(os.path.join(project_dir, name))[8]
        except OSError:
            continue
        if mtime > best_mtime:
            best_mtime = mtime
            best_name = name
    if best_name is None:
        return None
    session_id = best_name[: -len(".jsonl")]
    if not _looks_like_uuid(session_id):
        return None
    return session_id, os.path.join(project_dir, best_name)


def read_custom_title_from_transcript(transcript_path):
    """Latest `{"type":"custom-title","customTitle":"..."}` line in a
    Claude Code session JSONL, written by the `/rename` slash command.

    Returns `(title, ts)` or `None` when the file is missing, unreadable,
    or has never been renamed. `ts` is the file's mtime in seconds — the
    JSONL line itself carries no timestamp, but mtime is a good-enough
    proxy for "when was this rename written" because `/rename` is the
    most recent kind of write that touches the file when no other
    activity is happening.
    """
    try:
        mtime = os.stat(transcript_path)[8]
    except OSError:
        return None
    # Stream the transcript line by line, keeping the LAST matching
    # custom-title. Do NOT slurp the whole file: a live Claude Code
    # transcript grows to many MB, and reading it into one string needs a
    # single allocation of that size — which fails the MicroPython heap at
    # startup (observed as "memory allocation failed" right after a
    # reconnect tears down the previous process). Peak memory here is one
    # line, not the whole (and ever-growing) file, and the common
    # never-renamed case no longer allocates the file at all.
    latest = None
    try:
        with open(transcript_path, "r") as f:
            for line in f:
                if '"custom-title"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if (
                    isinstance(obj, dict)
                    and obj.get("type") == "custom-title"
                    and isinstance(obj.get("customTitle"), str)
                    and obj.get("customTitle")
                ):
                    latest = obj["customTitle"]
    except OSError:
        return None
    if latest is not None:
        return latest, mtime
    return None


_WHITESPACE = " \t\n\r\x0b\x0c"
_SESSION_PART_ALLOWED = _ALNUM + "._-"


def _collapse_runs(s, predicate, repl):
    """Replace every maximal run of characters matching `predicate` with
    one `repl` character. Standing in for a JS `.replace(/pattern+/g,
    repl)` call, which collapses a whole matched run to one replacement
    rather than substituting it character-by-character."""
    out = []
    i = 0
    n = len(s)
    while i < n:
        if predicate(s[i]):
            out.append(repl)
            while i < n and predicate(s[i]):
                i += 1
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


def sanitize_session_part(raw):
    """Strip characters that would break the hub's `session:user@host`
    format (colon, at-sign), collapse whitespace runs, collapse any
    remaining disallowed-character runs, trim leading/trailing dashes,
    and cap to 64 chars. Returns `""` when nothing usable remains —
    caller falls back.

    Mirrors the bun original's 4-pass pipeline exactly (`plugin.ts:374
    -381`), including the asymmetry between its passes: `:`/`@` are each
    replaced individually (not run-collapsed, since that regex carries
    no `+`), while whitespace runs and other disallowed-character runs
    each collapse to a single `-`.
    """
    s = "".join("-" if ch in ":@" else ch for ch in raw)
    s = _collapse_runs(s, lambda ch: ch in _WHITESPACE, "-")
    s = _collapse_runs(s, lambda ch: ch not in _SESSION_PART_ALLOWED, "-")
    s = s.strip("-")
    return s[:64]


def _persisted_name_path(sid, cwd, home=None):
    if home is None:
        home = os.getenv("HOME") or ""
    return os.path.join(
        home,
        ".claude",
        "projects",
        encode_project_dir_name(cwd),
        "%s.claude-net.json" % sid,
    )


def read_persisted_agent_name(sid, cwd, home=None):
    """`(name, ts)` from the persisted-name file, or `None`."""
    try:
        with open(_persisted_name_path(sid, cwd, home), "r") as f:
            obj = json.loads(f.read())
    except (OSError, ValueError):
        return None
    if (
        isinstance(obj, dict)
        and isinstance(obj.get("name"), str)
        and obj.get("name")
        and isinstance(obj.get("ts"), (int, float))
    ):
        return obj["name"], obj["ts"]
    return None


def _makedirs(path):
    """Recursive `mkdir -p`. `os.mkdir` on this runtime is single-level
    and raises on an already-existing directory (errno 17, EEXIST) —
    both handled here."""
    if not path or path == "/":
        return
    try:
        os.mkdir(path)
    except OSError as exc:
        if exc.args and exc.args[0] == 17:  # EEXIST
            return
        if exc.args and exc.args[0] == 2:  # ENOENT: parent missing
            _makedirs(os.path.dirname(path))
            try:
                os.mkdir(path)
            except OSError as exc2:
                if not (exc2.args and exc2.args[0] == 17):
                    raise
        else:
            raise


def write_persisted_agent_name(sid, cwd, name, ts, home=None, log=None):
    """Best-effort persistence of the last-registered name, keyed by CC
    session id. Failures are logged, never raised — matches the bun
    plugin's `writePersistedAgentName`."""
    path = _persisted_name_path(sid, cwd, home)
    try:
        _makedirs(os.path.dirname(path))
        with open(path, "w") as f:
            f.write(json.dumps({"name": name, "ts": ts}))
    except OSError as exc:
        if log:
            log("Failed to persist agent name: %s" % exc)


def resolve_startup_name(default_name, persisted, custom_title, build_full_name):
    """Pick the startup name from three candidates, freshest wins.

    `persisted` is `(name, ts)` or `None`; `custom_title` is `(title, ts)`
    or `None`. `build_full_name(session_part)` builds a full
    `session:user@host` name from a sanitized custom-title session part.
    `default_name` always wins when neither other candidate exists.
    """
    candidates = []
    if persisted:
        candidates.append(persisted)
    if custom_title:
        title, ts = custom_title
        clean = sanitize_session_part(title)
        if clean:
            candidates.append((build_full_name(clean), ts))
    if not candidates:
        return default_name
    candidates.sort(key=lambda c: c[1], reverse=True)
    return candidates[0][0]


def with_session_suffix(full_name, n):
    """Insert a `-N` suffix into the session portion of a
    `session:user@host` name (used on default-name collision)."""
    colon = full_name.find(":")
    if colon == -1:
        return "%s-%d" % (full_name, n)
    return "%s-%d%s" % (full_name[:colon], n, full_name[colon:])


def uuid4():
    """A random RFC4122 version-4 UUID string, from `os.urandom(16)`.

    No `uuid` module on this runtime — matches the bun plugin's
    `crypto.randomUUID()` format, used both for outbound `requestId`
    correlation and the system self-test notification's
    `cn_message_id`.
    """
    b = bytearray(os.urandom(16))
    b[6] = (b[6] & 0x0F) | 0x40
    b[8] = (b[8] & 0x3F) | 0x80
    h = binascii.hexlify(bytes(b)).decode()
    return "%s-%s-%s-%s-%s" % (h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])


def iso8601_utc_now():
    """Current UTC time as `YYYY-MM-DDTHH:MM:SSZ` — the statusline
    state file's `updated_at` field. No sub-second precision (this
    runtime's `time.gmtime()` doesn't carry any), which the statusline
    reader (a once-a-few-seconds poll) doesn't need."""
    t = time.gmtime()
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % (t[0], t[1], t[2], t[3], t[4], t[5])
