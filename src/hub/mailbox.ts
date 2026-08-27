import type { MailboxEntryData } from "@/shared/types";

// Single-slot mailbox per agent: holds only the most recent message
// addressed to a recipient, not a queue or history.

export type MailboxEntry = MailboxEntryData;

// Bounds the number of distinct recipients tracked, so a long-running hub
// addressing an unbounded stream of session:user@host identities (one per
// Claude Code session) can't grow this map forever. FIFO eviction by
// least-recently-deposited-to recipient, mirroring EventLog's bounded ring.
const DEFAULT_CAPACITY = 5_000;

// Bounds the resident size of a single slot. The mailbox is the only place
// the hub retains a message body verbatim (the event log stores metadata
// only), so without a cap, capacity * max-WS-payload would be the
// worst-case resident set. Truncated content carries a marker so a reader
// knows it isn't the full original.
const MAX_CONTENT_LENGTH = 16_000;
// reply_to is caller-supplied on both the WS (`data.reply_to`) and REST
// (`body.reply_to`) send paths and stored verbatim alongside content — cap
// it too, or the same worst-case-resident-set bound content is capped for
// is trivially bypassed via this field instead.
const MAX_REPLY_TO_LENGTH = 500;
const TRUNCATION_MARKER = "\n…[truncated]";

function capContent(content: string): string {
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return (
    content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

function capReplyTo(replyTo: string | undefined): string | undefined {
  if (replyTo === undefined || replyTo.length <= MAX_REPLY_TO_LENGTH) {
    return replyTo;
  }
  return (
    replyTo.slice(0, MAX_REPLY_TO_LENGTH - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

export class Mailbox {
  private entries = new Map<string, MailboxEntry>();
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  deposit(entry: MailboxEntry): void {
    // Copy rather than store the caller's object by reference — the
    // caller (or a `get()` from earlier) may still hold and mutate it.
    // Delete-then-set moves the key to the end of the Map's iteration
    // order, so the eviction below drops the least-recently-deposited-to
    // recipient rather than whichever happened to be inserted first.
    const stored: MailboxEntry = {
      ...entry,
      content: capContent(entry.content),
      reply_to: capReplyTo(entry.reply_to),
    };
    this.entries.delete(stored.to);
    this.entries.set(stored.to, stored);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(fullName: string): MailboxEntry | null {
    const entry = this.entries.get(fullName);
    // Copy out — the caller must not be able to mutate the store's
    // internal state (e.g. flip read_at) through the returned object.
    return entry ? { ...entry } : null;
  }

  markRead(fullName: string): void {
    const entry = this.entries.get(fullName);
    if (entry && entry.read_at === null) {
      entry.read_at = new Date().toISOString();
    }
  }

  /**
   * Move a recipient's slot to follow a rename, so a `/rename` doesn't
   * strand a just-deposited message under the dead name. No-op if there
   * is nothing deposited under `oldName`. If `newName` already holds an
   * entry that is the same age or newer, that one wins — a rename must
   * not resurrect a message older than what's already in the
   * destination slot, consistent with the single-slot "last message
   * wins" design.
   */
  rekey(oldName: string, newName: string): void {
    const oldEntry = this.entries.get(oldName);
    if (!oldEntry) return;
    this.entries.delete(oldName);
    const existing = this.entries.get(newName);
    if (existing && existing.sent_at >= oldEntry.sent_at) return;
    this.entries.delete(newName);
    this.entries.set(newName, { ...oldEntry, to: newName });
  }
}
