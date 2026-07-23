"""Statusline state file: `/tmp/claude-net/state-<ppid>.json`.

Written on register success, disconnect, and terminal registration error;
deleted on clean shutdown (`plugin.ts:526-558`). The file's shape is a
stable external contract — `bin/statusline.py` and P8's install/rollout
tooling read it unchanged, not just an implementation detail of this
plugin.
"""

import json
import os

from _identity import getppid, iso8601_utc_now

STATE_DIR = "/tmp/claude-net"


def _state_file_path():
    return os.path.join(STATE_DIR, "state-%d.json" % getppid())


def write_session_state(name, status, hub, cwd, error=None, log=None):
    """Write the statusline state file. `status` is one of `"online"`,
    `"error"`, `"disconnected"`. `error` is included only when given."""
    state = {"name": name, "status": status, "hub": hub, "cwd": cwd}
    if error is not None:
        state["error"] = error
    state["updated_at"] = iso8601_utc_now()
    try:
        try:
            os.mkdir(STATE_DIR)
        except OSError as exc:
            if not (exc.args and exc.args[0] == 17):  # EEXIST
                raise
        with open(_state_file_path(), "w") as f:
            f.write(json.dumps(state))
    except OSError as exc:
        if log:
            log("Failed to write state file: %s" % exc)


def delete_session_state():
    try:
        os.remove(_state_file_path())
    except OSError:
        pass
