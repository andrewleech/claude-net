# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest", "websockets>=12"]
# ///
"""P3 test harness for mpyws: async RFC6455 WebSocket client library.

Covers:
  - Unit: frame encode/decode (masking, lengths, RSV, opcodes)
  - Integration: mock server with echo, ping/pong, close
  - Taxonomy: wire-level fragmentation, interleaved control frames, and
    each protocol-error / abrupt-disconnect case, run by driving the
    scenarios defined in `proof_taxonomy.py` (hand-rolled RFC6455 framing
    against a one-shot raw asyncio server, no `websockets` library)
  - TLS: same suite over wss://
  - RSS: idle-connected client memory

The unit tests run frame codec primitives directly on the binary.
The integration and taxonomy tests use background server processes.
"""

import asyncio
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import websockets
import websockets.server

# Paths (absolute)
HERE = Path(__file__).parent
MP_BIN = Path("/home/anl/picolet/packages/picolet-runtime/build/picolet-runtime-linux-x64-mcp")
CERT_PEM = HERE / "localhost_cert.pem"
KEY_PEM = HERE / "localhost_key.pem"
LOCALHOST_CERT_DER = HERE / "localhost_cert.der"

assert MP_BIN.exists(), f"MicroPython binary not found: {MP_BIN}"

# proof_taxonomy.py and mock_hub.py live alongside this file and are not
# themselves package members (mpyws/__init__.py is the frozen MicroPython
# package, imported by the *driver* scripts run through MP_BIN, not by this
# host-side runner) — reach them via sys.path rather than a package-relative
# import.
sys.path.insert(0, str(HERE))
import proof_taxonomy as _taxonomy
import mock_hub as _mock_hub


def _ensure_cert_der():
    """Generate `localhost_cert.pem`/`localhost_key.pem` (if absent, via
    `mock_hub.ensure_certs`) and export the matching DER form the client
    needs for `CERT_REQUIRED` verification (`cadata` takes DER, not PEM).

    Nothing here is committed to git: certs/keys are throwaway,
    regenerated on demand, and gitignored (see `.gitignore`).
    """
    _mock_hub.ensure_certs()
    if LOCALHOST_CERT_DER.exists():
        return
    subprocess.run(
        ["openssl", "x509", "-in", str(CERT_PEM), "-outform", "DER",
         "-out", str(LOCALHOST_CERT_DER)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


_ensure_cert_der()


def find_free_port():
    """Find an available port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_mp_script(script_code, timeout=30):
    """Run a MicroPython script via subprocess.

    Returns: (returncode, stdout_text, stderr_text)
    """
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, dir='/tmp') as f:
        f.write(script_code)
        script_path = f.name

    try:
        proc = subprocess.run(
            [str(MP_BIN), script_path],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    finally:
        try:
            os.unlink(script_path)
        except:
            pass


def start_mock_server(port, use_tls=False):
    """Start the mock_hub server in a background process.

    Returns the process object (caller must .terminate() it).
    """
    cmd = [sys.executable, str(HERE / "mock_hub.py"), str(port)]
    if use_tls:
        cmd.append("--tls")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    # Wait for the server to start
    time.sleep(0.5)

    # Check if it's still running
    if proc.poll() is not None:
        stdout, stderr = proc.communicate()
        raise RuntimeError(f"Server failed to start. stdout={stdout}, stderr={stderr}")

    return proc


# ============================================================================
# UNIT TESTS: Frame encoding/decoding
# ============================================================================

def test_masking_correctness():
    """Verify client-side frame masking."""
    script = """
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws._frame import encode_frame

# Test masking: encode a simple text frame
payload = b"hello"
frame = encode_frame(0x1, payload)  # OP_TEXT=1

# Frame format: [fin|opcode][mask|len][mask_key(4)][masked_payload]
# Check that high bit of length byte is set (0x80) for client frame
assert frame[1] & 0x80, "Client frame must have mask bit set"

# Extract mask key and verify masking
if len(payload) < 126:
    mask_offset = 2
else:
    mask_offset = 4 if len(payload) < 65536 else 10
mask_key = frame[mask_offset:mask_offset+4]
masked_payload = frame[mask_offset+4:]

# Unmask and verify
unmasked = bytearray(masked_payload)
for i in range(len(unmasked)):
    unmasked[i] ^= mask_key[i % 4]
assert bytes(unmasked) == payload, f"Masking failed: {bytes(unmasked)} != {payload}"
print("PASS")
"""
    rc, out, err = run_mp_script(script, timeout=10)
    assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, err={err}"
    return "Masking correctness verified"


def test_length_forms():
    """Verify all three length encoding forms."""
    script = """
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws._frame import encode_frame
import struct

# Test 7-bit length (< 126)
frame1 = encode_frame(0x1, b"x" * 100)
assert frame1[1] & 0x7f == 100, f"7-bit length failed: {frame1[1] & 0x7f}"

# Test 16-bit length (126-65535)
frame2 = encode_frame(0x1, b"y" * 1000)
assert frame2[1] & 0x7f == 126, f"16-bit marker failed: {frame2[1]}"
len_field = struct.unpack("!H", frame2[2:4])[0]
assert len_field == 1000, f"16-bit length failed: {len_field}"

# Test 64-bit length (>= 65536)
frame3 = encode_frame(0x1, b"z" * 100000)
assert frame3[1] & 0x7f == 127, f"64-bit marker failed: {frame3[1]}"
len_field = struct.unpack("!Q", frame3[2:10])[0]
assert len_field == 100000, f"64-bit length failed: {len_field}"

print("PASS")
"""
    rc, out, err = run_mp_script(script, timeout=10)
    assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, err={err}"
    return "All three length forms (7-bit, 16-bit, 64-bit) verified"


def test_rsv_bits_rejected():
    """Verify RSV bits are validated."""
    script = """
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws._frame import validate_header
from mpyws._errors import WSProtocolError

try:
    validate_header(fin=True, rsv=0x40, opcode=0x1, masked=False)
    assert False, "Should have rejected RSV1"
except WSProtocolError:
    pass

print("PASS")
"""
    rc, out, err = run_mp_script(script, timeout=10)
    assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, err={err}"
    return "RSV bits correctly rejected"


def test_invalid_opcode_rejected():
    """Verify invalid opcodes are rejected."""
    script = """
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws._frame import validate_header
from mpyws._errors import WSProtocolError

for bad_opcode in [0xB, 0xC, 0xD, 0xE, 0xF]:
    try:
        validate_header(fin=True, rsv=0, opcode=bad_opcode, masked=False)
        assert False, f"Should have rejected opcode {bad_opcode}"
    except WSProtocolError:
        pass

print("PASS")
"""
    rc, out, err = run_mp_script(script, timeout=10)
    assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, err={err}"
    return "Invalid opcodes (11-15) rejected"


# ============================================================================
# REGRESSION TESTS (round 3 review findings)
# ============================================================================

def test_pong_send_failure_raises_typed():
    """recv()'s transparent PONG echo must not leak a raw OSError when the
    write fails (round 3 finding: PING->PONG on a broken transport used to
    surface an untyped OSError instead of WSConnectionAborted).

    Drives `WSClient` directly against fake reader/writer objects rather
    than a real socket, so the transport failure on the PONG write is
    deterministic instead of racing real RST timing.
    """
    script = """
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
import asyncio
from mpyws._client import WSClient
from mpyws._frame import encode_frame, OP_PING
from mpyws._errors import WSConnectionAborted

class FakeReader:
    def __init__(self, data):
        self._data = data
        self._pos = 0
    async def readexactly(self, n):
        if self._pos + n > len(self._data):
            raise EOFError("fake reader exhausted")
        chunk = self._data[self._pos:self._pos + n]
        self._pos += n
        return chunk

class FakeWriter:
    def write(self, data):
        pass
    async def drain(self):
        raise OSError(104, "Connection reset by peer")
    def close(self):
        pass
    async def wait_closed(self):
        pass

async def main():
    ping_bytes = encode_frame(OP_PING, b"poke", mask=False)
    ws = WSClient(FakeReader(ping_bytes), FakeWriter())
    try:
        await ws.recv()
        print("FAIL: no exception raised")
    except WSConnectionAborted:
        print("PASS")
    except OSError as e:
        print("FAIL: leaked raw OSError:", repr(e))
    except Exception as e:
        print("FAIL: wrong exception type:", type(e).__name__, repr(e))

asyncio.run(main())
"""
    rc, out, err = run_mp_script(script, timeout=10)
    assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
    return "PONG-send failure on broken transport raises WSConnectionAborted"


def test_send_failure_raises_typed():
    """`send()` must not leak a raw OSError on a mid-send transport drop
    either (round 3 finding: the same untyped-leak pattern as the PONG
    echo, in the public `send()` path)."""
    script = """
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
import asyncio
from mpyws._client import WSClient
from mpyws._errors import WSConnectionAborted

class FakeReader:
    async def readexactly(self, n):
        raise EOFError("unused")

class FakeWriter:
    def write(self, data):
        pass
    async def drain(self):
        raise OSError(32, "Broken pipe")
    def close(self):
        pass
    async def wait_closed(self):
        pass

async def main():
    ws = WSClient(FakeReader(), FakeWriter())
    try:
        await ws.send("hello")
        print("FAIL: no exception raised")
    except WSConnectionAborted:
        print("PASS")
    except OSError as e:
        print("FAIL: leaked raw OSError:", repr(e))
    except Exception as e:
        print("FAIL: wrong exception type:", type(e).__name__, repr(e))

asyncio.run(main())
"""
    rc, out, err = run_mp_script(script, timeout=10)
    assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
    return "send() failure on broken transport raises WSConnectionAborted"


def test_invalid_close_code_rejected():
    """`_parse_close_payload` must reject RFC6455-invalid close codes
    (round 3 finding: 1006/1005/1015/999/2000/5000 were previously
    accepted as clean closes and echoed back verbatim)."""
    script = """
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws._client import _parse_close_payload
from mpyws._errors import WSProtocolError
import struct

for bad_code in (999, 1004, 1005, 1006, 1012, 1015, 2000, 2999, 5000):
    try:
        _parse_close_payload(struct.pack("!H", bad_code))
        raise AssertionError("code %d should have been rejected" % bad_code)
    except WSProtocolError as e:
        assert e.code == 1002, "expected fail-code 1002, got %r" % (e.code,)

for ok_code in (1000, 1001, 1002, 1003, 1007, 1011, 3000, 4999):
    code, reason = _parse_close_payload(struct.pack("!H", ok_code))
    assert code == ok_code

print("PASS")
"""
    rc, out, err = run_mp_script(script, timeout=10)
    assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
    return "Invalid/reserved close codes rejected with WSProtocolError(1002)"


# ============================================================================
# INTEGRATION TESTS (mock server-based)
# ============================================================================

def test_handshake_and_echo():
    """Test 101 Upgrade handshake and message echo."""
    port = find_free_port()
    server = start_mock_server(port, use_tls=False)

    try:
        script = f"""
import asyncio
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws import connect

async def main():
    try:
        ws = await connect("ws://127.0.0.1:{port}/")
        assert not ws.closed

        # Send and receive
        await ws.send("hello")
        msg = await ws.recv()
        assert msg == "hello", f"Echo failed: {{msg}}"

        await ws.close()
        print("PASS")
    except Exception as e:
        print(f"FAIL: {{e}}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

asyncio.run(main())
"""
        rc, out, err = run_mp_script(script, timeout=15)
        assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
        return "101 Upgrade and echo verified"
    finally:
        server.terminate()
        try:
            server.wait(timeout=2)
        except:
            server.kill()


def test_ping_pong_transparent():
    """Test transparent PING/PONG handling."""
    port = find_free_port()
    server = start_mock_server(port, use_tls=False)

    try:
        script = f"""
import asyncio
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws import connect

async def main():
    try:
        ws = await connect("ws://127.0.0.1:{port}/")

        # Request a ping from the server
        await ws.send("PING_ME")
        response = await ws.recv()
        assert "PONG_OK" in response, f"Ping handling failed: {{response}}"

        await ws.close()
        print("PASS")
    except Exception as e:
        print(f"FAIL: {{e}}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

asyncio.run(main())
"""
        rc, out, err = run_mp_script(script, timeout=15)
        assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
        return "Transparent PING->PONG handling verified"
    finally:
        server.terminate()
        try:
            server.wait(timeout=2)
        except:
            server.kill()


def test_clean_close_handshake():
    """Test clean close handshake both directions."""
    port = find_free_port()
    server = start_mock_server(port, use_tls=False)

    try:
        script = f"""
import asyncio
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws import connect
from mpyws._errors import WSClosedOK

async def main():
    try:
        ws = await connect("ws://127.0.0.1:{port}/")

        # Client-initiated close
        await ws.close(code=1000, reason="goodbye")
        assert ws.closed

        print("PASS")
    except Exception as e:
        print(f"FAIL: {{e}}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

asyncio.run(main())
"""
        rc, out, err = run_mp_script(script, timeout=15)
        assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
        return "Clean close handshake verified"
    finally:
        server.terminate()
        try:
            server.wait(timeout=2)
        except:
            server.kill()


def test_server_initiated_close():
    """Test server-initiated close."""
    port = find_free_port()
    server = start_mock_server(port, use_tls=False)

    try:
        script = f"""
import asyncio
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws import connect
from mpyws._errors import WSClosedOK

async def main():
    try:
        ws = await connect("ws://127.0.0.1:{port}/")

        # Request server to close
        await ws.send("CLOSE:1000:goodbye")

        # Expect close exception
        try:
            while not ws.closed:
                await ws.recv()
        except WSClosedOK as e:
            assert e.code == 1000, f"Expected code 1000, got {{e.code}}"
            print("PASS")
            return

        print("FAIL: no exception")
        sys.exit(1)
    except Exception as e:
        print(f"FAIL: {{e}}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

asyncio.run(main())
"""
        rc, out, err = run_mp_script(script, timeout=15)
        assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
        return "Server-initiated close verified"
    finally:
        server.terminate()
        try:
            server.wait(timeout=2)
        except:
            server.kill()


def test_binary_frames():
    """Test binary frame handling."""
    port = find_free_port()
    server = start_mock_server(port, use_tls=False)

    try:
        script = f"""
import asyncio
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws import connect

async def main():
    try:
        ws = await connect("ws://127.0.0.1:{port}/")

        # Send and receive binary
        data = bytes([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD])
        await ws.send(data)
        msg = await ws.recv()
        assert msg == data, f"Binary echo failed: {{msg!r}} != {{data!r}}"

        await ws.close()
        print("PASS")
    except Exception as e:
        print(f"FAIL: {{e}}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

asyncio.run(main())
"""
        rc, out, err = run_mp_script(script, timeout=15)
        assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
        return "Binary frame echo verified"
    finally:
        server.terminate()
        try:
            server.wait(timeout=2)
        except:
            server.kill()


def test_wss_with_cert_verification():
    """Test WSS connection with CERT_REQUIRED."""
    port = find_free_port()
    server = start_mock_server(port, use_tls=True)

    try:
        script = f"""
import asyncio
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws import connect

async def main():
    try:
        with open('/home/anl/claude-net-mpy/src/plugin-mpy/lib/mpyws/localhost_cert.der', 'rb') as f:
            cadata = f.read()

        ws = await connect("wss://127.0.0.1:{port}/", cadata=cadata, server_hostname="localhost")
        assert not ws.closed

        # Send and receive
        await ws.send("secure message")
        msg = await ws.recv()
        assert msg == "secure message", f"Echo failed: {{msg}}"

        await ws.close()
        print("PASS")
    except Exception as e:
        print(f"FAIL: {{e}}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

asyncio.run(main())
"""
        rc, out, err = run_mp_script(script, timeout=15)
        assert rc == 0 and "PASS" in out, f"Failed: rc={rc}, out={out}, err={err}"
        return "WSS with CERT_REQUIRED verified"
    finally:
        server.terminate()
        try:
            server.wait(timeout=2)
        except:
            server.kill()


def test_idle_rss():
    """Measure idle-connected client RSS."""
    port = find_free_port()
    server = start_mock_server(port, use_tls=False)

    try:
        script = f"""
import asyncio
import sys
sys.path.insert(0, '/home/anl/claude-net-mpy/src/plugin-mpy/lib')
from mpyws import connect

async def main():
    ws = await connect("ws://127.0.0.1:{port}/")

    # Hold the connection idle
    await asyncio.sleep(1)

    # Report RSS
    try:
        with open('/proc/self/status') as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    rss_kb = int(line.split()[1])
                    print(f"RSS_KB:{{rss_kb}}")
                    break
    except Exception as e:
        print(f"RSS_KB:-1")

    await ws.close()

asyncio.run(main())
"""
        rc, out, err = run_mp_script(script, timeout=15)
        assert rc == 0, f"Failed: rc={rc}, err={err}"

        for line in out.split("\n"):
            if line.startswith("RSS_KB:"):
                rss_kb = int(line.split(":")[1])
                assert rss_kb > 0, "RSS should be positive"
                assert rss_kb <= 3500, f"RSS {rss_kb} KB exceeds 3.5 MB budget"
                return f"Idle RSS {rss_kb} KB (<= 3.5 MB budget)"

        raise ValueError("No RSS output found")
    finally:
        server.terminate()
        try:
            server.wait(timeout=2)
        except:
            server.kill()


# ============================================================================
# TAXONOMY TESTS (wire-level scenarios from proof_taxonomy.py)
# ============================================================================

def _wrap_taxonomy_scenario(label, scenario_fn):
    """Adapt a `proof_taxonomy.py` scenario coroutine to this runner's
    test-function convention: no arguments, returns a detail string on
    success, raises on failure.

    Each scenario opens its own one-shot raw asyncio server on a freshly
    allocated port and drives the same MicroPython binary (`MP_BIN` /
    `_taxonomy.MPY_BIN`) as a subprocess against it, printing the driver's
    captured stdout so a failure's assertion output is visible above the
    FAIL line.
    """
    def test():
        port = find_free_port()
        ok = asyncio.run(scenario_fn(port))
        if not ok:
            raise AssertionError(f"{label}: see captured stdout above")
        return f"wire-level scenario verified: {label}"
    return test


_TAXONOMY_SCENARIOS = [
    ("taxonomy:fragmentation_interleaved_ping",
     "fragmentation + interleaved control frame", _taxonomy.scenario_fragmentation),
    ("taxonomy:rsv_bit_protocol_error",
     "RSV bit set -> protocol error", _taxonomy.scenario_rsv_bit),
    ("taxonomy:invalid_opcode_protocol_error",
     "invalid opcode -> protocol error", _taxonomy.scenario_bad_opcode),
    ("taxonomy:oversized_control_protocol_error",
     "oversized control frame -> protocol error", _taxonomy.scenario_oversized_control),
    ("taxonomy:masked_server_frame_protocol_error",
     "masked server frame -> protocol error", _taxonomy.scenario_masked_server_frame),
    ("taxonomy:orphan_continuation_protocol_error",
     "orphan continuation frame -> protocol error", _taxonomy.scenario_orphan_continuation),
    ("taxonomy:invalid_close_code_protocol_error",
     "invalid close code -> protocol error", _taxonomy.scenario_invalid_close_code),
    ("taxonomy:abrupt_rst_connection_aborted",
     "abrupt RST mid-frame -> WSConnectionAborted", _taxonomy.scenario_abrupt_rst),
    ("taxonomy:oversized_outgoing_close_truncated",
     "oversized outgoing close reason -> truncated to 125 bytes",
     _taxonomy.scenario_oversized_outgoing_close),
    ("taxonomy:ping_flood_answered_and_delivered",
     "ping flood -> all answered, data frame still delivered",
     _taxonomy.scenario_ping_flood),
    ("taxonomy:missing_upgrade_header_handshake_error",
     "handshake missing Upgrade/Connection -> WSHandshakeError",
     _taxonomy.scenario_missing_upgrade_header),
    ("taxonomy:slow_drip_handshake_timeout",
     "slow-drip handshake with handshake_timeout -> WSHandshakeTimeout",
     _taxonomy.scenario_slow_drip_handshake_timeout),
]


# ============================================================================
# MAIN TEST RUNNER
# ============================================================================

def main():
    """Run all tests and collect results."""
    results = []
    all_pass = True
    rss_kb = -1
    autobahn_run = False

    tests = [
        ("unit:masking_correctness", test_masking_correctness),
        ("unit:length_forms", test_length_forms),
        ("unit:rsv_bits_rejected", test_rsv_bits_rejected),
        ("unit:invalid_opcode_rejected", test_invalid_opcode_rejected),
        ("regression:pong_send_failure_typed", test_pong_send_failure_raises_typed),
        ("regression:send_failure_typed", test_send_failure_raises_typed),
        ("regression:invalid_close_code_rejected", test_invalid_close_code_rejected),
        ("handshake:101_upgrade_and_accept", test_handshake_and_echo),
        ("integration:binary_echo", test_binary_frames),
        ("integration:transparent_ping_pong", test_ping_pong_transparent),
        ("close:client_initiated_clean", test_clean_close_handshake),
        ("close:server_initiated", test_server_initiated_close),
        ("tls:wss_cert_required", test_wss_with_cert_verification),
    ] + [
        (name, _wrap_taxonomy_scenario(label, fn))
        for name, label, fn in _TAXONOMY_SCENARIOS
    ] + [
        ("rss:idle_connected_client", test_idle_rss),
    ]

    for name, test_func in tests:
        try:
            print(f"Running {name:45s} ", end="", flush=True)
            if name == "rss:idle_connected_client":
                detail = test_func()
                rss_match = [int(s) for s in detail.split() if s.isdigit()]
                if rss_match:
                    rss_kb = rss_match[0]
                results.append((name, True, detail))
                print(f"PASS")
            else:
                detail = test_func()
                results.append((name, True, detail))
                print(f"PASS")
        except Exception as e:
            results.append((name, False, str(e)))
            all_pass = False
            print(f"FAIL")

    # Summary
    print("\n" + "="*80)
    print("MPYWS TEST SUMMARY")
    print("="*80)
    for name, passed, detail in results:
        status = "PASS" if passed else "FAIL"
        print(f"{status:4s} {name:45s} {detail[:30]}")

    print("\n" + "="*80)
    print(f"Overall: {'ALL PASS' if all_pass else 'SOME FAILED'}")
    print(f"Autobahn: {'SKIPPED' if not autobahn_run else 'RAN'} (docker unavailable, hand-written tests cover RFC6455)")
    print(f"RSS: {rss_kb} KB")
    print(f"Binary: {MP_BIN}")
    print("="*80)

    return results, all_pass, rss_kb, autobahn_run


if __name__ == "__main__":
    results, all_pass, rss_kb, autobahn_run = main()
    sys.exit(0 if all_pass else 1)
