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

// Per-image and overall caps for tool_result payloads carrying image
// content blocks. The base clampJson cap above would otherwise collapse
// any structured response with an embedded image into a truncated string
// (PNG base64 expands ~4/3, so a 200KB image already breaches the 256KB
// field cap). We carve out image blocks before the JSON clamp, check
// each against MAX_INLINE_IMAGE_BYTES, and replace over-cap blocks with
// a placeholder so the dashboard can show "image too large" rather than
// nothing. The overall structure is then JSON-clamped against
// MAX_TOOL_RESULT_BYTES so a runaway non-image response still gets
// truncated.
export const MAX_INLINE_IMAGE_BYTES = 512 * 1024;
export const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;

// Whitelisted image media types — must match the dashboard's
// IMAGE_MEDIA_TYPES set in src/hub/dashboard/parsers.js. SVG is excluded
// because it can carry script content; the dashboard renders only the
// allowlisted types via <img src=data:…>.
const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

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
    /** PPID of the hook wrapper — the Claude Code process itself. */
    CC_PID?: number;
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
  ccPid: number | undefined;
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
    ccPid:
      typeof payload._mirror_env?.CC_PID === "number"
        ? payload._mirror_env.CC_PID
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
        ...(hook === "SubagentStop" ? { subagent: true } : {}),
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
      const { value: responseJson, truncated } = clampToolResponse(
        p.tool_response,
      );
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

interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    data: string;
    media_type: string;
  };
}

interface ImagePlaceholder {
  type: "image_placeholder";
  media_type: string;
  bytes: number;
  reason: string;
}

/**
 * Tool-result-specific clamp that preserves image content blocks instead
 * of collapsing them into a truncated JSON string slice. Walks the
 * response shape, replaces over-cap or unsupported image blocks with a
 * structured placeholder, then JSON-clamps the result against
 * MAX_TOOL_RESULT_BYTES. The placeholder shape is recognised by
 * extractImageBlocks in src/hub/dashboard/parsers.js so the dashboard
 * can show "image too large" rather than an empty card.
 *
 * For inputs without any image blocks the behaviour is identical to
 * clampJson with a larger byte budget (2 MB vs 256 KB) — the budget is
 * higher because preserving the structured response is the whole point
 * and image-bearing responses can legitimately exceed the old field cap.
 */
function clampToolResponse(v: unknown): {
  value: unknown;
  truncated: boolean;
} {
  let truncated = false;
  const sanitized = sanitizeImageBlocks(v, (t) => {
    if (t) truncated = true;
  });
  let json: string;
  try {
    json = JSON.stringify(sanitized);
  } catch {
    return { value: "[unserializable]", truncated: true };
  }
  if (json.length <= MAX_TOOL_RESULT_BYTES) {
    return { value: sanitized, truncated };
  }
  return {
    value: `${json.slice(0, MAX_TOOL_RESULT_BYTES)}…(truncated)`,
    truncated: true,
  };
}

/**
 * Recursively walk a value and rewrite image content blocks so that
 *   - allowed media types under MAX_INLINE_IMAGE_BYTES pass through,
 *   - allowed media types over the cap become a placeholder,
 *   - disallowed media types (e.g. image/svg+xml) become a placeholder,
 *   - everything else (text, objects, arrays) passes through unchanged.
 *
 * Reports back through `onTruncate(true)` whenever a placeholder is
 * emitted so the caller can mark the frame truncated.
 */
function sanitizeImageBlocks(
  v: unknown,
  onTruncate: (t: boolean) => void,
  depth = 0,
): unknown {
  if (v == null || depth > 6) return v;
  if (Array.isArray(v)) {
    return v.map((x) => sanitizeImageBlocks(x, onTruncate, depth + 1));
  }
  if (typeof v !== "object") return v;
  const obj = v as Record<string, unknown>;
  if (
    obj.type === "image" &&
    obj.source &&
    typeof obj.source === "object" &&
    obj.source !== null
  ) {
    const src = obj.source as Record<string, unknown>;
    const mt = typeof src.media_type === "string" ? src.media_type : "";
    const data = typeof src.data === "string" ? src.data : "";
    // Approximate decoded byte size: base64 expands by ~4/3.
    const bytes = Math.ceil((data.length * 3) / 4);
    if (!ALLOWED_IMAGE_MEDIA_TYPES.has(mt)) {
      onTruncate(true);
      return {
        type: "image_placeholder",
        media_type: mt,
        bytes,
        reason: "unsupported_media_type",
      } satisfies ImagePlaceholder;
    }
    if (bytes > MAX_INLINE_IMAGE_BYTES) {
      onTruncate(true);
      return {
        type: "image_placeholder",
        media_type: mt,
        bytes,
        reason: "too_large",
      } satisfies ImagePlaceholder;
    }
    return {
      type: "image",
      source: { type: "base64", data, media_type: mt },
    } satisfies ImageBlock;
  }
  // Recurse into envelopes and ordinary objects.
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    out[k] = sanitizeImageBlocks(val, onTruncate, depth + 1);
  }
  return out;
}
