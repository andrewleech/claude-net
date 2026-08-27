import { describe, expect, test } from "bun:test";
import { Mailbox, type MailboxEntry } from "@/hub/mailbox";

function makeEntry(overrides: Partial<MailboxEntry> = {}): MailboxEntry {
  return {
    message_id: "msg-1",
    from: "proj:alice@host",
    to: "proj:bob@host",
    type: "message",
    content: "hello",
    outcome: "delivered",
    sent_at: new Date().toISOString(),
    read_at: null,
    ...overrides,
  };
}

describe("Mailbox", () => {
  test("get() on a missing key returns null", () => {
    const mailbox = new Mailbox();
    expect(mailbox.get("proj:nobody@host")).toBeNull();
  });

  test("deposit stores an entry retrievable by its `to` field", () => {
    const mailbox = new Mailbox();
    const entry = makeEntry();
    mailbox.deposit(entry);
    expect(mailbox.get("proj:bob@host")).toEqual(entry);
  });

  test("a second deposit for the same recipient overwrites the first", () => {
    const mailbox = new Mailbox();
    mailbox.deposit(makeEntry({ message_id: "msg-1", content: "first" }));
    mailbox.deposit(makeEntry({ message_id: "msg-2", content: "second" }));

    const entry = mailbox.get("proj:bob@host");
    expect(entry?.message_id).toBe("msg-2");
    expect(entry?.content).toBe("second");
  });

  test("markRead sets read_at on an unread entry", () => {
    const mailbox = new Mailbox();
    mailbox.deposit(makeEntry());
    mailbox.markRead("proj:bob@host");
    expect(mailbox.get("proj:bob@host")?.read_at).not.toBeNull();
  });

  test("markRead is idempotent — a second call doesn't change an already-set read_at", () => {
    const mailbox = new Mailbox();
    mailbox.deposit(makeEntry());
    mailbox.markRead("proj:bob@host");
    const firstReadAt = mailbox.get("proj:bob@host")?.read_at;

    mailbox.markRead("proj:bob@host");
    expect(mailbox.get("proj:bob@host")?.read_at).toBe(firstReadAt);
  });

  test("markRead on a missing key is a no-op", () => {
    const mailbox = new Mailbox();
    expect(() => mailbox.markRead("proj:nobody@host")).not.toThrow();
    expect(mailbox.get("proj:nobody@host")).toBeNull();
  });

  describe("rekey", () => {
    test("moves an entry to the new name and updates its `to` field", () => {
      const mailbox = new Mailbox();
      mailbox.deposit(makeEntry({ to: "old:bob@host" }));
      mailbox.rekey("old:bob@host", "new:bob@host");

      expect(mailbox.get("old:bob@host")).toBeNull();
      const entry = mailbox.get("new:bob@host");
      expect(entry?.to).toBe("new:bob@host");
      expect(entry?.content).toBe("hello");
    });

    test("is a no-op when nothing is deposited under the old name", () => {
      const mailbox = new Mailbox();
      expect(() => mailbox.rekey("old:bob@host", "new:bob@host")).not.toThrow();
      expect(mailbox.get("new:bob@host")).toBeNull();
    });

    test("does not resurrect an older message over a newer one already at the destination", () => {
      const mailbox = new Mailbox();
      mailbox.deposit(
        makeEntry({
          to: "old:bob@host",
          content: "OLD-NAME-MSG",
          sent_at: "2026-01-01T00:00:00.000Z",
        }),
      );
      mailbox.deposit(
        makeEntry({
          to: "new:bob@host",
          content: "NEWER-MSG",
          sent_at: "2026-01-01T00:00:05.000Z",
        }),
      );

      mailbox.rekey("old:bob@host", "new:bob@host");

      expect(mailbox.get("new:bob@host")?.content).toBe("NEWER-MSG");
      expect(mailbox.get("old:bob@host")).toBeNull();
    });

    test("moves the entry across when it is newer than what's at the destination", () => {
      const mailbox = new Mailbox();
      mailbox.deposit(
        makeEntry({
          to: "new:bob@host",
          content: "STALE-MSG",
          sent_at: "2026-01-01T00:00:00.000Z",
        }),
      );
      mailbox.deposit(
        makeEntry({
          to: "old:bob@host",
          content: "FRESH-MSG",
          sent_at: "2026-01-01T00:00:05.000Z",
        }),
      );

      mailbox.rekey("old:bob@host", "new:bob@host");

      expect(mailbox.get("new:bob@host")?.content).toBe("FRESH-MSG");
    });
  });

  describe("isolation from caller-held references", () => {
    test("mutating the object passed to deposit() afterward does not change the stored entry", () => {
      const mailbox = new Mailbox();
      const entry = makeEntry({ content: "original" });
      mailbox.deposit(entry);
      entry.content = "mutated after deposit";
      expect(mailbox.get("proj:bob@host")?.content).toBe("original");
    });

    test("mutating the object returned by get() does not change the stored entry", () => {
      const mailbox = new Mailbox();
      mailbox.deposit(makeEntry({ content: "original" }));
      const got = mailbox.get("proj:bob@host");
      // biome-ignore lint/style/noNonNullAssertion: just deposited above
      got!.content = "mutated via get() result";
      expect(mailbox.get("proj:bob@host")?.content).toBe("original");
    });
  });

  describe("content length cap", () => {
    test("a content string over the cap is truncated with a marker", () => {
      const mailbox = new Mailbox();
      const huge = "x".repeat(20_000);
      mailbox.deposit(makeEntry({ content: huge }));
      const stored = mailbox.get("proj:bob@host");
      expect(stored?.content.length).toBeLessThan(huge.length);
      expect(stored?.content).toContain("[truncated]");
    });

    test("content at or under the cap is stored verbatim", () => {
      const mailbox = new Mailbox();
      const normal = "hello world";
      mailbox.deposit(makeEntry({ content: normal }));
      expect(mailbox.get("proj:bob@host")?.content).toBe(normal);
    });
  });

  describe("reply_to length cap", () => {
    test("a reply_to string over the cap is truncated with a marker", () => {
      const mailbox = new Mailbox();
      const huge = "y".repeat(2_000_000);
      mailbox.deposit(makeEntry({ content: "tiny", reply_to: huge }));
      const stored = mailbox.get("proj:bob@host");
      expect(stored?.content.length).toBe(4);
      expect(stored?.reply_to?.length).toBeLessThan(huge.length);
      expect(stored?.reply_to).toContain("[truncated]");
    });

    test("reply_to at or under the cap is stored verbatim", () => {
      const mailbox = new Mailbox();
      const normal = "msg-42";
      mailbox.deposit(makeEntry({ reply_to: normal }));
      expect(mailbox.get("proj:bob@host")?.reply_to).toBe(normal);
    });

    test("an entry with no reply_to is unaffected", () => {
      const mailbox = new Mailbox();
      mailbox.deposit(makeEntry());
      expect(mailbox.get("proj:bob@host")?.reply_to).toBeUndefined();
    });
  });

  describe("capacity", () => {
    test("evicts the least-recently-deposited-to recipient once over capacity", () => {
      const mailbox = new Mailbox(2);
      mailbox.deposit(makeEntry({ to: "proj:a@host" }));
      mailbox.deposit(makeEntry({ to: "proj:b@host" }));
      mailbox.deposit(makeEntry({ to: "proj:c@host" }));

      expect(mailbox.get("proj:a@host")).toBeNull();
      expect(mailbox.get("proj:b@host")).not.toBeNull();
      expect(mailbox.get("proj:c@host")).not.toBeNull();
    });

    test("re-depositing to an existing recipient refreshes its recency", () => {
      const mailbox = new Mailbox(2);
      mailbox.deposit(makeEntry({ to: "proj:a@host" }));
      mailbox.deposit(makeEntry({ to: "proj:b@host" }));
      // Touch "a" again so "b" becomes the least-recently-deposited-to.
      mailbox.deposit(makeEntry({ to: "proj:a@host", content: "again" }));
      mailbox.deposit(makeEntry({ to: "proj:c@host" }));

      expect(mailbox.get("proj:b@host")).toBeNull();
      expect(mailbox.get("proj:a@host")?.content).toBe("again");
      expect(mailbox.get("proj:c@host")).not.toBeNull();
    });
  });
});
