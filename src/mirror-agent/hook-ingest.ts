// Converts a Claude Code hook payload (delivered to the mirror-agent via a
// loopback POST /hook) into a MirrorEventFrame ready to forward to the hub.
//
// Hook payload field names are taken from current Claude Code docs; we treat
// the input permissively (all fields optional) because hook payloads vary by
// Claude Code version, and we prefer to emit a best-effort event than to
// drop it entirely.
//
// See: docs/MIRROR_SESSION_PHASE_1.md "Hook set" table.

import crypto from "node:crypto";
import type {
  MirrorEventFrame,
  MirrorEventPayload,
  MirrorSessionSource,
} from "@/shared/types";

export const MAX_STRING_FIELD_BYTES = 256 * 1024; // 256 KB per field

export interface RawHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  last_assistant_message?: string;
  stop_reason?: string;
  message?: string;
  phase?: string;
  summary?: string;
  /** Synthetic metadata added by claude-net-mirror-push (not a hook field). */
  _mirror_env?: {
    TMUX?: string;
    TMUX_PANE?: string;
  };
  // Forward-compatible: allow unknown keys.
  [key: string]: unknown;
}

export interface IngestedEvent {
  sid: string;
  frame: MirrorEventFrame;
  transcriptPath: string | undefined;
  cwd: string | undefined;
  tmuxPane: string | undefined;
}

/**
 * Ingest a raw hook payload and produce a MirrorEventFrame, or null if the
 * payload is unusable (no session_id). The returned frame uses a freshly
 * generated uuid (hooks don't carry one); the JSONL tail supplies the
 * canonical uuid for reconciliation.
 */
export function ingestHook(payload: RawHookPayload): IngestedEvent | null {
  const hook = payload.hook_event_name;
  const sid = payload.session_id;
  if (!hook || !sid) return null;

  const ts = Date.now();
  const base = {
    action: "mirror_event" as const,
    sid,
    uuid: crypto.randomUUID(),
    ts,
  };

  const mirrorPayload = hookToPayload(hook, payload);
  if (!mirrorPayload) return null;

  const frame: MirrorEventFrame = {
    ...base,
    kind: mirrorPayload.kind,
    payload: mirrorPayload,
  };

  return {
    sid,
    frame,
    transcriptPath:
      typeof payload.transcript_path === "string"
        ? payload.transcript_path
        : undefined,
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    tmuxPane:
      typeof payload._mirror_env?.TMUX_PANE === "string"
        ? payload._mirror_env.TMUX_PANE
        : undefined,
  };
}

function hookToPayload(
  hook: string,
  p: RawHookPayload,
): MirrorEventPayload | null {
  switch (hook) {
    case "SessionStart":
      return {
        kind: "session_start",
        source: coerceSource(p.source),
        transcript_path: stringField(p.transcript_path) ?? "",
        cwd: stringField(p.cwd) ?? "",
      };

    case "UserPromptSubmit": {
      const { value, truncated } = clamp(stringField(p.prompt) ?? "");
      return {
        kind: "user_prompt",
        prompt: value,
        cwd: stringField(p.cwd) ?? "",
        ...(truncated ? { truncated: true } : {}),
      };
    }

    case "Stop":
    case "SubagentStop": {
      const { value, truncated } = clamp(
        stringField(p.last_assistant_message) ?? "",
      );
      return {
        kind: "assistant_message",
        text: value,
        stop_reason: stringField(p.stop_reason) ?? "",
        ...(truncated ? { truncated: true } : {}),
      };
    }

    case "PreToolUse": {
      const { value: inputJson, truncated } = clampJson(p.tool_input);
      return {
        kind: "tool_call",
        tool_use_id: stringField(p.tool_use_id) ?? "",
        tool_name: stringField(p.tool_name) ?? "",
        input: inputJson,
        ...(truncated ? { truncated: true } : {}),
      };
    }

    case "PostToolUse": {
      const { value: responseJson, truncated } = clampJson(p.tool_response);
      return {
        kind: "tool_result",
        tool_use_id: stringField(p.tool_use_id) ?? "",
        tool_name: stringField(p.tool_name) ?? "",
        response: responseJson,
        ...(truncated ? { truncated: true } : {}),
      };
    }

    case "Notification": {
      const { value } = clamp(stringField(p.message) ?? "");
      return { kind: "notification", text: value };
    }

    case "PreCompact":
    case "PostCompact": {
      const phase: "pre" | "post" = hook === "PreCompact" ? "pre" : "post";
      return {
        kind: "compact",
        phase,
        ...(stringField(p.summary)
          ? { summary: stringField(p.summary) as string }
          : {}),
      };
    }

    default:
      return null;
  }
}

function coerceSource(s: unknown): MirrorSessionSource {
  switch (s) {
    case "startup":
    case "resume":
    case "clear":
    case "compact":
      return s;
    default:
      return "startup";
  }
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function clamp(s: string): { value: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= MAX_STRING_FIELD_BYTES) {
    return { value: s, truncated: false };
  }
  // UTF-8 safe truncation: iterate back from the byte limit until we land on
  // a character boundary by re-decoding.
  const buf = Buffer.from(s, "utf8").subarray(0, MAX_STRING_FIELD_BYTES);
  return { value: buf.toString("utf8"), truncated: true };
}

function clampJson(v: unknown): { value: unknown; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    return { value: "[unserializable]", truncated: true };
  }
  if (json.length <= MAX_STRING_FIELD_BYTES) {
    return { value: v, truncated: false };
  }
  return {
    value: `${json.slice(0, MAX_STRING_FIELD_BYTES)}…(truncated)`,
    truncated: true,
  };
}
