import asyncio, sys
async def rd():
    sr = asyncio.StreamReader(sys.stdin.buffer)
    while True:
        l = await sr.readline()
        if not l: break
async def main():
    await asyncio.wait_for(rd(), 1.5)
try:
    asyncio.run(main())
except Exception as e:
    print("timeout ok:", type(e).__name__)
