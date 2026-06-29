# AskUserQuestion TUI keystroke protocol

How the mirror-agent answers a Claude Code `AskUserQuestion` modal by
driving the terminal via `tmux send-keys`. Verified empirically against
Claude Code **v2.1.178** (spike, 2026-06-16). Implemented in
`src/mirror-agent/answer-choreography.ts`.

## Modal shape

`AskUserQuestion` renders a tabbed form. For N questions there are N
question tabs plus a Submit tab (the tab row only appears for N ≥ 2):

```
←  ☐ Fruit  ☐ Color  ✔ Submit  →     ☐ = unanswered, ☒ = answered

Pick a fruit

❯ 1. Apple
     A crisp, sweet-tart fruit.
  2. Banana
  3. Cherry
  4. Type something.        ← free-text row, always at (optionCount + 1)
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```

Options are numbered `1..K`; the free-text ("Type something") row is at
`K+1`, and "Chat about this" at `K+2`.

## Keystrokes

| Action | Keys | Effect |
| --- | --- | --- |
| Select listed option *j* | digit `j` | Selects **and auto-advances** to the next unanswered question. Digit selection is absolute — no arrow navigation needed. |
| Free-text answer | digit `K+1`, then literal text, then `Enter` | The digit enters edit mode; the text replaces the row; `Enter` commits and advances. |
| Submit (multi-question) | digit `1` on the Submit/review tab | Submits all answers. |
| Cancel | `Esc` | Cancels the whole modal. |

### Single- vs multi-question

- **Single question**: the final selection (an option digit, or free-text
  `Enter`) **submits immediately** — there is no Submit tab.
- **Multi-question**: after every question is answered the modal lands on
  the "Submit answers" review tab; pressing `1` submits.

The choreography handles both by capturing the pane after the last answer
and only pressing the Submit digit if `Submit answers` is actually showing.

## Reliability notes

- A pane capture **before** the first keystroke confirms a modal is open
  (`Enter to select` or `☐/☒` markers) so a stale/duplicate request can't
  fire digits into the prompt.
- A fixed delay between keystrokes lets the modal redraw/advance so a digit
  can't land on the wrong question tab.
- Digit keys only address rows `1-9`; questions with >9 listed options
  cannot be selected by digit (rare for `AskUserQuestion`). Such answers
  are dropped during validation rather than mis-fired.
- `multiSelect` questions are **not** supported by this keystroke path
  (the dashboard renders them as single-select). Multi-select would need a
  distinct toggle/confirm sequence.

## Flow

```
dashboard form  →  POST /api/mirror/:sid/answer  →  hub relayAnswer
  →  MirrorAnswerFrame over WS  →  mirror-agent handleAnswer
  →  runAnswerChoreography (tmux send-keys)  →  AskUserQuestion tool_result
  →  dashboard marks the question card "answered"
```

Nothing reaches the session until the user clicks **Submit answers** in the
dashboard; selections are held client-side and freely changeable until then.
The `Notification` hook that `AskUserQuestion` fires ("waiting for input")
is suppressed from the permission banner while the modal is open, so a
selection prompt is never shown as "Claude needs your permission".
