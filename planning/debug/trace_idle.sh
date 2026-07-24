#!/usr/bin/env bash
# Trace the packaged plugin while it sits idle on a real hub connection.
#
#   ./trace_idle.sh syscalls [secs]   strace -c histogram (SIGINT so it flushes)
#   ./trace_idle.sh timeline [secs]   per-syscall timeline with timestamps
#   ./trace_idle.sh perf     [secs]   perf record -> userspace hotspots
#
# stdin is a fifo: the MCP handshake is written, then held open and silent,
# which is exactly how an idle Claude Code session drives the plugin.
set -u

MODE="${1:-syscalls}"
SECS="${2:-30}"
BIN="${PLUGIN_BIN:-/home/corona/claude-net-mpy/build/claude-net-plugin-linux-x64}"
HUB="${CLAUDE_NET_HUB:-https://telie.story-kettle.ts.net:4815}"
RUNDIR="${REPRO_CWD:-/tmp/mpy-trace-$MODE}"
OUT="${OUT:-/tmp/_mpy_$MODE.txt}"

mkdir -p "$RUNDIR"
FIFO="$RUNDIR/stdin.fifo"
rm -f "$FIFO"; mkfifo "$FIFO"

# Writer: handshake, then silence for the whole window (holds the fifo open).
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"trace-idle","version":"1"}}}'
  sleep 2
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  sleep "$((SECS + 15))"
} > "$FIFO" &
WRITER=$!

cd "$RUNDIR" || exit 1
export CLAUDE_NET_HUB="$HUB" CLAUDE_NET_LOG_LEVEL=debug

echo "== mode=$MODE secs=$SECS bin=$BIN"
case "$MODE" in
  syscalls)
    timeout -s INT "$SECS" strace -f -c -o "$OUT" "$BIN" < "$FIFO" > /dev/null 2>"$RUNDIR/stderr.log"
    ;;
  timeline)
    timeout -s INT "$SECS" strace -f -tt -T \
      -e trace=poll,ppoll,select,epoll_wait,read,recvfrom,ioctl,nanosleep,clock_nanosleep,futex \
      -o "$OUT" "$BIN" < "$FIFO" > /dev/null 2>"$RUNDIR/stderr.log"
    ;;
  perf)
    timeout -s INT "$SECS" perf record -F 999 -g --output="$RUNDIR/perf.data" \
      -- "$BIN" < "$FIFO" > /dev/null 2>"$RUNDIR/stderr.log"
    perf report --stdio --no-children -i "$RUNDIR/perf.data" 2>/dev/null | head -40 > "$OUT"
    ;;
  *) echo "unknown mode: $MODE"; kill $WRITER 2>/dev/null; exit 2 ;;
esac

kill $WRITER 2>/dev/null; wait $WRITER 2>/dev/null
echo "== plugin stderr =="; cat "$RUNDIR/stderr.log"
echo "== $OUT =="; cat "$OUT"
