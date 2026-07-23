import asyncio, sys, time

async def ticker(state):
    n = 0
    while not state['done']:
        n += 1
        state['ticks'] = n
        await asyncio.sleep_ms(100)
    print("ticker stopped at", n, "ticks")

async def reader(state):
    sr = asyncio.StreamReader(sys.stdin.buffer)
    while True:
        line = await sr.readline()
        if not line:               # EOF -> b''
            print("EOF detected, ticks so far=", state['ticks'])
            break
        print("LINE:", line.rstrip().decode(), "ticks=", state['ticks'])
    state['done'] = True

async def main():
    state = {'ticks': 0, 'done': False}
    t = asyncio.create_task(ticker(state))
    await reader(state)
    await t

asyncio.run(main())
print("clean exit")
