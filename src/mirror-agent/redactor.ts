// Regex-based redactor for mirror-session payloads.
//
// Runs in the mirror-agent (never the hub) so redaction happens before any
// event leaves the host. Each MirrorEventFrame is inspected; string fields
// inside the payload are rewritten in place. The frame's kind, uuid, ts,
// and structural fields (tool_use_id, tool_name, stop_reason) are never
// touched — redaction only applies to free-form text and tool input/
// response payloads.
//
// Aggregate counters are logged to stderr on shutdown so users can tell
// whether redactor rules are firing too broadly (over-redaction blindness
// is a bigger risk than missed redactions).

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  MirrorAssistantMessagePayload,
  MirrorEventFrame,
  MirrorNotificationPayload,
  MirrorToolCallPayload,
  MirrorToolResultPayload,
  MirrorUserPromptPayload,
} from "@/shared/types";
import { DEFAULT_REDACT_RULES, type RedactRule } from "./redact-defaults";

const REPLACEMENT_PREFIX = "«REDACTED:";

interface CompiledRule {
  name: string;
  regex: RegExp;
  replacement: string;
}

export interface RedactorOptions {
  /** Path(s) to JSON config files with additional rules. */
  configPaths?: string[];
  /** Pre-built rule list (tests). */
  rules?: RedactRule[];
  /** Disable defaults. */
  includeDefaults?: boolean;
}

export class Redactor {
  private compiled: CompiledRule[] = [];
  private counts = new Map<string, number>();

  constructor(opts: RedactorOptions = {}) {
    const rules: RedactRule[] = [];
    if (opts.includeDefaults !== false) rules.push(...DEFAULT_REDACT_RULES);

    if (opts.configPaths) {
      for (const p of opts.configPaths) {
        rules.push(...loadRulesFromFile(p));
      }
    }
    if (opts.rules) rules.push(...opts.rules);

    for (const r of rules) {
      try {
        const regex = new RegExp(r.pattern, r.flags ?? "g");
        this.compiled.push({
          name: r.name,
          regex,
          replacement: r.replacement ?? `${REPLACEMENT_PREFIX}${r.name}»`,
        });
      } catch (err) {
        process.stderr.write(
          `[claude-net/mirror] redactor: skipped rule '${r.name}': ${String(err)}\n`,
        );
      }
    }
  }

  /** Number of loaded rules. */
  get ruleCount(): number {
    return this.compiled.length;
  }

  /** Aggregate hit counts per rule. */
  get stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counts.entries()) out[k] = v;
    return out;
  }

  /**
   * Rewrite a frame's payload in place (returns the same frame object, possibly
   * with mutated payload fields). Safe on frames without any string content.
   */
  redactFrame(frame: MirrorEventFrame): MirrorEventFrame {
    const p = frame.payload;
    switch (p.kind) {
      case "user_prompt": {
        const up = p as MirrorUserPromptPayload;
        up.prompt = this.redactString(up.prompt);
        break;
      }
      case "assistant_message": {
        const am = p as MirrorAssistantMessagePayload;
        am.text = this.redactString(am.text);
        break;
      }
      case "tool_call": {
        const tc = p as MirrorToolCallPayload;
        tc.input = this.redactAny(tc.input);
        break;
      }
      case "tool_result": {
        const tr = p as MirrorToolResultPayload;
        tr.response = this.redactAny(tr.response);
        break;
      }
      case "notification": {
        const n = p as MirrorNotificationPayload;
        n.text = this.redactString(n.text);
        break;
      }
      default:
        // session_start/end, compact: no free-form strings worth redacting.
        break;
    }
    return frame;
  }

  private redactString(input: string): string {
    if (!input) return input;
    let out = input;
    for (const rule of this.compiled) {
      // Global regexes return non-null replace count via match.length when
      // matched; we re-run a non-global clone for counting since the original
      // regex might be used in `replaceAll`. To keep it cheap we do one match
      // then a replace.
      const matches = out.match(rule.regex);
      if (matches && matches.length > 0) {
        this.counts.set(
          rule.name,
          (this.counts.get(rule.name) ?? 0) + matches.length,
        );
        out = out.replace(rule.regex, rule.replacement);
      }
    }
    return out;
  }

  private redactAny(v: unknown): unknown {
    if (v == null) return v;
    if (typeof v === "string") return this.redactString(v);
    if (Array.isArray(v)) return v.map((x) => this.redactAny(x));
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) {
        out[k] = this.redactAny(val);
      }
      return out;
    }
    return v;
  }
}

function loadRulesFromFile(p: string): RedactRule[] {
  if (!fs.existsSync(p)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[claude-net/mirror] redactor: invalid JSON in ${p}: ${String(err)}\n`,
    );
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RedactRule[] = [];
  for (const entry of data) {
    if (entry && typeof entry === "object") {
      const r = entry as Record<string, unknown>;
      if (typeof r.name === "string" && typeof r.pattern === "string") {
        out.push({
          name: r.name,
          pattern: r.pattern,
          flags: typeof r.flags === "string" ? r.flags : undefined,
          replacement:
            typeof r.replacement === "string" ? r.replacement : undefined,
        });
      }
    }
  }
  return out;
}

export function defaultConfigPaths(home: string, cwd: string): string[] {
  return [
    path.join(home, ".claude-net", "redact.json"),
    path.join(cwd, ".claude-net", "redact.json"),
  ];
}
