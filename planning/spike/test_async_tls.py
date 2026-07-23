# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest"]
# ///
"""P1 test harness for async TLS under the MicroPython non-blocking asyncio loop.

Drives the binary /tmp/claude-1000/-home-anl-picolet/5a3497ce-2c19-4975-be72-6023e3f69502/scratchpad/picolet-mcp-tls
against a local TLS server in various modes:
  1. TLS handshake completes under non-blocking asyncio against local server.
  2. Mid-handshake server stall (EAGAIN path) completes without busy-spin.
  3. Buffered-record wakeup: two frames in one TLS record are both received.
  4. Server-initiated close DURING handshake surfaces as catchable exception.
  5. Cert failure (CERT_REQUIRED against self-signed) raises, not silently accepts.
  6. Stdin + WSS traffic interleave; idle CPU ~ 0.
  7. Idle-connected RSS <= 4 MB.
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from contextlib import asynccontextmanager

MP_BIN = Path("/tmp/claude-1000/-home-anl-picolet/5a3497ce-2c19-4975-be72-6023e3f69502/scratchpad/picolet-mcp-tls")
SPIKE_DIR = Path(__file__).parent
CERT_PEM = SPIKE_DIR / "localhost_cert.pem"
KEY_PEM = SPIKE_DIR / "localhost_key.pem"
CA_DER = SPIKE_DIR / "isrg_root_x1.der"

assert MP_BIN.exists(), f"MicroPython binary not found: {MP_BIN}"
assert CA_DER.exists(), f"CA not found: {CA_DER}"


def _ensure_certs():
    """Generate the self-signed CN=localhost test cert/key on demand.

    Kept out of git (a private key, even a throwaway localhost one, does not
    belong in the repo); the suite regenerates it the first time it runs.
    """
    if CERT_PEM.exists() and KEY_PEM.exists():
        return
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(KEY_PEM), "-out", str(CERT_PEM),
            "-days", "3650", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


_ensure_certs()


def find_free_port():
    """Find an available port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class MockServer:
    """Local TLS/WSS mock server thread."""

    def __init__(self, port, mode, stall_ms=1500):
        self.port = port
        self.mode = mode
        self.stall_ms = stall_ms
        self.proc = None
        self.ready = False

    def start(self):
        """Start the server in a thread."""
        cmd = [
            sys.executable,
            str(SPIKE_DIR / "async_tls_server.py"),
            str(self.port),
            self.mode,
            str(self.stall_ms),
        ]
        self.proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        # Wait for "listening" message
        for line in iter(self.proc.stdout.readline, ""):
            if "listening" in line.lower():
                self.ready = True
                break
        return self

    def stop(self):
        """Stop the server."""
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()


def proc_cpu_seconds(pid):
    """Sum utime+stime (seconds) for a live pid from /proc/<pid>/stat.

    The comm field (field 2) is parenthesised and may contain spaces, so parse
    from the last ')'. In the remainder, index 0 is `state` (field 3), making
    utime field 14 -> index 11 and stime field 15 -> index 12.
    """
    try:
        with open("/proc/%d/stat" % pid) as f:
            data = f.read()
        rest = data[data.rfind(")") + 2:].split()
        ticks = int(rest[11]) + int(rest[12])
        return ticks / os.sysconf("SC_CLK_TCK")
    except Exception as e:
        print("cpu sample failed:", e)
        return -1.0


def run_mp_script(script_path, args, timeout=30, input_data=None):
    """Run a MicroPython script and capture output.

    Returns: (returncode, stdout_text, stderr_text)
    """
    if isinstance(script_path, str):
        # Inline Python code; write to temp file
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, dir=SPIKE_DIR) as f:
            f.write(script_path)
            script_path = f.name

    script_path = str(script_path)
    cmd = [str(MP_BIN), script_path] + [str(a) for a in args]

    try:
        proc = subprocess.run(
            cmd,
            cwd=SPIKE_DIR,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input_data,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"TIMEOUT after {timeout}s"


# ============================================================================
# TEST 1: Basic handshake completes under non-blocking asyncio loop
# ============================================================================

def test_1_handshake_nonblocking():
    """TLS handshake completes under the non-blocking asyncio loop against local server."""
    port = find_free_port()
    script_path = SPIKE_DIR / "async_tls.py"

    with MockServer(port, "normal") as server:
        assert server.ready, "Server failed to start"
        rc, out, err = run_mp_script(
            script_path,
            [
                "127.0.0.1",
                port,
                "none",  # CERT_NONE
                "",      # no CA file
                "127.0.0.1",  # SNI
            ],
            timeout=10,
        )

    print("=== TEST 1 OUTPUT ===")
    print(out)
    if err:
        print("STDERR:", err)

    # Check for success markers
    checks = [
        ("CONNECT" in out, "Connection initiated"),
        ("HANDSHAKE" in out, "Handshake completed"),
        ("LIVE" in out, "Reached live state"),
        ("closed cleanly" in out, "Connection closed gracefully"),
    ]

    passed = all(check[0] for check in checks)
    details = ", ".join(f"{check[1]}: {'✓' if check[0] else '✗'}" for check in checks)

    assert passed, f"Test 1 failed: {details}\n{out}"
    return True, out


# ============================================================================
# TEST 2: Mid-handshake stall drives EAGAIN path (no busy-spin)
# ============================================================================

def test_2_handshake_stall_eagain():
    """Mid-handshake server stall drives EAGAIN path without busy-spin."""
    port = find_free_port()
    script_path = SPIKE_DIR / "async_tls_negtest.py"

    with MockServer(port, "stall", stall_ms=1500) as server:
        assert server.ready, "Server failed to start"
        rc, out, err = run_mp_script(
            script_path,
            ["stall", port],
            timeout=10,
        )

    print("=== TEST 2 OUTPUT ===")
    print(out)
    if err:
        print("STDERR:", err)

    # The stall scenario should complete after ~1.5s of stalling (with the server
    # sleeping before ServerHello). Completion alone doesn't prove the loop
    # stayed live during the stall, so a concurrent asyncio ticker task (see
    # async_tls_negtest.py) increments a counter every 50ms for the duration of
    # the handshake. At ~1500ms stall / 50ms tick, ~30 ticks are expected; the
    # floor below is a conservative fraction of that (~1/3) to absorb
    # scheduling jitter and slower CI hosts while still catching a regression:
    # a handshake that blocks the loop in C would starve the ticker at 0-1
    # ticks, failing this floor by more than an order of magnitude.
    TICKER_FLOOR = 10

    ticker_ticks = None
    for line in out.split("\n"):
        if "ticker_ticks=" in line:
            try:
                ticker_ticks = int(line.split("ticker_ticks=")[1].split()[0])
            except (IndexError, ValueError):
                pass

    checks = [
        ("STALL:" in out, "Stall test executed"),
        ("completed after" in out, "Handshake completed"),
        ("EAGAIN" in out or "ServerHello" in out, "Notes the stall scenario"),
        (ticker_ticks is not None, "Ticker tick count reported"),
        (ticker_ticks is not None and ticker_ticks >= TICKER_FLOOR,
         f"Concurrent ticker made progress during the stall "
         f"(>= {TICKER_FLOOR} ticks, got {ticker_ticks})"),
        (rc == 0, "Script exited normally"),
    ]

    passed = all(check[0] for check in checks)
    details = ", ".join(f"{check[1]}: {'✓' if check[0] else '✗'}" for check in checks)

    assert passed, f"Test 2 failed: {details}\n{out}"
    return True, out


# ============================================================================
# TEST 3: Buffered-record wakeup (two frames in one TLS record)
# ============================================================================

def test_3_buffered_record_wakeup():
    """Two frames in one TLS record are both received without new fd activity."""
    port = find_free_port()
    script_path = SPIKE_DIR / "async_tls_pack_test.py"

    with MockServer(port, "pack") as server:
        assert server.ready, "Server failed to start"
        rc, out, err = run_mp_script(
            script_path,
            [port],
            timeout=10,
        )

    print("=== TEST 3 OUTPUT ===")
    print(out)
    if err:
        print("STDERR:", err)

    # Parse the measured frame-2 latency. The server is silent in `pack` mode
    # (no pinger), so a small latency is the load-bearing evidence: it can only
    # come from the C-level check_pending path surfacing the buffered record. A
    # broken path would hang until the wait_for timeout instead.
    latency = None
    for line in out.split("\n"):
        if "FRAME2_LATENCY_MS:" in line:
            try:
                latency = int(line.split("FRAME2_LATENCY_MS:")[1].strip())
            except (IndexError, ValueError):
                pass

    checks = [
        ("FRAME1:" in out, "First frame received"),
        ("BUFFERED_PROBE" in out, "Buffered data probe run"),
        ("FRAME2:" in out, "Second frame received"),
        ("hazard handled" in out, "Verdict: hazard handled"),
        ("TIMEOUT" not in out, "No timeout on frame 2"),
        (latency is not None and latency < 200,
         f"Frame-2 latency < 200ms against silent server (got {latency}ms)"),
    ]

    passed = all(check[0] for check in checks)
    details = ", ".join(f"{check[1]}: {'✓' if check[0] else '✗'}" for check in checks)

    assert passed, f"Test 3 failed: {details}\n{out}"
    return True, out


# ============================================================================
# TEST 4: Server-initiated close DURING handshake
# ============================================================================

def test_4_close_during_handshake():
    """Server closes mid-handshake; client raises exception, doesn't hang."""
    port = find_free_port()
    script_path = SPIKE_DIR / "async_tls_negtest.py"

    with MockServer(port, "close_handshake") as server:
        assert server.ready, "Server failed to start"
        rc, out, err = run_mp_script(
            script_path,
            ["close", port],
            timeout=10,
        )

    print("=== TEST 4 OUTPUT ===")
    print(out)
    if err:
        print("STDERR:", err)

    checks = [
        ("CLOSE:" in out, "Close test executed"),
        ("UNEXPECTED success" not in out, "Did not silently accept"),
        ("FAIL - hung" not in out, "Did not hang (timeout)"),
        ("raised" in out or "rejected" in out, "Error raised (caught exception)"),
        (rc == 0, "Script exited normally"),
    ]

    passed = all(check[0] for check in checks)
    details = ", ".join(f"{check[1]}: {'✓' if check[0] else '✗'}" for check in checks)

    assert passed, f"Test 4 failed: {details}\n{out}"
    return True, out


# ============================================================================
# TEST 5: Cert verification failure (CERT_REQUIRED against self-signed)
# ============================================================================

def test_5_cert_verification():
    """CERT_REQUIRED against self-signed cert raises, doesn't silently accept."""
    port = find_free_port()
    script_path = SPIKE_DIR / "async_tls_negtest.py"

    with MockServer(port, "normal") as server:
        assert server.ready, "Server failed to start"
        rc, out, err = run_mp_script(
            script_path,
            ["verify", port, str(CA_DER)],
            timeout=10,
        )

    print("=== TEST 5 OUTPUT ===")
    print(out)
    if err:
        print("STDERR:", err)

    checks = [
        ("VERIFY:" in out, "Verify test executed"),
        ("UNEXPECTED success" not in out, "Did not silently accept self-signed"),
        ("FAIL - hung" not in out, "Did not hang (timeout)"),
        ("rejected" in out, "Self-signed cert rejected"),
        (rc == 0, "Script exited normally"),
    ]

    passed = all(check[0] for check in checks)
    details = ", ".join(f"{check[1]}: {'✓' if check[0] else '✗'}" for check in checks)

    assert passed, f"Test 5 failed: {details}\n{out}"
    return True, out


# ============================================================================
# TEST 6: Concurrency (stdin + WSS interleave, idle CPU ~ 0)
# ============================================================================

def test_6_stdin_wss_concurrency():
    """Stdin readline and WSS traffic interleave in ONE loop; idle CPU near zero.

    Holds stdin open ~3s (rather than closing it immediately) so all three
    concurrency behaviours actually fire under the single poll loop:
      * a real stdin RPC line round-trips over the live wss socket,
      * the server's 1.5s WS control PING arrives and is auto-PONGed,
      * the loop then blocks in poll() with nothing to do.
    CPU time is sampled from /proc just before EOF; a busy-spin loop would show
    ~100% over the ~3s window, a correctly poll-blocked loop only a few percent.
    """
    port = find_free_port()
    script_path = SPIKE_DIR / "async_tls_combined.py"

    with MockServer(port, "normal") as server:
        assert server.ready, "Server failed to start"

        cmd = [str(MP_BIN), str(script_path), str(port), "none"]
        proc = subprocess.Popen(
            cmd,
            cwd=str(SPIKE_DIR),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        t0 = time.time()
        # Drive a real RPC line over the live wss link, then hold stdin OPEN.
        proc.stdin.write("rpc-1\n")
        proc.stdin.flush()
        # Hold ~3s: covers the server's 1.5s PING + auto-PONG + the RPC reply,
        # then idle. Sample CPU just before we close stdin.
        time.sleep(3.0)
        cpu_s = proc_cpu_seconds(proc.pid)
        wall_pre_eof = time.time() - t0
        # EOF -> clean shutdown.
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            out, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
        elapsed = time.time() - t0

    cpu_pct = 100.0 * cpu_s / wall_pre_eof if (cpu_s >= 0 and wall_pre_eof > 0) else -1.0

    print("=== TEST 6 OUTPUT ===")
    print(out)
    print(f"CPU: {cpu_s:.3f}s over {wall_pre_eof:.2f}s wall pre-EOF = {cpu_pct:.1f}%")
    print(f"Total elapsed: {elapsed:.2f}s")

    checks = [
        ("MAIN: wss up" in out, "WSS connection established"),
        ("STDIN-RPC:" in out, "Stdin RPC line processed while wss live"),
        ("WS<-" in out, "WSS app messages received (interleave)"),
        ("CLIENT: <- PING, -> PONG" in out, "Server WS PING auto-PONGed"),
        ("STDIN: EOF" in out, "Stdin EOF detected"),
        ("MAIN: done" in out, "Clean shutdown"),
        (0 <= cpu_pct < 25, f"Idle CPU < 25% (got {cpu_pct:.1f}%)"),
    ]

    passed = all(check[0] for check in checks)
    details = ", ".join(f"{check[1]}: {'✓' if check[0] else '✗'}" for check in checks)

    assert passed, f"Test 6 failed: {details}\n{out}"
    return True, out


# ============================================================================
# TEST 7: RSS measurement (idle-connected <= 4 MB)
# ============================================================================

def test_7_rss_idle():
    """Idle-connected process RSS <= 4 MB."""
    port = find_free_port()
    script_path = SPIKE_DIR / "async_tls.py"

    with MockServer(port, "normal") as server:
        assert server.ready, "Server failed to start"
        rc, out, err = run_mp_script(
            script_path,
            [
                "127.0.0.1",
                port,
                "none",
                "",
                "127.0.0.1",
            ],
            timeout=10,
        )

    print("=== TEST 7 OUTPUT ===")
    print(out)
    if err:
        print("STDERR:", err)

    # Extract RSS from the output. The script prints "rss=<N>kB" in several places.
    # We care about the "LIVE" RSS measurement (after connection established).
    rss_kb = -1
    for line in out.split("\n"):
        if "LIVE rss=" in line:
            try:
                rss_kb = int(line.split("rss=")[1].split("kB")[0])
                break
            except (IndexError, ValueError):
                pass

    # If we couldn't parse, try the last rss= occurrence
    if rss_kb < 0:
        for line in reversed(out.split("\n")):
            if "rss=" in line:
                try:
                    rss_kb = int(line.split("rss=")[1].split("kB")[0])
                    break
                except (IndexError, ValueError):
                    pass

    print(f"Extracted RSS: {rss_kb} KB")

    checks = [
        (rss_kb > 0, "RSS successfully measured"),
        (rss_kb <= 4096, f"RSS <= 4 MB ({rss_kb} KB)"),
    ]

    passed = all(check[0] for check in checks)
    details = ", ".join(f"{check[1]}: {'✓' if check[0] else '✗'}" for check in checks)

    assert passed, f"Test 7 failed: {details}\n{out}"
    return True, out, rss_kb


# ============================================================================
# TEST 8: Abrupt mid-frame RST honours the graceful-close (None) contract
# ============================================================================

def test_8_abrupt_close_graceful():
    """Peer RST mid-frame surfaces as recv()->None, not an uncaught EOFError.

    Regression guard for the round-2 finding: ws.py used asyncio.readexactly,
    which raises a bare EOFError() on abrupt close (verified on this binary),
    so _read_frame never returned None and recv()'s documented "None on close"
    contract was dead code. The server sends frame 1, then one byte of frame 2
    and RSTs the socket (no OP_CLOSE). The client must read frame 1, then get
    None -- if the EOFError leaked, the reader task would crash on a real-hub
    eviction / RST.
    """
    port = find_free_port()
    script_path = SPIKE_DIR / "async_tls_negtest.py"

    with MockServer(port, "abrupt") as server:
        assert server.ready, "Server failed to start"
        rc, out, err = run_mp_script(
            script_path,
            ["abrupt", port],
            timeout=10,
        )

    print("=== TEST 8 OUTPUT ===")
    print(out)
    if err:
        print("STDERR:", err)

    checks = [
        ("ABRUPT: frame1:" in out, "First frame received before RST"),
        ("returned None on mid-frame RST" in out, "recv() returned None"),
        ("FAIL - recv raised" not in out, "No EOFError propagated"),
        ("FAIL - recv hung" not in out, "Did not hang after RST"),
        ("Traceback" not in out, "No uncaught traceback"),
        (rc == 0, "Script exited normally"),
    ]

    passed = all(check[0] for check in checks)
    details = ", ".join(f"{check[1]}: {'✓' if check[0] else '✗'}" for check in checks)

    assert passed, f"Test 8 failed: {details}\n{out}"
    return True, out


# ============================================================================
# MAIN HARNESS
# ============================================================================

def main():
    """Run all tests and report results."""
    tests = [
        ("1. TLS handshake completes", test_1_handshake_nonblocking),
        ("2. Mid-handshake stall (EAGAIN)", test_2_handshake_stall_eagain),
        ("3. Buffered-record wakeup", test_3_buffered_record_wakeup),
        ("4. Server-initiated close", test_4_close_during_handshake),
        ("5. Cert verification failure", test_5_cert_verification),
        ("6. Stdin + WSS concurrency", test_6_stdin_wss_concurrency),
        ("7. RSS idle-connected", test_7_rss_idle),
        ("8. Abrupt mid-frame RST -> graceful None", test_8_abrupt_close_graceful),
    ]

    results = []
    rss_kb = -1

    for name, test_func in tests:
        print(f"\n{'='*70}")
        print(f"Running: {name}")
        print('='*70)

        try:
            if name.startswith("7"):
                # Test 7 returns RSS
                passed, out, rss_kb = test_func()
                results.append((name, True, out, rss_kb))
            else:
                passed, out = test_func()
                results.append((name, True, out, -1))
            print(f"✓ PASSED")
        except AssertionError as e:
            print(f"✗ FAILED: {e}")
            results.append((name, False, str(e), -1))
        except Exception as e:
            print(f"✗ ERROR: {e}")
            import traceback
            traceback.print_exc()
            results.append((name, False, str(e), -1))

    print(f"\n{'='*70}")
    print("TEST SUMMARY")
    print('='*70)

    all_passed = True
    for name, passed, _, rss_val in results:
        status = "✓ PASS" if passed else "✗ FAIL"
        if rss_val > 0:
            print(f"{status}: {name} (RSS: {rss_val} KB)")
        else:
            print(f"{status}: {name}")
        if not passed:
            all_passed = False

    print('='*70)
    print(f"Overall: {'ALL PASSED' if all_passed else 'SOME FAILED'}")
    if rss_kb > 0:
        print(f"Final RSS: {rss_kb} KB (limit: 4096 KB)")
    print('='*70)

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
