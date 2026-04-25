// Converts a Claude Code JSONL transcript record into a MirrorEventFrame
// of kind="history_text" — a plainer rendering used only when the
// dashboard explicitly requests backfilled history older than the hub's
// in-memory ring.
//
// Design (option C from the planning round): preserve the conversational
// content (user prompts, assistant text) and collapse tool calls/results
// to single-token placeholders inside the `text` field. This means a
// backfilled assistant turn looks like:
//
//   "I'll read the file. [tool: Read] The file contains foo."
//
// We deliberately do NOT try to recreate the live mirror_event vocabulary
// (tool_call / tool_result frames) from JSONL records — Claude Code's
// JSONL schema is undocumented and brittle to map onto the hook-driven
// shapes. A simpler, plainer representation is good enough for the
// "scroll back to read the conversation" use case.

import crypto from "node:crypto";
import type { MirrorEventFrame } from "@/shared/types";
import type { JsonlRecord } from "./jsonl-tail";

const HISTORY_TEXT_MAX_BYTES = 256 * 1024;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Convert a single JSONL record to zero or one `MirrorEventFrame` of
 * kind="history_text". Returns null when the record produces no
 * renderable text (e.g. summary records, malformed entries).
 */
export function jsonlRecordToHistoryFrame(
  sid: string,
  rec: JsonlRecord,
): MirrorEventFrame | null {
  const role = roleFor(rec);
  if (!role) return null;

  const text = textFor(role, rec);
  if (!text) return null;

  const ts = parseTs(rec.timestamp);
  const uuid =
    typeof rec.uuid === "string" && rec.uuid.length > 0
      ? rec.uuid
      : crypto.randomUUID();

  return {
    action: "mirror_event",
    sid,
    uuid,
    kind: "history_text",
    ts,
    payload: {
      kind: "history_text",
      role,
      text: clamp(text),
    },
  };
}

function roleFor(rec: JsonlRecord): "user" | "assistant" | "system" | null {
  const t = rec.type;
  if (t === "user") return "user";
  if (t === "assistant") return "assistant";
  if (t === "system") return "system";
  return null;
}

function textFor(
  role: "user" | "assistant" | "system",
  rec: JsonlRecord,
): string {
  // System records carry their text directly on the record.
  if (role === "system") {
    if (typeof rec.content === "string") return rec.content;
    if (typeof rec.text === "string") return rec.text;
    return "";
  }

  // User and assistant records embed content in rec.message (Claude API
  // shape: either a string or an array of typed blocks).
  const message = rec.message as { content?: unknown } | undefined;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const raw of content as ContentBlock[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type === "text" && typeof raw.text === "string") {
      parts.push(raw.text);
    } else if (raw.type === "tool_use") {
      const name = typeof raw.name === "string" ? raw.name : "tool";
      parts.push(`[tool: ${name}]`);
    } else if (raw.type === "tool_result") {
      parts.push(raw.is_error ? "[result: error]" : "[result]");
    }
    // Other block types (thinking, image, etc.) are skipped.
  }
  return parts.join(" ").trim();
}

function parseTs(timestamp: unknown): number {
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function clamp(s: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= HISTORY_TEXT_MAX_BYTES) return s;
  return `${buf.subarray(0, HISTORY_TEXT_MAX_BYTES).toString("utf8")}…`;
}
