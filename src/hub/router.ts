import type {
  InboundMessageFrame,
  MessageType,
  SendNakReason,
} from "@/shared/types";
import { Mailbox, type MailboxEntry } from "./mailbox";
import type { Registry } from "./registry";
import type { Teams } from "./teams";
import {
  DASHBOARD_AGENT_NAME,
  DASHBOARD_SHORT_NAME,
  hasDashboardClients,
  routeToDashboard,
} from "./ws-dashboard";

export type RouteDirectResult =
  | {
      ok: true;
      message_id: string;
      outcome: "delivered";
      to_dashboard?: boolean;
    }
  | {
      ok: false;
      outcome: "nak";
      reason: SendNakReason;
      error: string;
      /** Whether the content was actually recorded to the recipient's mailbox. */
      mailbox: boolean;
    };

export type RouteTeamResult =
  | {
      ok: true;
      message_id: string;
      delivered_to: number;
      skipped_no_channel: number;
      /** Whether any member who didn't get live delivery still got a mailbox deposit. */
      mailbox: boolean;
    }
  | {
      ok: false;
      error: string;
      /** Whether any member still got a mailbox deposit despite the team send failing overall. */
      mailbox: boolean;
    };

export class Router {
  private registry: Registry;
  private teams: Teams;
  readonly mailbox: Mailbox;

  constructor(
    registry: Registry,
    teams: Teams,
    mailbox: Mailbox = new Mailbox(),
  ) {
    this.registry = registry;
    this.teams = teams;
    this.mailbox = mailbox;
  }

  /**
   * `message_id`/`sent_at` are threaded in by the caller rather than
   * minted here, so a mailbox entry correlates with the actual frame (if
   * any) that was sent for this attempt — the sender's returned
   * message_id, the recipient's InboundMessageFrame, and the mailbox
   * snapshot all agree.
   */
  private depositMailbox(
    entry: Omit<MailboxEntry, "message_id" | "sent_at" | "read_at">,
    message_id: string,
    sent_at: string,
  ): void {
    this.mailbox.deposit({
      ...entry,
      message_id,
      sent_at,
      read_at: null,
    });
  }

  /**
   * True when `to`'s mailbox slot holds an unread agent-to-agent message
   * (`from` is a real agent, not the hub's own `system@claude-net`
   * identity) that the recipient hasn't already seen. `outcome ===
   * "delivered"` means it WAS seen — live, at send time — even though
   * nothing ever sets `read_at` on that path (only an explicit
   * get_mailbox poll of one's own name does), so it must not count as
   * "hasn't seen yet" here. Only a nak/skipped deposit (the recipient's
   * one remaining chance to see the content) blocks the overwrite.
   */
  private hasUnreadAgentMessage(to: string): boolean {
    const existing = this.mailbox.get(to);
    return (
      existing !== null &&
      existing.read_at === null &&
      existing.outcome !== "delivered" &&
      existing.from !== "system@claude-net"
    );
  }

  /**
   * Direct send. Returns a structured outcome so ws-plugin can translate
   * NAK reasons into a specific error field for the sender's LLM.
   */
  routeDirect(
    from: string,
    to: string,
    content: string,
    type: MessageType = "message",
    reply_to?: string,
  ): RouteDirectResult {
    // Callers deserialize `content` from untrusted wire input (WS frame,
    // REST body) and only cast it to `string` — validate for real before
    // any resolve/send/deposit runs, so a malformed frame NAKs cleanly
    // instead of throwing out of Mailbox.deposit after a live delivery.
    if (typeof content !== "string") {
      return {
        ok: false,
        outcome: "nak",
        reason: "invalid-content",
        mailbox: false,
        error: "Message content must be a string.",
      };
    }
    if (reply_to !== undefined && typeof reply_to !== "string") {
      return {
        ok: false,
        outcome: "nak",
        reason: "invalid-content",
        mailbox: false,
        error: "Message reply_to must be a string.",
      };
    }

    // Dashboard virtual agent — route by presence of dashboard clients.
    if (to === DASHBOARD_AGENT_NAME || to === DASHBOARD_SHORT_NAME) {
      if (!hasDashboardClients()) {
        return {
          ok: false,
          outcome: "nak",
          reason: "no-dashboard",
          error: "Dashboard is not connected.",
          mailbox: false,
        };
      }
      const message_id = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const frame: InboundMessageFrame = {
        event: "message",
        message_id,
        from,
        to: DASHBOARD_AGENT_NAME,
        type,
        content,
        timestamp,
        ...(reply_to ? { reply_to } : {}),
      };
      routeToDashboard(frame);
      return {
        ok: true,
        message_id,
        outcome: "delivered",
        to_dashboard: true,
      };
    }

    const resolved = this.registry.resolve(to);
    if (!resolved.ok) {
      if (resolved.ambiguous) {
        // Multiple *online* agents match `to` right now — a live naming
        // collision, not an offline recipient. Report it on its own:
        // consulting seenNames here would just repeat the same ambiguity
        // against a differently-shaped (historical) match list, and
        // reason="offline" would push the sender toward "check their
        // mailbox" advice that doesn't apply to a live collision.
        return {
          ok: false,
          outcome: "nak",
          reason: "ambiguous",
          mailbox: false,
          error: `${resolved.error} The message was NOT recorded to any mailbox.`,
        };
      }
      // Not currently online — still deposit if `to` resolves (exactly or
      // via a partial-addressing match) to a fullName the hub has seen
      // registered at some point this lifetime. Gating on `seenNames`
      // rather than `disconnected` means the deposit fires for teamless
      // agents too (disconnected only tracks agents that had joined a
      // team) and keeps working after the 2h disconnect-timeout sweep.
      //
      // resolveSeenNameOrAmbiguous (the same helper get_mailbox uses)
      // distinguishes "no match" from "multiple matches" — an ambiguous
      // partial name must not deposit under a guessed name, and the error
      // text must say "ambiguous", not "not known to the hub".
      const seen = this.registry.resolveSeenNameOrAmbiguous(to);
      if (seen && "error" in seen) {
        return {
          ok: false,
          outcome: "nak",
          reason: "ambiguous",
          mailbox: false,
          error: `${seen.error} The message was NOT recorded to any mailbox.`,
        };
      }
      const canonical = seen ? seen.fullName : null;
      if (canonical) {
        const message_id = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        this.depositMailbox(
          {
            from,
            to: canonical,
            type,
            content,
            reply_to,
            outcome: "nak",
            reason: "offline",
          },
          message_id,
          timestamp,
        );
      }
      return {
        ok: false,
        outcome: "nak",
        reason: "offline",
        mailbox: canonical !== null,
        error: canonical
          ? `${resolved.error} The message was recorded to their mailbox.`
          : `${resolved.error} The message was NOT recorded to any mailbox — this identity is not known to the hub.`,
      };
    }

    if (!resolved.entry.channelCapable) {
      const message_id = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      this.depositMailbox(
        {
          from,
          to: resolved.entry.fullName,
          type,
          content,
          reply_to,
          outcome: "nak",
          reason: "no-channel",
        },
        message_id,
        timestamp,
      );
      return {
        ok: false,
        outcome: "nak",
        reason: "no-channel",
        mailbox: true,
        error: `Recipient '${resolved.entry.fullName}' does not have channels enabled and cannot receive messages. They need to run \`install-channels\` on their host. The message was recorded to their mailbox.`,
      };
    }

    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const frame: InboundMessageFrame = {
      event: "message",
      message_id,
      from,
      to: resolved.entry.fullName,
      type,
      content,
      timestamp,
      ...(reply_to ? { reply_to } : {}),
    };

    try {
      resolved.entry.ws.send(JSON.stringify(frame));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.depositMailbox(
        {
          from,
          to: resolved.entry.fullName,
          type,
          content,
          reply_to,
          outcome: "nak",
          reason: "transport-error",
        },
        message_id,
        timestamp,
      );
      return {
        ok: false,
        outcome: "nak",
        reason: "transport-error",
        mailbox: true,
        error: `Failed to deliver to '${resolved.entry.fullName}': ${message}. The message was recorded to their mailbox.`,
      };
    }
    this.depositMailbox(
      {
        from,
        to: resolved.entry.fullName,
        type,
        content,
        reply_to,
        outcome: "delivered",
      },
      message_id,
      timestamp,
    );
    return { ok: true, message_id, outcome: "delivered" };
  }

  routeTeam(
    from: string,
    team: string,
    content: string,
    type: MessageType = "message",
    reply_to?: string,
  ): RouteTeamResult {
    // Same validation as routeDirect, and for the same reason — but here
    // it also matters for atomicity: without it, a non-string content
    // throws mid-loop (mailbox.deposit) after some members are already
    // live-delivered and before the rest are even reached.
    if (typeof content !== "string") {
      return {
        ok: false,
        error: "Message content must be a string.",
        mailbox: false,
      };
    }
    if (reply_to !== undefined && typeof reply_to !== "string") {
      return {
        ok: false,
        error: "Message reply_to must be a string.",
        mailbox: false,
      };
    }

    const members = this.teams.getMembers(team);
    if (!members) {
      return {
        ok: false,
        error: `Team '${team}' does not exist.`,
        mailbox: false,
      };
    }

    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    let delivered_to = 0;
    let skipped_no_channel = 0;
    // Tracks whether any member still got a mailbox deposit, so the
    // all-failed return path below can report it — mirrors routeDirect's
    // `mailbox` field, matching wording/shape rather than diverging.
    let mailboxDeposited = false;

    const frame: InboundMessageFrame = {
      event: "message",
      message_id,
      from,
      to: `team:${team}`,
      type,
      content,
      team,
      timestamp,
      ...(reply_to ? { reply_to } : {}),
    };
    const serialized = JSON.stringify(frame);

    for (const memberName of members) {
      if (memberName === from) continue;
      const entry = this.registry.getByFullName(memberName);
      if (!entry) {
        // Team members are already canonical fullNames — an exact
        // membership check against seenNames (not a partial-address
        // resolve) is enough, and avoids matchNames' full-set scan on
        // every offline member of every team send. Same lifetime-survival
        // reasoning as routeDirect: deposit gate must not require current
        // `disconnected` membership.
        if (this.registry.seenNames.has(memberName)) {
          this.depositMailbox(
            {
              from,
              to: memberName,
              type,
              content,
              reply_to,
              team,
              outcome: "nak",
              reason: "offline",
            },
            message_id,
            timestamp,
          );
          mailboxDeposited = true;
        }
        continue;
      }
      if (!entry.channelCapable) {
        this.depositMailbox(
          {
            from,
            to: entry.fullName,
            type,
            content,
            reply_to,
            team,
            outcome: "nak",
            reason: "no-channel",
          },
          message_id,
          timestamp,
        );
        mailboxDeposited = true;
        skipped_no_channel++;
        continue;
      }

      try {
        entry.ws.send(serialized);
      } catch {
        this.depositMailbox(
          {
            from,
            to: entry.fullName,
            type,
            content,
            reply_to,
            team,
            outcome: "nak",
            reason: "transport-error",
          },
          message_id,
          timestamp,
        );
        mailboxDeposited = true;
        continue;
      }
      delivered_to++;
      this.depositMailbox(
        {
          from,
          to: entry.fullName,
          type,
          content,
          reply_to,
          team,
          outcome: "delivered",
        },
        message_id,
        timestamp,
      );
    }

    if (delivered_to === 0 && skipped_no_channel === 0) {
      return {
        ok: false,
        error: mailboxDeposited
          ? `No online members in team '${team}'. The message was recorded to offline members' mailboxes.`
          : `No online members in team '${team}'.`,
        mailbox: mailboxDeposited,
      };
    }

    return {
      ok: true,
      message_id,
      delivered_to,
      skipped_no_channel,
      mailbox: mailboxDeposited,
    };
  }

  /**
   * Deliver a hub-originated notification to `to`. The from-field is the
   * reserved `system@claude-net` identity (structurally unforgeable —
   * isValidAgentName rejects it on register, see registry.ts), so a
   * receiving LLM that follows the documented trust model can
   * distinguish this from agent-to-agent traffic.
   *
   * Used today for the delivery-failure feedback path: when a recipient's
   * Claude Code reports an API error after receiving a message, the hub
   * routes a system notification back to the original sender so they
   * know their message may not have been processed. Unlike routeDirect
   * this does NOT NAK on no-channel — there is no caller to surface a
   * NAK to (the hub originates the message), so the outcome is just
   * "delivered" or "skipped" with no error path. Non-delivery deposits
   * use mailbox outcome "skipped" (not "nak") to match: nothing here was
   * rejected, there was just nowhere to deliver it.
   *
   * The delivered path deliberately does NOT deposit: this notification
   * only fires once the hub has already live-delivered to a connected,
   * channel-capable agent — the case with the least recovery value — and
   * depositing there would let a redundant automated notice evict a
   * genuinely unread inter-agent message from the recipient's single
   * mailbox slot.
   *
   * The non-delivery paths (offline / no-channel / transport-error) are
   * guarded by the same reasoning: `hasUnreadAgentMessage` skips the
   * deposit when the slot already holds an unread agent-to-agent
   * message, so an automated notice can't silently clobber the one copy
   * of a message the recipient hasn't seen yet.
   */
  routeSystemNotification(
    to: string,
    content: string,
  ): { ok: true; outcome: "delivered" | "skipped"; reason?: string } {
    const message_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const resolved = this.registry.resolve(to);
    if (!resolved.ok) {
      // Same ambiguity handling as routeDirect: an ambiguous partial name
      // (multiple *online* agents match) must not fall through to
      // resolveSeenNameOrAmbiguous, which applies a different match
      // priority over a different population and could deposit under a
      // third, unrelated agent's name.
      if (resolved.ambiguous) {
        return { ok: true, outcome: "skipped", reason: "ambiguous" };
      }
      const seen = this.registry.resolveSeenNameOrAmbiguous(to);
      const canonical = seen && "fullName" in seen ? seen.fullName : null;
      if (canonical && !this.hasUnreadAgentMessage(canonical)) {
        this.depositMailbox(
          {
            from: "system@claude-net",
            to: canonical,
            type: "message",
            content,
            outcome: "skipped",
            reason: "offline",
          },
          message_id,
          timestamp,
        );
      }
      return { ok: true, outcome: "skipped", reason: "offline" };
    }
    if (!resolved.entry.channelCapable) {
      if (!this.hasUnreadAgentMessage(resolved.entry.fullName)) {
        this.depositMailbox(
          {
            from: "system@claude-net",
            to: resolved.entry.fullName,
            type: "message",
            content,
            outcome: "skipped",
            reason: "no-channel",
          },
          message_id,
          timestamp,
        );
      }
      return { ok: true, outcome: "skipped", reason: "no-channel" };
    }
    const frame: InboundMessageFrame = {
      event: "message",
      message_id,
      from: "system@claude-net",
      to: resolved.entry.fullName,
      type: "message",
      content,
      timestamp,
    };
    try {
      resolved.entry.ws.send(JSON.stringify(frame));
    } catch {
      if (!this.hasUnreadAgentMessage(resolved.entry.fullName)) {
        this.depositMailbox(
          {
            from: "system@claude-net",
            to: resolved.entry.fullName,
            type: "message",
            content,
            outcome: "skipped",
            reason: "transport-error",
          },
          message_id,
          timestamp,
        );
      }
      return { ok: true, outcome: "skipped", reason: "transport-error" };
    }
    return { ok: true, outcome: "delivered" };
  }
}
