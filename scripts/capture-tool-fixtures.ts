#!/usr/bin/env bun
// Round-trip fixture capture for dashboard tool-response parsers.
//
// Two modes:
//   default: overwrite tests/hub/fixtures/tool-responses/<tool>.json
//   --check: re-capture in-memory, diff against disk, exit 1 on drift.
//
// Usage:
//   bun run capture-fixtures
//   bun run capture-fixtures --tool Read,WebSearch
//   bun run capture-fixtures --sid <sid>
//   bun run capture-fixtures --check
//
// Resolves hub URL from --hub, $CLAUDE_NET_HUB, or http://localhost:4815.

import * as fs from "node:fs";
import * as path from "node:path";

interface Args {
  sid: string | null;
  tools: Set<string> | null;
  check: boolean;
  hub: string;
}

const FIXTURE_DIR = path.resolve(
  import.meta.dir,
  "../tests/hub/fixtures/tool-responses",
);

const TRUNCATE_BYTES = 16 * 1024;

/** Volatile fields stripped before writing fixtures. */
const VOLATILE_KEYS = new Set([
  "uuid",
  "tool_use_id",
  "timestamp",
  "ts",
  "captured_at",
  "session_id",
]);

function parseArgs(argv: readonly string[]): Args {
  let sid: string | null = null;
  let tools: Set<string> | null = null;
  let check = false;
  let hub = process.env.CLAUDE_NET_HUB ?? "http://localhost:4815";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") check = true;
    else if (a === "--sid") sid = argv[++i] ?? null;
    else if (a === "--tool")
      tools = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    else if (a === "--hub") hub = argv[++i] ?? hub;
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    }
  }
  return { sid, tools, check, hub };
}

function printUsage(): void {
  process.stdout.write(
    "Usage: bun run capture-fixtures [--sid SID] [--tool NAME[,NAME...]] [--check] [--hub URL]\n",
  );
}

async function findSid(hub: string): Promise<string> {
  const resp = await fetch(`${hub}/api/mirror/sessions/all`);
  if (!resp.ok) throw new Error(`GET /sessions/all → ${resp.status}`);
  const list = (await resp.json()) as Array<{
    sid: string;
    last_event_at?: string;
  }>;
  if (!list.length) throw new Error("No live mirror sessions.");
  list.sort((a, b) =>
    (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""),
  );
  const first = list[0];
  if (!first) throw new Error("No live mirror sessions.");
  return first.sid;
}

interface TranscriptEvent {
  uuid: string;
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
}

async function fetchTranscript(
  hub: string,
  sid: string,
): Promise<TranscriptEvent[]> {
  const resp = await fetch(
    `${hub}/api/mirror/${encodeURIComponent(sid)}/transcript`,
  );
  if (!resp.ok) throw new Error(`GET /transcript → ${resp.status}`);
  const body = (await resp.json()) as { transcript?: TranscriptEvent[] };
  return body.transcript ?? [];
}

interface ToolPair {
  tool_name: string;
  input: unknown;
  response: unknown;
}

/** Walk the transcript and pair tool_call + tool_result by tool_use_id. */
function pairToolEvents(transcript: TranscriptEvent[]): Map<string, ToolPair> {
  const pending = new Map<string, { tool_name: string; input: unknown }>();
  const pairs = new Map<string, ToolPair>();
  for (const evt of transcript) {
    const payload = evt.payload as Record<string, unknown>;
    if (evt.kind === "tool_call") {
      const id = String(payload.tool_use_id ?? "");
      const name = String(payload.tool_name ?? "");
      if (!id || !name) continue;
      pending.set(id, { tool_name: name, input: payload.input });
    } else if (evt.kind === "tool_result") {
      const id = String(payload.tool_use_id ?? "");
      const p = pending.get(id);
      if (!p) continue;
      // Most-recent pair per tool name wins.
      pairs.set(p.tool_name, {
        tool_name: p.tool_name,
        input: p.input,
        response: payload.response ?? payload.tool_response ?? null,
      });
    }
  }
  return pairs;
}

/** Recursive strip: truncate long strings and drop volatile keys. */
function sanitize<T>(value: T): T {
  if (typeof value === "string") {
    if (value.length > TRUNCATE_BYTES) {
      return `${value.slice(0, TRUNCATE_BYTES)}\n[TRUNCATED ${value.length - TRUNCATE_BYTES} more chars]` as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = sanitize(v);
    }
    return out as unknown as T;
  }
  return value;
}

function fixturePath(toolName: string): string {
  return path.join(FIXTURE_DIR, `${toolName}.json`);
}

function writeFixture(toolName: string, pair: ToolPair): void {
  const body = {
    tool_name: toolName,
    input: sanitize(pair.input),
    response: sanitize(pair.response),
    captured_at: new Date().toISOString(),
  };
  fs.writeFileSync(fixturePath(toolName), `${JSON.stringify(body, null, 2)}\n`);
}

function diffFixture(toolName: string, pair: ToolPair): string[] {
  const target = fixturePath(toolName);
  if (!fs.existsSync(target)) return [`${toolName}: no committed fixture`];
  const disk = JSON.parse(fs.readFileSync(target, "utf8")) as {
    input: unknown;
    response: unknown;
  };
  // Compare only the parser-facing fields (ignore captured_at).
  const live = {
    input: sanitize(pair.input),
    response: sanitize(pair.response),
  };
  const diffs: string[] = [];
  const liveStr = JSON.stringify(live, null, 2);
  const diskStr = JSON.stringify(
    { input: disk.input, response: disk.response },
    null,
    2,
  );
  if (liveStr !== diskStr) {
    diffs.push(`${toolName}: live response differs from committed fixture`);
  }
  return diffs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sid = args.sid ?? (await findSid(args.hub));
  const transcript = await fetchTranscript(args.hub, sid);
  const pairs = pairToolEvents(transcript);

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const names = args.tools
    ? [...pairs.keys()].filter((n) => args.tools?.has(n))
    : [...pairs.keys()];

  if (!names.length) {
    process.stderr.write(
      "No matching tool calls found in transcript. Exercise the tools first.\n",
    );
    process.exit(2);
  }

  if (args.check) {
    const all: string[] = [];
    for (const name of names) {
      const pair = pairs.get(name);
      if (!pair) continue;
      all.push(...diffFixture(name, pair));
    }
    if (all.length) {
      process.stderr.write(`${all.join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write(`${names.length} fixture(s) match.\n`);
    return;
  }

  for (const name of names) {
    const pair = pairs.get(name);
    if (!pair) continue;
    writeFixture(name, pair);
    process.stdout.write(`wrote ${name}.json\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`capture-tool-fixtures: ${err?.message ?? err}\n`);
  process.exit(1);
});
