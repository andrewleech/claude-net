/**
 * Extract the assistant preamble that Claude Code renders above an open
 * AskUserQuestion modal in the tmux pane.
 *
 * Claude Code does not flush the assistant turn's text/tool_use records to
 * the JSONL transcript until the blocking tool resolves, so while the modal
 * is open the only place the preamble exists is the rendered pane. This
 * parser pulls it out so the mirror can show it above the question card.
 *
 * The pane (from `tmux capture-pane -p`, ANSI stripped) looks like:
 *
 *     ❯ <the user prompt that triggered the turn>
 *
 *     ● <preamble first line, hard-wrapped to terminal width>
 *       <wrapped continuation, indented 2 spaces>
 *
 *       <a second paragraph, blank-line separated>
 *     ──────────────────────────  ← modal top rule
 *      ☐ Header                    ← tab row
 *
 *     Which?                       ← question
 *
 *     ❯ 1. Option                  ← options
 *     ──────────────────────────
 *       N. Chat about this
 *
 *     Enter to select · ↑/↓ to navigate · Esc to cancel  ← footer
 *
 * Strategy: anchor on the footer (confirms a live modal), find the tab row,
 * then the modal top rule directly above it. The preamble is the last
 * assistant bullet (`●`) block immediately above that rule. Walking upward
 * from the rule, the FIRST marker we hit decides it: `●` → preamble; a user
 * prompt (`❯`), tool result (`⎿`), another rule, or box-drawing border →
 * no preamble (return null). Conservative by design: a wrong grab is worse
 * than a missing one, so anything ambiguous yields null.
 */

// Assistant message bullet (with the trailing space CC always renders).
const ASSISTANT_MARKER = /^\s*[●⏺] /;
// User prompt line.
const USER_MARKER = /^\s*❯/;
// Tool-result tree connector.
const TOOL_RESULT_MARKER = /^\s*⎿/;
// AskUserQuestion footer — the live-modal anchor.
const FOOTER_RE = /Enter to select.*Esc to cancel/;
// Header tab row (☐ unselected / ☒ selected) at the top of the modal.
const TAB_ROW_RE = /^\s*[☐☒]\s+\S/;
// Box-drawing border (welcome box, etc.) — never part of a prose preamble.
const BOX_RE = /[│┃╭╮╰╯┌┐└┘├┤┬┴┼]/;
// A markdown block-start: bullet, ordered item, heading, quote, fence,
// table row, or horizontal rule. These keep their own line in the
// reassembled text instead of being joined into the surrounding prose.
const BLOCK_START_RE =
  /^(?:[-*+] |\d+[.)] |#{1,6} |> |```|~~~|\||[-*_]{3,}\s*$)/;

// A full-width box rule is a run of ─ on its own (no box-corner chars).
function isRule(line: string): boolean {
  return /^─{10,}$/.test(line.trim());
}

/**
 * Pull the assistant preamble out of a captured AskUserQuestion pane.
 * Returns the reassembled markdown text, or null when no preamble is
 * confidently present (no modal drawn yet, or the modal has no preceding
 * assistant text).
 */
export function extractAskPreamble(paneText: string): string | null {
  const lines = paneText.split("\n").map((l) => l.replace(/\r$/, ""));

  // 1. Footer (last occurrence = the live modal).
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i] ?? "")) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return null;

  // 2. Tab row, searching up from the footer.
  let tabIdx = -1;
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (TAB_ROW_RE.test(lines[i] ?? "")) {
      tabIdx = i;
      break;
    }
  }
  if (tabIdx < 0) return null;

  // 3. Modal top rule, directly above the tab row.
  let ruleIdx = -1;
  for (let i = tabIdx - 1; i >= 0; i--) {
    if (isRule(lines[i] ?? "")) {
      ruleIdx = i;
      break;
    }
  }
  if (ruleIdx < 0) return null;

  // 4. Walk up from the rule collecting the preamble block. Stop at the
  //    assistant bullet (success) or bail on any non-preamble boundary.
  const block: string[] = [];
  let foundStart = false;
  for (let i = ruleIdx - 1, guard = 0; i >= 0 && guard < 80; i--, guard++) {
    const line = lines[i] ?? "";
    if (ASSISTANT_MARKER.test(line)) {
      block.unshift(line);
      foundStart = true;
      break;
    }
    if (
      USER_MARKER.test(line) ||
      TOOL_RESULT_MARKER.test(line) ||
      isRule(line) ||
      BOX_RE.test(line)
    ) {
      return null;
    }
    block.unshift(line);
  }
  if (!foundStart) return null;

  // 5. De-indent (drop the "● "/2-space body indent) and reassemble:
  //    un-wrap prose into one line per paragraph, but keep markdown
  //    block-starts on their own line. CC's renderer uses breaks:true, so
  //    joining wrapped prose with spaces avoids stray line breaks while
  //    bullet/heading lines stay intact.
  const deindented = block.map((line, idx) =>
    idx === 0 ? line.replace(/^\s*[●⏺] ?/, "") : line.replace(/^ {0,2}/, ""),
  );

  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) {
      out.push(cur);
      cur = "";
    }
  };
  for (const line of deindented) {
    if (line.trim() === "") {
      flush();
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (BLOCK_START_RE.test(line)) {
      flush();
      out.push(line.trimEnd());
      continue;
    }
    cur = cur ? `${cur} ${line.trim()}` : line.trim();
  }
  flush();
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();

  const text = out.join("\n");
  return text.trim() ? text : null;
}
