"""mpyschema: explicit parameter specs, turned into MCP inputSchema fragments.

Emits `{"type":"object","properties":{...},"required":[...]}` JSON-Schema
fragments (and MCP prompt `arguments` lists) from explicit spec objects, and
validates/coerces incoming tool arguments against those same specs.

Why explicit specs instead of reading type hints off the tool function:
MicroPython retains neither annotations nor parameter-name information on
function objects at runtime. `f.__annotations__` raises `AttributeError` on
the target binary, and there is no `inspect` module to fall back on. A
schema layer built on introspection therefore cannot exist on this runtime;
an explicit spec, written once per tool and consumed by both the emitter and
the validator, is the only representation that works unconditionally. (A
build-time CPython codegen step that derives these spec literals from a
type-hinted source of truth is an orthogonal, additive concern — out of
scope here — and would target this same spec API as its output.)

Spec shape: a tool's parameters are a plain **list** of named `Field`
instances, in declaration order:

    SPEC = [
        Str("to", desc="Recipient agent name", required=True),
        Str("content", desc="Message content", required=True),
        Str("reply_to", desc="cn_message_id of the message being replied to"),
    ]

    input_schema = emit_schema(SPEC)
    arguments = validate(SPEC, incoming_arguments)

A list, not a dict keyed by parameter name, because plain dicts on this
runtime do not preserve insertion order (iteration order is hash-bucket
order, e.g. `{"zebra":1,"apple":2,"mango":3}` iterates as `zebra, mango,
apple`) — a dict-keyed spec could not guarantee the `required` array or a
prompt's `arguments` list come out in declaration order. A list always
does.

The same shape, read for `desc`/`required` only (the JSON type is
irrelevant to a prompt argument), backs MCP prompt argument lists:

    RENAME_SPEC = [Str("name", desc="New session name", required=True)]
    prompt_arguments = emit_prompt_args(RENAME_SPEC)
"""


class Field:
    """Base parameter spec: a name, a JSON-Schema type, description, and
    requiredness.

    Subclasses set `kind` to the JSON-Schema `type` string and implement
    `coerce()` to accept the loosely-typed values MCP clients actually send
    (see `validate()`).
    """

    kind = None

    def __init__(self, name, desc=None, required=False, default=None):
        self.name = name
        self.desc = desc
        self.required = required
        self.default = default

    def coerce(self, value):
        raise NotImplementedError


class Str(Field):
    """A JSON-Schema `"type": "string"` parameter."""

    kind = "string"

    def coerce(self, value):
        if type(value) is bool:
            raise TypeError("expected a string, got a bool")
        if isinstance(value, str):
            return value
        if isinstance(value, (int, float)):
            return str(value)
        raise TypeError("expected a string")


class Num(Field):
    """A JSON-Schema `"type": "number"` parameter.

    Accepts a JSON number as-is. Also accepts a numeric string (some MCP
    clients send every argument as a string regardless of the declared
    schema type) and parses it as int or float depending on its literal
    form.
    """

    kind = "number"

    def coerce(self, value):
        if type(value) is bool:
            raise TypeError("expected a number, got a bool")
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            try:
                if "." in value or "e" in value or "E" in value:
                    return float(value)
                return int(value)
            except ValueError:
                raise TypeError("expected a number, got %r" % (value,))
        raise TypeError("expected a number")


class Bool(Field):
    """A JSON-Schema `"type": "boolean"` parameter.

    Accepts a JSON boolean as-is, plus the string/int forms a lenient
    client may send instead ("true"/"false", "1"/"0", 1/0).
    """

    kind = "boolean"

    def coerce(self, value):
        if type(value) is bool:
            return value
        if isinstance(value, str):
            lowered = value.lower()
            if lowered in ("true", "1", "yes"):
                return True
            if lowered in ("false", "0", "no"):
                return False
            raise TypeError("expected a boolean, got %r" % (value,))
        if isinstance(value, int):
            return bool(value)
        raise TypeError("expected a boolean")


def emit_schema(spec):
    """spec (list of named Field, declaration order) -> MCP `inputSchema`.

    Produces `{"type": "object", "properties": {...}, "required": [...]}`;
    `required` lists only the names of fields with `required=True`, in
    spec-declaration order. An empty spec yields `properties: {}` and
    `required: []` (the shape used by the zero-argument tools).
    """
    properties = {}
    required = []
    for field in spec:
        prop = {"type": field.kind}
        if field.desc is not None:
            prop["description"] = field.desc
        properties[field.name] = prop
        if field.required:
            required.append(field.name)
    return {"type": "object", "properties": properties, "required": required}


def emit_prompt_args(spec):
    """spec (list of named Field, declaration order) -> MCP prompt
    `arguments` list.

    Produces a list of `{"name", "description", "required"}` dicts, one per
    spec entry in declaration order. The JSON type on each `Field` is
    unused here — MCP prompt arguments carry no type, only a description
    and whether they are required.
    """
    arguments = []
    for field in spec:
        arguments.append(
            {
                "name": field.name,
                "description": field.desc,
                "required": bool(field.required),
            }
        )
    return arguments


def validate(spec, arguments):
    """Check and coerce incoming tool `arguments` against `spec`.

    Raises `ValueError` for a missing required field, `TypeError` if a
    present value cannot be coerced to its field's declared type. Returns a
    new dict containing only the names declared in `spec`; `arguments` is
    not mutated.

    Keys in `arguments` that are not named in `spec` are silently dropped,
    not rejected. This matches both the emitted schema (`emit_schema` never
    sets `additionalProperties: false`, so extra keys are schema-legal) and
    the bun plugin's handlers, which destructure only their named
    parameters off the arguments object and never look at, let alone
    reject, anything else present. A validator stricter than the schema it
    emits would reject calls the bun plugin services successfully.

    Matches the leniency of the bun plugin's hand-written schemas, whose
    JS handlers never actually enforce the declared JSON type: a `Num`
    field accepts either a JSON number or a numeric string, and a `Bool`
    field accepts either a JSON boolean or its common string/int forms.
    """
    if arguments is None:
        arguments = {}
    result = {}
    for field in spec:
        if field.name in arguments:
            try:
                result[field.name] = field.coerce(arguments[field.name])
            except TypeError as exc:
                raise TypeError("parameter %r: %s" % (field.name, exc))
        elif field.required:
            raise ValueError("missing required parameter: %s" % field.name)
        elif field.default is not None:
            result[field.name] = field.default
    return result
