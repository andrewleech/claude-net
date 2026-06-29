import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type KeySender,
  looksLikeQuestionModal,
  runAnswerChoreography,
} from "@/mirror-agent/answer-choreography";

const FIXTURES = join(import.meta.dir, "fixtures", "answer");
const fx = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.txt`), "utf8");

// A mock KeySender that records every key/text sent and returns scripted
// capturePane outputs in order (start snapshot, then the post-loop review
// snapshot). `failOn` forces a sendKey/sendText to fail for error-path tests.
function mockSender(
  captures: string[],
  failOn?: { kind: "key" | "text"; value: string },
) {
  const calls: Array<{ kind: "key" | "text"; value: string }> = [];
  let capIdx = 0;
  const sender: KeySender = {
    async sendKey(_pane, key) {
      calls.push({ kind: "key", value: key });
      if (failOn?.kind === "key" && failOn.value === key)
        return { ok: false, error: "boom" };
      return { ok: true };
    },
    async sendText(_pane, text) {
      calls.push({ kind: "text", value: text });
      if (failOn?.kind === "text" && failOn.value === text)
        return { ok: false, error: "boom" };
      return { ok: true };
    },
    async capturePane(_pane, _lines) {
      const out = captures[capIdx] ?? "";
      capIdx++;
      return { ok: true, output: out };
    },
  };
  return { sender, calls };
}

const MODAL = "Pick a fruit\n1. Apple\n2. Banana\nEnter to select";
const REVIEW = "Review your answers\n1. Submit answers\n2. Cancel";
const NOT_MODAL = "❯ \n  ⏵⏵ bypass permissions on";
const noSleep = { sleep: async () => {}, stepDelayMs: 0 };

describe("looksLikeQuestionModal", () => {
  test("matches the select hint", () => {
    expect(looksLikeQuestionModal(MODAL)).toBe(true);
  });
  test("matches the ☐/☒ tab markers", () => {
    expect(looksLikeQuestionModal("←  ☒ City  ☐ Food  ✔ Submit  →")).toBe(true);
  });
  test("rejects an ordinary prompt", () => {
    expect(looksLikeQuestionModal(NOT_MODAL)).toBe(false);
  });
});

describe("runAnswerChoreography", () => {
  test("single-question option: one digit, no Submit step", async () => {
    // Post-loop capture has no review tab → single-question auto-submit.
    const { sender, calls } = mockSender([MODAL, NOT_MODAL]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ digit: 1 }],
      noSleep,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submitted).toBe(false);
    expect(calls).toEqual([{ kind: "key", value: "1" }]);
  });

  test("multi-question options: each digit then Submit", async () => {
    const { sender, calls } = mockSender([MODAL, REVIEW]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ digit: 2 }, { digit: 1 }],
      noSleep,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submitted).toBe(true);
    expect(calls).toEqual([
      { kind: "key", value: "2" },
      { kind: "key", value: "1" },
      { kind: "key", value: "1" }, // Submit answers
    ]);
  });

  test("free-text: digit, literal text, Enter", async () => {
    const { sender, calls } = mockSender([MODAL, NOT_MODAL]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ digit: 3, text: "Berlin" }],
      noSleep,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      { kind: "key", value: "3" },
      { kind: "text", value: "Berlin" },
      { kind: "key", value: "Enter" },
    ]);
  });

  test("rejects when no modal is open", async () => {
    const { sender, calls } = mockSender([NOT_MODAL]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ digit: 1 }],
      noSleep,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no AskUserQuestion modal");
    // No keystrokes sent into a non-modal pane.
    expect(calls).toHaveLength(0);
  });

  test("rejects an empty answer set", async () => {
    const { sender } = mockSender([MODAL]);
    const r = await runAnswerChoreography(sender, "%0", [], noSleep);
    expect(r.ok).toBe(false);
  });

  test("multiSelect: toggle each row, Right to review, then Submit", async () => {
    // start = toggled question tab; nav#1 = same (no review yet) → Right;
    // nav#2 = review tab → press 1.
    const { sender, calls } = mockSender([
      fx("multiselect-toggled"),
      fx("multiselect-toggled"),
      fx("multiselect-review"),
    ]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ multi: true, digits: [1, 3] }],
      noSleep,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submitted).toBe(true);
    expect(calls).toEqual([
      { kind: "key", value: "1" },
      { kind: "key", value: "3" },
      { kind: "key", value: "Right" }, // navigate to review tab
      { kind: "key", value: "1" }, // Submit answers
    ]);
  });

  test("notes-only: press n, type, Enter (submits as notes only)", async () => {
    const { sender, calls } = mockSender([
      fx("single-preview-notes"),
      NOT_MODAL,
    ]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ note: "looks good to me" }],
      noSleep,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submitted).toBe(false);
    expect(calls).toEqual([
      { kind: "key", value: "n" },
      { kind: "text", value: "looks good to me" },
      { kind: "key", value: "Enter" },
    ]);
  });

  test("preview option, no note: digit only highlights, Enter confirms", async () => {
    // A preview modal (has `n to add notes`) doesn't auto-submit on the
    // digit, so a confirming Enter is required even without a note.
    const { sender, calls } = mockSender([
      fx("single-preview-notes"),
      NOT_MODAL,
    ]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ digit: 2 }],
      noSleep,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toEqual([
      { kind: "key", value: "2" },
      { kind: "key", value: "Enter" },
    ]);
  });

  test("option + note: n, type, Escape, then select the option", async () => {
    const { sender, calls } = mockSender([
      fx("single-preview-notes"),
      NOT_MODAL,
    ]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ digit: 1, note: "prefer this one" }],
      noSleep,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submitted).toBe(false);
    expect(calls).toEqual([
      { kind: "key", value: "n" },
      { kind: "text", value: "prefer this one" },
      { kind: "key", value: "Escape" }, // keep the note, return to navigation
      { kind: "key", value: "1" }, // highlight the option (does not submit)
      { kind: "key", value: "Enter" }, // confirm + submit with the note
    ]);
  });

  test("rejects a note when the modal has no notes affordance", async () => {
    // MODAL is a plain question with no `n to add notes` hint.
    const { sender, calls } = mockSender([MODAL]);
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ note: "x" }],
      noSleep,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("does not support notes");
    expect(calls).toHaveLength(0);
  });

  test("surfaces a sendKey failure and stops", async () => {
    const { sender, calls } = mockSender([MODAL, REVIEW], {
      kind: "key",
      value: "2",
    });
    const r = await runAnswerChoreography(
      sender,
      "%0",
      [{ digit: 2 }, { digit: 1 }],
      noSleep,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("question 1");
    // Stopped after the failing keystroke — never reached question 2.
    expect(calls).toEqual([{ kind: "key", value: "2" }]);
  });
});
