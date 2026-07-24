# Minimal repro of the picolet mcp asyncio/stdin read(n) defect.
#
# Runs inside the picolet-runtime-linux-x64-mcp binary:
#   picolet-runtime-linux-x64-mcp stdin_repro.py <mode>
# where <mode> is "read" (exercise asyncio Stream.read(n)) or
# "readline" (exercise asyncio Stream.readline() control).
#
# A concurrent ticker task increments a counter on a fixed 20ms cadence.
# The reader task performs successive awaited reads. For every completed
# read the script prints one JSON line to stdout:
#   {"i":<idx>,"len":<bytes>,"dt_ms":<ms since prev read>,"ticks":<ticker count>}
# plus a final {"done":...} line. The driver on the CPython side feeds
# stdin in bursts separated by deliberate gaps and checks, objectively:
#   - whether the 2nd+ read returns data (len>0) after each gap, and
#   - how many ticker ticks accrue while the reader is blocked on a gap.
import asyncio
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "read"

ticks = 0
stop = False


async def ticker():
    global ticks
    while not stop:
        ticks += 1
        await asyncio.sleep_ms(20)


async def reader_task():
    global stop
    reader = asyncio.StreamReader(sys.stdin.buffer)
    last = time.ticks_ms()
    i = 0
    while True:
        if mode == "readline":
            data = await reader.readline()
        else:
            data = await reader.read(4096)
        now = time.ticks_ms()
        dt = time.ticks_diff(now, last)
        last = now
        n = len(data)
        print(
            '{"i":%d,"len":%d,"dt_ms":%d,"ticks":%d}' % (i, n, dt, ticks)
        )
        sys.stdout.flush()
        i += 1
        if n == 0:
            # EOF (or spurious empty read treated as EOF by every caller).
            break
    stop = True
    print('{"done":true,"reads":%d,"final_ticks":%d}' % (i, ticks))
    sys.stdout.flush()


async def main():
    t = asyncio.create_task(ticker())
    await reader_task()
    t.cancel()


asyncio.run(main())
