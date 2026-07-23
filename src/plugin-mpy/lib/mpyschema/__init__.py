"""mpyschema: explicit parameter specs, turned into MCP inputSchema fragments.

Emits `{"type":"object","properties":{...},"required":[...]}`
JSON-Schema fragments from explicit spec objects, and validates/coerces
incoming tool arguments against them. Ground truth is the explicit spec API,
not runtime introspection: MicroPython retains neither annotations nor
parameter-name information on function objects.

# Phase P5 — not yet implemented
"""
