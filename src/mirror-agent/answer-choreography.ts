// Drives Claude Code's AskUserQuestion modal to an answer via tmux
// keystrokes. The modal has several variants (verified against CC v2.1.181):
//
//   - Single-select: options numbered 1..K with a free-text ("Type
//     something") row at K+1. Pressing a listed option's digit selects it
//     AND auto-advances to the next question; the free-text row enters edit
//     mode, so we type the answer and press Enter to commit and advance.
//   - multiSelect: options render as `[ ]` checkboxes; a digit TOGGLES its
//     row without advancing. A `←  ☐ H  ✔ Submit  →` tab bar sits on top;
//     to submit you navigate Right to the review tab ("Submit answers",
//     digit 1). Previews/notes are not shown in this variant.
//   - Preview (single-select, options carry a `preview`): a side-by-side
//     layout that additionally exposes `n to add notes`. Press `n`, type the
//     note, then Escape to keep it and return to navigation — a following
//     option selection submits option+note. Pressing Enter instead of Escape
//     (with no option) submits the note alone as "(notes only)".
//   - Once every question is answered a multi-question modal lands on the
//     "Submit answers" review tab (digit 1 submits); a single-question
//     single-select modal has already submitted on its final keystroke.
//
// Each answer item drives one question (in order); its shape selects the
// variant (see MirrorAnswerItem). This logic is extracted from the daemon so
// it can be unit-tested with a mock keystroke sender independent of tmux.

import type { MirrorAnswerItem } from "@/shared/types";

/** The slice of TmuxInjector this choreography needs. TmuxInjector
 *  satisfies it structurally. */
export interface KeySender {
  sendKey(pane: string, key: string): Promise<{ ok: boolean; error?: string }>;
  sendText(
    pane: string,
    text: string,
  ): Promise<{ ok: boolean; error?: string }>;
  capturePane(
    pane: string,
    lines: number,
  ): Promise<{ ok: true; output: string } | { ok: false; error: string }>;
}

export interface AnswerChoreographyOptions {
  /** Pause between keystrokes so the modal can redraw/advance. */
  sleep: (ms: number) => Promise<void>;
  /** Override the inter-step delay (ms). */
  stepDelayMs?: number;
}

export type AnswerResult =
  | { ok: true; submitted: boolean }
  | { ok: false; error: string };

const DEFAULT_STEP_DELAY_MS = 500;

/** Cheap heuristic that an AskUserQuestion modal is currently drawn:
 *  the select hint, or the ☐/☒ question-tab markers (multi-question). */
export function looksLikeQuestionModal(paneText: string): boolean {
  return /Enter to select/i.test(paneText) || /[☐☒]/.test(paneText);
}

export async function runAnswerChoreography(
  inj: KeySender,
  pane: string,
  answers: MirrorAnswerItem[],
  opts: AnswerChoreographyOptions,
): Promise<AnswerResult> {
  if (answers.length === 0) {
    return { ok: false, error: "no valid answers in request" };
  }
  const delay = opts.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;

  const start = await inj.capturePane(pane, 40);
  if (!start.ok) return { ok: false, error: start.error };
  if (!looksLikeQuestionModal(start.output)) {
    return {
      ok: false,
      error:
        "no AskUserQuestion modal is open (it may already have been answered)",
    };
  }

  // Preview questions (options carry a `preview`) expose `n to add notes`
  // and, unlike a plain single-select, do NOT auto-submit when an option
  // digit is pressed — the digit only highlights, so a confirming Enter is
  // needed. Detect that mode once from the live modal.
  const isPreview = /to add notes/i.test(start.output);

  // Notes are only offered on preview questions; bail early if the live
  // modal has no `n to add notes` affordance so we don't type a note as a
  // stray keystroke.
  const wantsNote = answers.some(
    (a) => typeof a.note === "string" && a.note.length > 0,
  );
  if (wantsNote && !isPreview) {
    return {
      ok: false,
      error: "this question does not support notes (no 'add notes' affordance)",
    };
  }

  for (const [i, a] of answers.entries()) {
    const isLast = i === answers.length - 1;
    const note =
      typeof a.note === "string" && a.note.length > 0 ? a.note : null;
    const isMulti = a.multi === true || Array.isArray(a.digits);
    const hasSelection = isMulti
      ? (a.digits ?? []).length > 0 || typeof a.text === "string"
      : typeof a.digit === "number";

    // Notes (single-select preview only). Enter the note first: press n,
    // type, then either Escape (keep the note and return to navigation so
    // the option selection below submits option+note) or, with no option,
    // Enter (submits as "(notes only)").
    if (note !== null) {
      const open = await inj.sendKey(pane, "n");
      if (!open.ok) {
        return {
          ok: false,
          error: `question ${i + 1} note open: ${open.error}`,
        };
      }
      await opts.sleep(delay);
      const typed = await inj.sendText(pane, note);
      if (!typed.ok) {
        return {
          ok: false,
          error: `question ${i + 1} note text: ${typed.error}`,
        };
      }
      await opts.sleep(delay);
      const exit = await inj.sendKey(pane, hasSelection ? "Escape" : "Enter");
      if (!exit.ok) {
        return {
          ok: false,
          error: `question ${i + 1} note commit: ${exit.error}`,
        };
      }
      await opts.sleep(delay);
      if (!hasSelection) continue; // notes-only → submitted
    }

    // multiSelect: toggle each row (no auto-advance), then step Right to the
    // next question tab if more questions remain.
    if (a.multi === true || Array.isArray(a.digits)) {
      for (const d of a.digits ?? []) {
        const tog = await inj.sendKey(pane, String(d));
        if (!tog.ok) {
          return {
            ok: false,
            error: `question ${i + 1} toggle ${d}: ${tog.error}`,
          };
        }
        await opts.sleep(delay);
      }
      if (!isLast) {
        const adv = await inj.sendKey(pane, "Right");
        if (!adv.ok) {
          return {
            ok: false,
            error: `question ${i + 1} advance: ${adv.error}`,
          };
        }
        await opts.sleep(delay);
      }
      continue;
    }

    // Single-select option (auto-advances) or free-text row (digit enters
    // edit mode; type + Enter to commit and advance).
    if (typeof a.digit === "number") {
      const sel = await inj.sendKey(pane, String(a.digit));
      if (!sel.ok) {
        return { ok: false, error: `question ${i + 1}: ${sel.error}` };
      }
      if (typeof a.text === "string") {
        await opts.sleep(delay);
        const typed = await inj.sendText(pane, a.text);
        if (!typed.ok) {
          return {
            ok: false,
            error: `question ${i + 1} custom text: ${typed.error}`,
          };
        }
        await opts.sleep(delay);
        const commit = await inj.sendKey(pane, "Enter");
        if (!commit.ok) {
          return {
            ok: false,
            error: `question ${i + 1} commit: ${commit.error}`,
          };
        }
      } else if (isPreview) {
        // Preview questions don't auto-submit on the digit (it only
        // highlights), whether or not a note was added — confirm with Enter.
        await opts.sleep(delay);
        const commit = await inj.sendKey(pane, "Enter");
        if (!commit.ok) {
          return {
            ok: false,
            error: `question ${i + 1} confirm: ${commit.error}`,
          };
        }
      }
      await opts.sleep(delay);
    }
  }

  // Reach the review tab and submit. Single-question single-select modals
  // have already submitted (no review tab); multiSelect/multi-question modals
  // land on, or need Right-navigation to, a "Submit answers" review tab.
  const maxNav = answers.length + 2;
  for (let n = 0; n <= maxNav; n++) {
    const cap = await inj.capturePane(pane, 40);
    if (!cap.ok) return { ok: false, error: cap.error };
    if (/Submit answers/i.test(cap.output)) {
      const submit = await inj.sendKey(pane, "1");
      if (!submit.ok)
        return { ok: false, error: `submit step: ${submit.error}` };
      return { ok: true, submitted: true };
    }
    // Still on a question/Submit tab bar → navigate Right toward review.
    if (/✔\s*Submit/.test(cap.output) || /[☐☒]/.test(cap.output)) {
      const adv = await inj.sendKey(pane, "Right");
      if (!adv.ok) return { ok: false, error: `submit nav: ${adv.error}` };
      await opts.sleep(delay);
      continue;
    }
    // No review tab and no question tabs → already submitted.
    break;
  }
  return { ok: true, submitted: false };
}
