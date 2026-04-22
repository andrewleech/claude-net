# Tool-response fixtures

One JSON file per tool — the captured `input` and `response` Claude Code sent
through a PreToolUse / PostToolUse hook. The dashboard parsers in
`src/hub/dashboard/parsers.js` are tested against these.

Regenerate against a live mirror session:

```
bun run capture-fixtures                    # overwrite all tools
bun run capture-fixtures --tool Read        # just one
bun run capture-fixtures --check            # drift detector
```

The capture script strips volatile fields (`uuid`, `tool_use_id`,
`timestamp`, etc.) and truncates long strings so fixtures stay diff-friendly.
