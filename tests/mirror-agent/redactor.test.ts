import { describe, expect, test } from "bun:test";
import { Redactor } from "@/mirror-agent/redactor";
import type {
  MirrorAssistantMessagePayload,
  MirrorEventFrame,
  MirrorToolResultPayload,
  MirrorUserPromptPayload,
} from "@/shared/types";

function userPromptFrame(prompt: string): MirrorEventFrame {
  return {
    action: "mirror_event",
    sid: "s-1",
    uuid: "u-1",
    kind: "user_prompt",
    ts: 0,
    payload: { kind: "user_prompt", prompt, cwd: "/tmp" },
  };
}

function toolResultFrame(response: unknown): MirrorEventFrame {
  return {
    action: "mirror_event",
    sid: "s-1",
    uuid: "u-2",
    kind: "tool_result",
    ts: 0,
    payload: {
      kind: "tool_result",
      tool_use_id: "t-1",
      tool_name: "Bash",
      response,
    },
  };
}

describe("Redactor", () => {
  test("redacts default AWS access key format", () => {
    const r = new Redactor();
    const frame = userPromptFrame(
      "here's a key AKIAIOSFODNN7EXAMPLE use carefully",
    );
    r.redactFrame(frame);
    const p = frame.payload as MirrorUserPromptPayload;
    expect(p.prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(p.prompt).toContain("«REDACTED:aws-access-key»");
    expect(r.stats["aws-access-key"]).toBe(1);
  });

  test("redacts Anthropic key", () => {
    const r = new Redactor();
    const frame = userPromptFrame("token sk-ant-abc123DEF456ghi789JKL");
    r.redactFrame(frame);
    const p = frame.payload as MirrorUserPromptPayload;
    expect(p.prompt).toContain("«REDACTED:anthropic-key»");
  });

  test("redacts nested strings inside tool_result response", () => {
    const r = new Redactor();
    const frame = toolResultFrame({
      stdout:
        "export AWS_KEY=AKIAIOSFODNN7EXAMPLE\nsk-ant-xxxxxxxxxxxxxxxxxxxx",
      code: 0,
    });
    r.redactFrame(frame);
    const p = frame.payload as MirrorToolResultPayload;
    const stdout = (p.response as { stdout: string }).stdout;
    expect(stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(stdout).toContain("«REDACTED:aws-access-key»");
    expect(stdout).toContain("«REDACTED:anthropic-key»");
  });

  test("leaves harmless strings alone", () => {
    const r = new Redactor();
    const frame = userPromptFrame("Just documentation about AWS and sk- stuff");
    r.redactFrame(frame);
    const p = frame.payload as MirrorUserPromptPayload;
    expect(p.prompt).toBe("Just documentation about AWS and sk- stuff");
  });

  test("custom rule overrides default replacement", () => {
    const r = new Redactor({
      rules: [
        {
          name: "internal-id",
          pattern: "INT-[0-9]+",
          replacement: "[[internal]]",
        },
      ],
    });
    const frame = userPromptFrame("please ship INT-4815");
    r.redactFrame(frame);
    const p = frame.payload as MirrorUserPromptPayload;
    expect(p.prompt).toBe("please ship [[internal]]");
  });

  test("handles assistant_message text", () => {
    const r = new Redactor();
    const frame: MirrorEventFrame = {
      action: "mirror_event",
      sid: "s-1",
      uuid: "u-3",
      kind: "assistant_message",
      ts: 0,
      payload: {
        kind: "assistant_message",
        text: "Here's a JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        stop_reason: "end_turn",
      },
    };
    r.redactFrame(frame);
    const p = frame.payload as MirrorAssistantMessagePayload;
    expect(p.text).toContain("«REDACTED:jwt»");
  });

  test("invalid user regex is skipped with a warning (no crash)", () => {
    const r = new Redactor({
      includeDefaults: false,
      rules: [{ name: "bad", pattern: "([invalid" }],
    });
    expect(r.ruleCount).toBe(0);
  });
});
