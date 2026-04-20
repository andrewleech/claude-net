import { describe, expect, test } from "bun:test";
import { ConsentManager } from "@/mirror-agent/consent";

describe("ConsentManager", () => {
  test("defaultMode 'always' allows without prompting", async () => {
    const c = new ConsentManager({ defaultMode: "always" });
    const r = await c.check("sid", null, "watcher");
    expect(r.ok).toBe(true);
  });

  test("defaultMode 'never' rejects without prompting", async () => {
    const c = new ConsentManager({ defaultMode: "never" });
    const r = await c.check("sid", "%0", "watcher");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rejected");
  });

  test("'ask-first-per-session' without pane returns unavailable", async () => {
    const c = new ConsentManager();
    const r = await c.check("sid", null, "w");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unavailable");
  });

  test("setMode('always') short-circuits future checks", async () => {
    const c = new ConsentManager();
    c.setMode("sid", "always");
    const r = await c.check("sid", null, "w");
    expect(r.ok).toBe(true);
    expect(c.describe("sid").mode).toBe("always");
    expect(c.describe("sid").accepted).toBe(true);
  });

  test("reset clears accepted state", () => {
    const c = new ConsentManager();
    c.setMode("sid", "always");
    c.reset("sid");
    expect(c.describe("sid").accepted).toBe(false);
  });

  test("forget removes the session record", () => {
    const c = new ConsentManager();
    c.setMode("sid", "never");
    c.forget("sid");
    expect(c.describe("sid").accepted).toBe(false);
    // default mode again after forget
    expect(c.describe("sid").mode).toBe("ask-first-per-session");
  });
});
