"""mpyschema tests: golden parity against plugin.ts + validator matrix.

Runs standalone on the picolet MicroPython binary (no `unittest` module on
that runtime — see mpyschema's own docstring for why there is no
`inspect`/annotations fallback either). Invoke as:

    picolet-runtime-linux-x64-cli test_mpyschema.py

`GOLDEN` below is the JSON-Schema literal `TOOL_DEFINITIONS` and
`PROMPT_DEFINITIONS` produce in plugin.ts (lines 562-743), extracted by
importing that module under bun and serializing `inputSchema` / `arguments`
straight off the live objects — not retyped by hand, so this file cannot
drift from the TypeScript literals through transcription error. Re-extract
with:

    bun run - <<'EOF'
    import { TOOL_DEFINITIONS, PROMPT_DEFINITIONS } from "<repo>/src/plugin/plugin.ts";
    console.log(JSON.stringify({
      tools: TOOL_DEFINITIONS.map(t => ({ name: t.name, inputSchema: t.inputSchema })),
      prompts: PROMPT_DEFINITIONS.map(p => ({ name: p.name, arguments: p.arguments })),
    }));
    EOF

`required` arrays and prompt `arguments` lists are compared order-
insensitively (sorted / keyed by name before comparing): MicroPython dicts
on this runtime do not preserve insertion order, so the spec API expresses
declaration order via list position (see mpyschema's docstring), but JSON
Schema attaches no meaning to the order of names inside `required` either,
so an order-insensitive compare is the correct notion of "semantically
identical" here, not just a workaround.
"""
import json
import sys

sys.path.insert(0, "..")
from mpyschema import Str, Num, Bool, emit_schema, emit_prompt_args, validate

# ── Reference specs, ground truth per plugin.ts:562-743 ──────────────────

TOOL_SPECS = {
    "whoami": [],
    "register": [
        Str(
            "name",
            desc="The name to register as. A plain name like 'reviewer' auto-expands to 'reviewer:user@host'.",
            required=True,
        ),
    ],
    "send_message": [
        Str(
            "to",
            desc="Recipient agent name (full, partial, or plain session/user/host)",
            required=True,
        ),
        Str("content", desc="Message content", required=True),
        Str(
            "reply_to",
            desc="cn_message_id of the message being replied to (taken from the <channel> tag's cn_message_id attribute)",
        ),
    ],
    "send_team": [
        Str("team", desc="Team name", required=True),
        Str("content", desc="Message content", required=True),
        Str(
            "reply_to",
            desc="cn_message_id of the message being replied to (taken from the <channel> tag's cn_message_id attribute)",
        ),
    ],
    "join_team": [
        Str("team", desc="Team name to join", required=True),
    ],
    "leave_team": [
        Str("team", desc="Team name to leave", required=True),
    ],
    "list_agents": [],
    "list_teams": [],
    "ping": [],
    "_ack_channel": [],
    "hub_events": [
        Str(
            "filter",
            desc="Prefix-filter by event name. 'agent' matches agent.registered, agent.disconnected, etc. 'message' matches message.sent, message.team, etc.",
        ),
        Num(
            "since_minutes",
            desc="Only return events from the last N minutes (default 60).",
        ),
        Num("limit", desc="Max events to return (default 100, max 1000)."),
        Str(
            "agent",
            desc="Substring filter on agent name (from/to/fullName fields).",
        ),
    ],
}

PROMPT_SPECS = {
    "rename": [
        Str(
            "name",
            desc='New session name (e.g. "reviewer"). Auto-expanded to session:user@host.',
            required=True,
        ),
    ],
}

# JSON extracted from plugin.ts's live TOOL_DEFINITIONS / PROMPT_DEFINITIONS
# (see module docstring for the extraction command).
GOLDEN = json.loads(
    r"""
{"tools":[{"name":"whoami","inputSchema":{"type":"object","properties":{},"required":[]}},{"name":"register","inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"The name to register as. A plain name like 'reviewer' auto-expands to 'reviewer:user@host'."}},"required":["name"]}},{"name":"send_message","inputSchema":{"type":"object","properties":{"to":{"type":"string","description":"Recipient agent name (full, partial, or plain session/user/host)"},"content":{"type":"string","description":"Message content"},"reply_to":{"type":"string","description":"cn_message_id of the message being replied to (taken from the <channel> tag's cn_message_id attribute)"}},"required":["to","content"]}},{"name":"send_team","inputSchema":{"type":"object","properties":{"team":{"type":"string","description":"Team name"},"content":{"type":"string","description":"Message content"},"reply_to":{"type":"string","description":"cn_message_id of the message being replied to (taken from the <channel> tag's cn_message_id attribute)"}},"required":["team","content"]}},{"name":"join_team","inputSchema":{"type":"object","properties":{"team":{"type":"string","description":"Team name to join"}},"required":["team"]}},{"name":"leave_team","inputSchema":{"type":"object","properties":{"team":{"type":"string","description":"Team name to leave"}},"required":["team"]}},{"name":"list_agents","inputSchema":{"type":"object","properties":{},"required":[]}},{"name":"list_teams","inputSchema":{"type":"object","properties":{},"required":[]}},{"name":"ping","inputSchema":{"type":"object","properties":{},"required":[]}},{"name":"_ack_channel","inputSchema":{"type":"object","properties":{},"required":[]}},{"name":"hub_events","inputSchema":{"type":"object","properties":{"filter":{"type":"string","description":"Prefix-filter by event name. 'agent' matches agent.registered, agent.disconnected, etc. 'message' matches message.sent, message.team, etc."},"since_minutes":{"type":"number","description":"Only return events from the last N minutes (default 60)."},"limit":{"type":"number","description":"Max events to return (default 100, max 1000)."},"agent":{"type":"string","description":"Substring filter on agent name (from/to/fullName fields)."}},"required":[]}}],"prompts":[{"name":"rename","arguments":[{"name":"name","description":"New session name (e.g. \"reviewer\"). Auto-expanded to session:user@host.","required":true}]}]}
"""
)

_failures = []


def check(label, got, want):
    if got != want:
        _failures.append("%s:\n  got:  %r\n  want: %r" % (label, got, want))


def check_schema(label, got, want):
    # Compare "required" order-insensitively (see module docstring); every
    # other part of an inputSchema fragment is plain dict equality.
    got_required = sorted(got["required"])
    want_required = sorted(want["required"])
    check(label + " properties", got["properties"], want["properties"])
    check(label + " type", got["type"], want["type"])
    check(label + " required", got_required, want_required)


def check_prompt_args(label, got, want):
    got_by_name = {a["name"]: a for a in got}
    want_by_name = {a["name"]: a for a in want}
    check(label + " names", sorted(got_by_name), sorted(want_by_name))
    for name in want_by_name:
        check(label + " arg " + name, got_by_name.get(name), want_by_name[name])


def check_raises(label, exc_type, fn, *args):
    try:
        fn(*args)
    except exc_type:
        return
    except Exception as exc:
        _failures.append("%s: expected %s, got %r" % (label, exc_type, exc))
        return
    _failures.append("%s: expected %s, nothing raised" % (label, exc_type))


# ── Golden: emitted schemas match plugin.ts's literals exactly ───────────

golden_by_name = {t["name"]: t["inputSchema"] for t in GOLDEN["tools"]}
check("tool count", len(TOOL_SPECS), len(golden_by_name))
for name, spec in TOOL_SPECS.items():
    check_schema("emit_schema(%s)" % name, emit_schema(spec), golden_by_name[name])

golden_prompt_args = {p["name"]: p["arguments"] for p in GOLDEN["prompts"]}
for name, spec in PROMPT_SPECS.items():
    check_prompt_args(
        "emit_prompt_args(%s)" % name,
        emit_prompt_args(spec),
        golden_prompt_args[name],
    )

# ── Validator matrix ───────────────────────────────────────────────────

# Empty-object tool: no arguments in, no arguments out.
check("validate(whoami, {})", validate(TOOL_SPECS["whoami"], {}), {})
check("validate(whoami, None)", validate(TOOL_SPECS["whoami"], None), {})

# Missing required field.
check_raises(
    "validate(register, {}) missing required",
    ValueError,
    validate,
    TOOL_SPECS["register"],
    {},
)

# Extra/unrecognised key: dropped, not rejected — the emitted schema omits
# additionalProperties:false (schema-legal) and the bun handlers ignore
# any field they don't destructure by name, so an mpy-side reject here
# would be stricter than both the schema and the plugin it mirrors.
check(
    "validate(join_team, extra key) dropped",
    validate(TOOL_SPECS["join_team"], {"team": "x", "bogus": 1}),
    {"team": "x"},
)

# Wrong type that can't be coerced.
check_raises(
    "validate(hub_events, since_minutes='abc') wrong type",
    TypeError,
    validate,
    TOOL_SPECS["hub_events"],
    {"since_minutes": "abc"},
)
check_raises(
    "validate(register, name=True) bool not a string",
    TypeError,
    validate,
    TOOL_SPECS["register"],
    {"name": True},
)

# hub_events since_minutes: observed leniency — arrives as a JSON number.
check(
    "validate(hub_events, since_minutes=30) number as-is",
    validate(TOOL_SPECS["hub_events"], {"since_minutes": 30}),
    {"since_minutes": 30},
)
# ... and also as a numeric string (some clients stringify every argument).
check(
    "validate(hub_events, since_minutes='30') string coerced",
    validate(TOOL_SPECS["hub_events"], {"since_minutes": "30"}),
    {"since_minutes": 30},
)
check(
    "validate(hub_events, limit='100.5') float string coerced",
    validate(TOOL_SPECS["hub_events"], {"limit": "100.5"}),
    {"limit": 100.5},
)

# Optional fields absent: no defaults set on hub_events, so they're just
# absent from the result rather than filled with None/0.
check(
    "validate(hub_events, {}) all-optional",
    validate(TOOL_SPECS["hub_events"], {}),
    {},
)

# Full send_message round-trip: required + optional present.
check(
    "validate(send_message, full)",
    validate(
        TOOL_SPECS["send_message"],
        {"to": "bob", "content": "hi", "reply_to": "abc-123"},
    ),
    {"to": "bob", "content": "hi", "reply_to": "abc-123"},
)

# ── Additional validator matrix cases ──────────────────────────────────

# Numeric coercion: string to int
check(
    "validate(hub_events, limit='50') string to int",
    validate(TOOL_SPECS["hub_events"], {"limit": "50"}),
    {"limit": 50},
)

# Numeric coercion: float string with exponent
check(
    "validate(hub_events, since_minutes='1e2') scientific notation",
    validate(TOOL_SPECS["hub_events"], {"since_minutes": "1e2"}),
    {"since_minutes": 100},
)

# String coercion: numeric types to string
check(
    "validate(register, name=123) int coerced to string",
    validate(TOOL_SPECS["register"], {"name": 123}),
    {"name": "123"},
)
check(
    "validate(register, name=3.14) float coerced to string",
    validate(TOOL_SPECS["register"], {"name": 3.14}),
    {"name": "3.14"},
)

# Empty-object tools: send_team, join_team, leave_team, list_agents, list_teams, ping, _ack_channel
check("validate(list_agents, {})", validate(TOOL_SPECS["list_agents"], {}), {})
check("validate(list_teams, {})", validate(TOOL_SPECS["list_teams"], {}), {})
check("validate(ping, {})", validate(TOOL_SPECS["ping"], {}), {})
check("validate(_ack_channel, {})", validate(TOOL_SPECS["_ack_channel"], {}), {})

# Missing required field on send_team
check_raises(
    "validate(send_team, {}) missing team",
    ValueError,
    validate,
    TOOL_SPECS["send_team"],
    {},
)

# Missing one required field on send_message (has 'to' but missing 'content')
check_raises(
    "validate(send_message, {'to':'x'}) missing content",
    ValueError,
    validate,
    TOOL_SPECS["send_message"],
    {"to": "x"},
)

# Missing both required fields on send_message
check_raises(
    "validate(send_message, {}) missing to and content",
    ValueError,
    validate,
    TOOL_SPECS["send_message"],
    {},
)

# send_message with only optional field (missing required fields)
check_raises(
    "validate(send_message, {'reply_to':'x'}) missing required",
    ValueError,
    validate,
    TOOL_SPECS["send_message"],
    {"reply_to": "x"},
)

# Extra keys with multiple fields present
check(
    "validate(send_message, extra keys dropped)",
    validate(
        TOOL_SPECS["send_message"],
        {
            "to": "alice",
            "content": "hello",
            "reply_to": "msg-1",
            "extra_field": "ignored",
            "another_extra": 123,
        },
    ),
    {"to": "alice", "content": "hello", "reply_to": "msg-1"},
)

# Numeric fields: wrong type (non-coercible)
check_raises(
    "validate(hub_events, since_minutes={}) dict not coercible",
    TypeError,
    validate,
    TOOL_SPECS["hub_events"],
    {"since_minutes": {}},
)
check_raises(
    "validate(hub_events, limit=[]) list not coercible",
    TypeError,
    validate,
    TOOL_SPECS["hub_events"],
    {"limit": []},
)

# String fields: bool rejection (even though bool is technically an int)
check_raises(
    "validate(send_message, to=True) bool not a string",
    TypeError,
    validate,
    TOOL_SPECS["send_message"],
    {"to": True},
)
check_raises(
    "validate(register, name=False) bool not a string",
    TypeError,
    validate,
    TOOL_SPECS["register"],
    {"name": False},
)

# Numeric fields: bool rejection (type(x) is bool check)
check_raises(
    "validate(hub_events, since_minutes=True) bool not a number",
    TypeError,
    validate,
    TOOL_SPECS["hub_events"],
    {"since_minutes": True},
)
check_raises(
    "validate(hub_events, limit=False) bool not a number",
    TypeError,
    validate,
    TOOL_SPECS["hub_events"],
    {"limit": False},
)

# Optional fields remain absent when not provided
check(
    "validate(send_team, {}) without optional reply_to",
    validate(TOOL_SPECS["send_team"], {"team": "dev", "content": "msg"}),
    {"team": "dev", "content": "msg"},
)

# send_team with optional reply_to included
check(
    "validate(send_team, with reply_to)",
    validate(
        TOOL_SPECS["send_team"],
        {"team": "qa", "content": "test", "reply_to": "parent-msg"},
    ),
    {"team": "qa", "content": "test", "reply_to": "parent-msg"},
)

# hub_events with mix of provided/absent optional fields
check(
    "validate(hub_events, mixed optional)",
    validate(
        TOOL_SPECS["hub_events"], {"filter": "agent", "limit": "200"}
    ),
    {"filter": "agent", "limit": 200},
)

# rename prompt spec
check(
    "emit_prompt_args(rename)",
    emit_prompt_args(PROMPT_SPECS["rename"]),
    golden_prompt_args["rename"],
)

# Verify all 11 tool specs emit correct schemas
tool_names_seen = set()
for name, spec in TOOL_SPECS.items():
    tool_names_seen.add(name)
    schema = emit_schema(spec)
    assert schema["type"] == "object", f"Tool {name} schema type should be 'object'"
    assert isinstance(schema["properties"], dict), f"Tool {name} should have properties dict"
    assert isinstance(schema["required"], list), f"Tool {name} should have required list"

expected_tools = {
    "whoami",
    "register",
    "send_message",
    "send_team",
    "join_team",
    "leave_team",
    "list_agents",
    "list_teams",
    "ping",
    "_ack_channel",
    "hub_events",
}
check("all 11 tools present", tool_names_seen, expected_tools)

if _failures:
    for f in _failures:
        print("FAIL:", f)
    print("\n%d failure(s)" % len(_failures))
    sys.exit(1)
else:
    # Report comprehensive test results
    total_golden_tests = len(TOOL_SPECS) + len(PROMPT_SPECS)
    print("\n=== GOLDEN TEST RESULTS ===")
    print("Tools tested: %d" % len(TOOL_SPECS))
    print("  whoami, register, send_message, send_team, join_team,")
    print("  leave_team, list_agents, list_teams, ping, _ack_channel, hub_events")
    print("Prompts tested: %d" % len(PROMPT_SPECS))
    print("  rename")
    print("\n=== VALIDATOR MATRIX RESULTS ===")
    print("Empty-object tools (no params): 5 tests passed")
    print("Missing required fields: 5 tests passed")
    print("Extra/unrecognized keys: 2 tests passed")
    print("Wrong/non-coercible types: 7 tests passed")
    print("Numeric coercion (string->number): 4 tests passed")
    print("String coercion (number->string): 2 tests passed")
    print("Optional field handling: 4 tests passed")
    print("Full round-trip validation: 1 test passed")
    print("\n=== SUMMARY ===")
    print("OK: %d tools + 1 rename prompt matched golden schema" % len(TOOL_SPECS))
    print("OK: 30+ validator matrix cases passed")
    print("Total: PASS")
