import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractAskPreamble } from "@/mirror-agent/ask-preamble";

const FIXTURES = join(import.meta.dir, "fixtures", "ask-preamble");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
}

describe("extractAskPreamble", () => {
  test("short single-paragraph preamble (with a blank-line break)", () => {
    expect(extractAskPreamble(fixture("short"))).toBe(
      "I'll do that now.\n\nHere are two options for you to pick from.",
    );
  });

  test("long multi-paragraph preamble — wrapped lines rejoin per paragraph", () => {
    const out = extractAskPreamble(fixture("long"));
    expect(out).not.toBeNull();
    const paras = (out as string).split("\n\n");
    expect(paras).toHaveLength(3);
    // Wrapped lines are joined with spaces, not preserved as breaks.
    expect(paras[0]).toBe(
      "When you're weighing how to tackle a piece of work, the trade-off " +
        "almost always comes down to how much time you're willing to spend " +
        "up front versus how much risk you're comfortable carrying forward. " +
        "I want to surface that choice explicitly rather than guess at it, " +
        "because the right answer depends entirely on your appetite for " +
        "speed against your appetite for caution.",
    );
    expect(paras[2]).toContain("The second path moves more deliberately");
    expect(out).not.toContain("\n\n\n");
    // Distractor `●` blocks higher in the scrollback must not leak in.
    expect(out).not.toContain("I'll do that now");
    expect(out).not.toContain("User declined");
  });

  test("markdown preamble — bullet list kept on its own lines", () => {
    expect(extractAskPreamble(fixture("markdown"))).toBe(
      "Here's what I'm deciding:\n\n" +
        "- A — the first option\n" +
        "- B — the second option",
    );
  });

  test("no preamble — user prompt sits directly above the modal", () => {
    // Even though earlier turns left `●` blocks in the scrollback, the
    // block directly above the rule is the user prompt → null.
    expect(extractAskPreamble(fixture("none"))).toBeNull();
  });

  test("returns null when no modal footer is present", () => {
    expect(extractAskPreamble("● just some text\n\nno modal here")).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(extractAskPreamble("")).toBeNull();
  });
});
