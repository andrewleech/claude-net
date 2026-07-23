"""Non-blocking stdin wrapper working around a runtime asyncio defect.

On the `picolet-runtime-*-mcp` binary, `asyncio.StreamReader(sys.stdin.buffer)
.read(n)` (an explicit byte-count read — the primitive `mpyjsonrpc._LineReader`
uses for its own line buffering) behaves correctly for the *first* genuine
wait for data, but on the *second and later* waits it falsely reports the
stream ready via `select.poll()` almost immediately and returns an empty
read, which every caller in this codebase (mpyjsonrpc, MCP servers built on
it) interprets as EOF. Confirmed reproducible in isolation: minimal repro
scripts and the full investigation are recorded in this session's report
(see plugin.py's module docstring for the pointer). `sys.stdin.buffer
.readline()` does not exhibit the defect — this module exists solely to
give mpyjsonrpc a stdin object whose `.read(n)` is satisfied through
`.readline()` instead of the runtime's raw `.read(n)`.

`mpyfastmcp.MCPServer` (and the `mpyjsonrpc.JsonRpcPeer` it wraps) accept an
explicit `stdin=` constructor argument for exactly this kind of
substitution — this is a supported extension point, not a modification of
either frozen library.

`StdinLineShim` is an `io.IOBase` subclass (required for a Python object to
participate in MicroPython's native `select.poll()` protocol via a
user-implemented `ioctl()`): its `ioctl()` answers `MP_STREAM_POLL` (request
code 3) with a real non-blocking `select.select()` check on the underlying
file descriptor, and its `read(n)` ignores `n` and returns one line via the
wrapped object's own `.readline()` (which mpyjsonrpc's own buffering logic
handles fine — it only ever accumulates whatever `.read()` gives it and
scans for `\n` itself, never assuming a fixed chunk size).
"""

import io
import select


class StdinLineShim(io.IOBase):
    def __init__(self, raw):
        self._raw = raw
        self._fd = raw.fileno()

    def ioctl(self, req, arg):
        if req == 3:  # MP_STREAM_POLL
            ret = 0
            if arg & 1:  # POLLIN requested
                r, _w, _e = select.select([self._fd], [], [], 0)
                if r:
                    ret |= 1
            return ret
        return 0

    def read(self, n=-1):
        return self._raw.readline()

    def readinto(self, buf):
        line = self._raw.readline()
        if line is None:
            return None
        n = len(line)
        buf[:n] = line
        return n

    def write(self, buf):
        return self._raw.write(buf)

    def close(self):
        pass
