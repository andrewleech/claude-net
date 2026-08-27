import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "@/hub/registry";
import { Router } from "@/hub/router";
import { Teams } from "@/hub/teams";
import type { InboundMessageFrame } from "@/shared/types";

function mockWs() {
  const sent: InboundMessageFrame[] = [];
  return {
    send(data: string) {
      sent.push(JSON.parse(data) as InboundMessageFrame);
    },
    sent,
  };
}

describe("Router", () => {
  let registry: Registry;
  let teams: Teams;
  let router: Router;

  beforeEach(() => {
    registry = new Registry();
    teams = new Teams(registry);
    router = new Router(registry, teams);
  });

  describe("routeDirect", () => {
    test("delivers to recipient WS", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hello",
        "message",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toBe("delivered");
      expect(result.message_id).toBeTruthy();

      expect(wsB.sent).toHaveLength(1);
      const msg = wsB.sent[0];
      expect(msg).toBeDefined();
      expect(msg?.event).toBe("message");
      expect(msg?.from).toBe("proj:alice@host");
      expect(msg?.to).toBe("proj:bob@host");
      expect(msg?.content).toBe("hello");
      expect(msg?.message_id).toBeTruthy();
      expect(msg?.timestamp).toBeTruthy();
    });

    test("delivers to session name recipient", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("other:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "other",
        "hi",
        "message",
      );
      expect(result.ok).toBe(true);
      expect(wsB.sent).toHaveLength(1);
    });

    test("sends reply with reply_to", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "thanks",
        "reply",
        "msg-123",
      );
      expect(result.ok).toBe(true);
      expect(wsB.sent[0]?.reply_to).toBe("msg-123");
      expect(wsB.sent[0]?.type).toBe("reply");
    });

    test("returns error for offline agent", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hello",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.outcome).toBe("nak");
        expect(result.reason).toBe("offline");
        expect(result.error).toContain("not online");
        // Bob was never registered — nothing was deposited, and the error
        // says so rather than implying recovery via the mailbox tool.
        expect(result.mailbox).toBe(false);
        expect(result.error).toContain("NOT recorded");
      }
    });

    test("offline NAK for a previously-seen agent notes the message was recorded", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      registry.unregister("proj:bob@host");

      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hello",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.mailbox).toBe(true);
        expect(result.error).toContain("recorded to their mailbox");
      }
    });

    test("returns delivered ACK with outcome field", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hi",
        "message",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toBe("delivered");
      expect(result.to_dashboard).toBeUndefined();
    });

    test("NAKs with reason=no-channel when recipient has channelCapable=false", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: false,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hi",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.outcome).toBe("nak");
        expect(result.reason).toBe("no-channel");
        expect(result.error).toContain("install-channels");
        expect(result.mailbox).toBe(true);
      }
      // Recipient must NOT have received the frame.
      expect(wsB.sent).toHaveLength(0);
    });

    test("NAKs with reason=no-dashboard when dashboard has no clients", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "dashboard",
        "hi",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.outcome).toBe("nak");
        expect(result.reason).toBe("no-dashboard");
        // The dashboard virtual target never gets a mailbox deposit.
        expect(result.mailbox).toBe(false);
      }
    });

    test("NAKs with reason=invalid-content and deposits nothing when content is not a string", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      // Cast bypasses the compile-time `string` contract, mirroring an
      // untrusted WS/REST frame whose `content` isn't actually a string.
      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        99 as unknown as string,
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-content");
        expect(result.mailbox).toBe(false);
      }
      // Bob got no live delivery and no mailbox deposit.
      expect(wsB.sent.length).toBe(0);
      expect(router.mailbox.get("proj:bob@host")).toBeNull();
    });

    test("NAKs with reason=invalid-content and deposits nothing when reply_to is not a string", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      // Cast bypasses the compile-time `string` contract, mirroring an
      // untrusted WS/REST frame whose `reply_to` isn't actually a string —
      // this used to reach Mailbox.deposit's capReplyTo and throw a
      // TypeError after content had already been live-delivered.
      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hi",
        "message",
        { bogus: true } as unknown as string,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-content");
        expect(result.mailbox).toBe(false);
      }
      // Bob got no live delivery and no mailbox deposit.
      expect(wsB.sent.length).toBe(0);
      expect(router.mailbox.get("proj:bob@host")).toBeNull();
    });
  });

  describe("routeTeam", () => {
    test("delivers to online team members except sender", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      const wsC = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      registry.register("proj:carol@host", wsC, undefined, {
        channelCapable: true,
      });

      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");
      teams.join("backend", "proj:carol@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delivered_to).toBe(2);
      expect(result.skipped_no_channel).toBe(0);

      expect(wsA.sent).toHaveLength(0);
      expect(wsB.sent).toHaveLength(1);
      expect(wsC.sent).toHaveLength(1);
      expect(wsB.sent[0]?.team).toBe("backend");
      // Everyone addressable got live delivery — no mailbox fallback.
      expect(result.mailbox).toBe(false);
    });

    test("success response reports mailbox:true when an offline member was deposited alongside a live delivery", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      const wsC = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      registry.register("proj:carol@host", wsC, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");
      teams.join("backend", "proj:carol@host");
      registry.getByFullName("proj:carol@host")?.teams.add("backend");
      registry.unregister("proj:carol@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delivered_to).toBe(1);
      expect(result.mailbox).toBe(true);
    });

    test("skips non-channel-capable team members and counts them", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      const wsC = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      registry.register("proj:carol@host", wsC, undefined, {
        channelCapable: false,
      });

      teams.join("ops", "proj:alice@host");
      teams.join("ops", "proj:bob@host");
      teams.join("ops", "proj:carol@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "ops",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delivered_to).toBe(1);
      expect(result.skipped_no_channel).toBe(1);

      expect(wsB.sent).toHaveLength(1);
      expect(wsC.sent).toHaveLength(0);
    });

    test("returns error for nonexistent team", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });

      const result = router.routeTeam(
        "proj:alice@host",
        "nope",
        "msg",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("does not exist");
      }
    });

    test("returns error when no online members", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA);

      // Create team with only offline member
      teams.join("backend", "proj:offline@host");
      teams.join("backend", "proj:alice@host");

      // Route from alice — offline@host is not registered, alice is sender (excluded)
      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "msg",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("No online members");
      }
    });

    test("after a rename, delivers under the current name instead of depositing at the dead one", () => {
      // Simulates the rekey ws-plugin performs on rename: the team's
      // membership set is updated in place (Teams.renameMember), and the
      // renamed agent is registered under its new name.
      const wsA = mockWs();
      const wsBob = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "old:bob@host");
      teams.join("backend", "proj:alice@host");
      registry.register("new:bob@host", wsBob, undefined, {
        channelCapable: true,
      });
      teams.renameMember("old:bob@host", "new:bob@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delivered_to).toBe(1);
      expect(wsBob.sent).toHaveLength(1);
      expect(router.mailbox.get("old:bob@host")).toBeNull();
    });

    test("after a rename, the sender's own re-broadcast is still skipped as self", () => {
      const wsAlice = mockWs();
      const wsCarol = mockWs();
      const identity = {};
      registry.register("old:alice@host", wsAlice, identity, {
        channelCapable: true,
      });
      registry.register("proj:carol@host", wsCarol, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "old:alice@host");
      teams.join("backend", "proj:carol@host");

      // Rename alice on the same identity (same WS) and rekey the team
      // membership, mirroring what ws-plugin does on rename.
      registry.register("new:alice@host", wsAlice, identity, {
        channelCapable: true,
      });
      teams.renameMember("old:alice@host", "new:alice@host");

      const result = router.routeTeam(
        "new:alice@host",
        "backend",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(true);
      expect(wsCarol.sent).toHaveLength(1);
      // Alice's own re-broadcast must not land in her own mailbox under
      // either name.
      expect(router.mailbox.get("new:alice@host")).toBeNull();
      expect(router.mailbox.get("old:alice@host")).toBeNull();
    });

    test("all routed messages have message_id, from, timestamp", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      router.routeDirect("proj:alice@host", "proj:bob@host", "test", "message");
      const msg = wsB.sent[0];
      expect(msg).toBeDefined();
      expect(msg?.message_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(msg?.from).toBe("proj:alice@host");
      expect(msg?.timestamp).toBeTruthy();
      // Verify timestamp is valid ISO
      expect(Number.isNaN(Date.parse(msg?.timestamp ?? ""))).toBe(false);
    });

    test("non-string content fails before any member is touched — no partial broadcast", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      const wsC = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      registry.register("proj:carol@host", wsC, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");
      teams.join("backend", "proj:carol@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        99 as unknown as string,
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.mailbox).toBe(false);
      // Neither member received a live frame nor a mailbox deposit — the
      // failure is atomic, not a partial broadcast.
      expect(wsB.sent.length).toBe(0);
      expect(wsC.sent.length).toBe(0);
      expect(router.mailbox.get("proj:bob@host")).toBeNull();
      expect(router.mailbox.get("proj:carol@host")).toBeNull();
    });

    test("non-string reply_to fails before any member is touched — no partial broadcast", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      const wsC = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      registry.register("proj:carol@host", wsC, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");
      teams.join("backend", "proj:carol@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "hi",
        "message",
        { bogus: true } as unknown as string,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.mailbox).toBe(false);
      // Neither member received a live frame nor a mailbox deposit — the
      // failure is atomic, not a partial broadcast (this used to throw
      // mid-loop out of Mailbox.deposit's capReplyTo instead).
      expect(wsB.sent.length).toBe(0);
      expect(wsC.sent.length).toBe(0);
      expect(router.mailbox.get("proj:bob@host")).toBeNull();
      expect(router.mailbox.get("proj:carol@host")).toBeNull();
    });
  });

  describe("routeSystemNotification", () => {
    test("delivers with from=system@claude-net when recipient is online and channel-capable", () => {
      const ws = mockWs();
      registry.register("proj:alice@host", ws, undefined, {
        channelCapable: true,
      });
      const result = router.routeSystemNotification(
        "proj:alice@host",
        "delivery report",
      );
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("delivered");
      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]?.from).toBe("system@claude-net");
      expect(ws.sent[0]?.content).toBe("delivery report");
      expect(ws.sent[0]?.to).toBe("proj:alice@host");
    });

    test("skips with reason=offline when recipient unknown", () => {
      const result = router.routeSystemNotification(
        "proj:ghost@host",
        "anyone?",
      );
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("skipped");
      expect(result.reason).toBe("offline");
    });

    test("skips with reason=no-channel when recipient lacks channels", () => {
      const ws = mockWs();
      registry.register("proj:alice@host", ws, undefined, {
        channelCapable: false,
      });
      const result = router.routeSystemNotification("proj:alice@host", "hello");
      expect(result.outcome).toBe("skipped");
      expect(result.reason).toBe("no-channel");
      expect(ws.sent).toHaveLength(0);
    });

    test("system identity bypasses the register-time name validator", () => {
      // The whole point of using system@claude-net as the from-field is
      // that it cannot be registered (isValidAgentName rejects it), so
      // no remote agent can forge a notification with that origin. Make
      // sure the router doesn't accidentally tighten this — recipients
      // are still resolved through the normal registry.
      const ws = mockWs();
      registry.register("proj:bob@host", ws, undefined, {
        channelCapable: true,
      });
      const result = router.routeSystemNotification("proj:bob@host", "hi");
      expect(result.outcome).toBe("delivered");
      expect(ws.sent[0]?.from).toBe("system@claude-net");
    });

    test("an ambiguous partial recipient name is skipped without depositing under a guessed fullName", () => {
      const wsBob1 = mockWs();
      const wsBob2 = mockWs();
      // Two distinct fullNames both currently online, matching the plain
      // query "bob" (differ only in host).
      registry.register("proj:bob@host1", wsBob1, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host2", wsBob2, undefined, {
        channelCapable: true,
      });

      const result = router.routeSystemNotification("bob", "delivery report");
      expect(result.outcome).toBe("skipped");
      expect(router.mailbox.get("proj:bob@host1")).toBeNull();
      expect(router.mailbox.get("proj:bob@host2")).toBeNull();
      expect(wsBob1.sent).toHaveLength(0);
      expect(wsBob2.sent).toHaveLength(0);
    });
  });

  describe("mailbox deposits", () => {
    test("delivered direct send deposits with outcome delivered", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hi",
        "message",
        "reply-123",
      );
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry).not.toBeNull();
      expect(entry?.outcome).toBe("delivered");
      expect(entry?.from).toBe("proj:alice@host");
      expect(entry?.content).toBe("hi");
      expect(entry?.type).toBe("message");
      expect(entry?.reply_to).toBe("reply-123");
      expect(entry?.read_at).toBeNull();
    });

    test("delivered mailbox entry's message_id matches the frame the recipient received", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hi",
        "message",
      );
      const entry = router.mailbox.get("proj:bob@host");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(wsB.sent[0]?.message_id).toBe(result.message_id);
      expect(entry?.message_id).toBe(result.message_id);
    });

    test("transport-error NAK deposits with reason transport-error", () => {
      const wsA = mockWs();
      const throwingWs = {
        send: () => {
          throw new Error("boom");
        },
      };
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", throwingWs, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "hi",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.mailbox).toBe(true);
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("nak");
      expect(entry?.reason).toBe("transport-error");
    });

    test("no-channel NAK still deposits with reason no-channel", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: false,
      });

      router.routeDirect("proj:alice@host", "proj:bob@host", "hi", "message");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("nak");
      expect(entry?.reason).toBe("no-channel");
    });

    test("offline send to a name never seen does not deposit", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });

      router.routeDirect("proj:alice@host", "proj:ghost@host", "hi", "message");
      expect(router.mailbox.get("proj:ghost@host")).toBeNull();
    });

    test("offline send to a fullName present in registry.disconnected deposits with reason offline", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:bob@host");
      registry.getByFullName("proj:bob@host")?.teams.add("backend");
      registry.unregister("proj:bob@host");
      expect(registry.disconnected.has("proj:bob@host")).toBe(true);

      router.routeDirect("proj:alice@host", "proj:bob@host", "hi", "message");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("nak");
      expect(entry?.reason).toBe("offline");
    });

    test("offline send to a teamless agent still deposits (gate is not team membership)", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      registry.unregister("proj:bob@host");
      // Bob never joined a team, so unregister does NOT track him in
      // `disconnected` — the deposit gate must not depend on that.
      expect(registry.disconnected.has("proj:bob@host")).toBe(false);

      router.routeDirect("proj:alice@host", "proj:bob@host", "hi", "message");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("nak");
      expect(entry?.reason).toBe("offline");
    });

    test("offline send addressed by a partial name still deposits under the canonical fullName", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      registry.unregister("proj:bob@host");

      router.routeDirect("proj:alice@host", "bob", "hi", "message");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("nak");
      expect(entry?.reason).toBe("offline");
    });

    test("offline send addressed by an ambiguous partial name deposits nothing and says so, not 'not known to the hub'", () => {
      const wsA = mockWs();
      const wsBob1 = mockWs();
      const wsBob2 = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      // Two distinct fullNames both match the plain query "bob".
      registry.register("proj:bob@host1", wsBob1, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host2", wsBob2, undefined, {
        channelCapable: true,
      });
      registry.unregister("proj:bob@host1");
      registry.unregister("proj:bob@host2");

      const result = router.routeDirect(
        "proj:alice@host",
        "bob",
        "hi",
        "message",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.mailbox).toBe(false);
      expect(result.error).toContain("Multiple agents match");
      expect(result.error).not.toContain("not known to the hub");
      expect(router.mailbox.get("proj:bob@host1")).toBeNull();
      expect(router.mailbox.get("proj:bob@host2")).toBeNull();
    });

    test("offline deposit for a user@host partial address finds the most recently registered session, rather than becoming permanently ambiguous once two sessions have used that address", () => {
      const wsA = mockWs();
      const wsBobA = mockWs();
      const wsBobB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj-a:bob@host", wsBobA, undefined, {
        channelCapable: true,
      });
      registry.unregister("proj-a:bob@host");
      registry.register("proj-b:bob@host", wsBobB, undefined, {
        channelCapable: true,
      });
      registry.unregister("proj-b:bob@host");

      const result = router.routeDirect(
        "proj:alice@host",
        "bob@host",
        "hi",
        "message",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.mailbox).toBe(true);
      expect(router.mailbox.get("proj-b:bob@host")?.content).toBe("hi");
      expect(router.mailbox.get("proj-a:bob@host")).toBeNull();
    });

    test("offline deposit for a user@host partial address is refused as ambiguous — not guessed — when the two sessions were online concurrently, not sequentially", () => {
      const wsA = mockWs();
      const wsSibA = mockWs();
      const wsSibB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      // Two distinct sessions both online at once, sharing user+host —
      // genuinely different agents, not one identity renamed over time.
      registry.register("sessA:bob@host", wsSibA, undefined, {
        channelCapable: true,
      });
      registry.register("sessB:bob@host", wsSibB, undefined, {
        channelCapable: true,
      });
      registry.unregister("sessA:bob@host");
      registry.unregister("sessB:bob@host");

      const result = router.routeDirect(
        "proj:alice@host",
        "bob@host",
        "hi",
        "message",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("ambiguous");
      // Neither sibling's mailbox was silently guessed into.
      expect(result.mailbox).toBe(false);
      expect(router.mailbox.get("sessA:bob@host")).toBeNull();
      expect(router.mailbox.get("sessB:bob@host")).toBeNull();
    });

    test("a partial name ambiguous among currently-online agents is reported once, tagged reason=ambiguous, not duplicated against an offline/seenNames message", () => {
      const wsA = mockWs();
      const wsBob1 = mockWs();
      const wsBob2 = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      // Two distinct, currently ONLINE fullNames share the session name
      // "bob" (differ only in user/host) — a live collision, not a
      // historical-accumulation artifact.
      registry.register("bob:carol@host1", wsBob1, undefined, {
        channelCapable: true,
      });
      registry.register("bob:dave@host2", wsBob2, undefined, {
        channelCapable: true,
      });

      const result = router.routeDirect(
        "proj:alice@host",
        "bob",
        "hi",
        "message",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("ambiguous");
      expect(result.mailbox).toBe(false);
      // Exactly one "Multiple agents match" sentence — no second,
      // differently-scoped ambiguity list appended from a seenNames pass.
      const occurrences =
        result.error.split("Multiple agents match").length - 1;
      expect(occurrences).toBe(1);
    });

    test("team send deposits per-member with the team field set", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "team msg",
        "message",
      );
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("delivered");
      expect(entry?.team).toBe("backend");
      expect(result.ok).toBe(true);
      if (result.ok) expect(entry?.message_id).toBe(result.message_id);
    });

    test("team send deposits offline members with reason offline", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");
      registry.getByFullName("proj:bob@host")?.teams.add("backend");
      registry.unregister("proj:bob@host");

      router.routeTeam("proj:alice@host", "backend", "team msg", "message");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("nak");
      expect(entry?.reason).toBe("offline");
      expect(entry?.team).toBe("backend");
    });

    test("team send deposits no-channel members with reason no-channel", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: false,
      });
      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");

      router.routeTeam("proj:alice@host", "backend", "team msg", "message");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("nak");
      expect(entry?.reason).toBe("no-channel");
      expect(entry?.team).toBe("backend");
    });

    test("team send deposits with reason transport-error when a member's ws throws", () => {
      const wsA = mockWs();
      const wsCarol = mockWs();
      const throwingWs = {
        send: () => {
          throw new Error("boom");
        },
      };
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", throwingWs, undefined, {
        channelCapable: true,
      });
      registry.register("proj:carol@host", wsCarol, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");
      teams.join("backend", "proj:carol@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(true);
      // Bob's throw must not count toward delivered_to, and must not
      // block carol's delivery.
      if (result.ok) expect(result.delivered_to).toBe(1);
      expect(wsCarol.sent).toHaveLength(1);
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.outcome).toBe("nak");
      expect(entry?.reason).toBe("transport-error");
      expect(entry?.team).toBe("backend");
    });

    test("team send with no online members still reports mailbox:true when an offline member got deposited", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:alice@host");
      teams.join("backend", "proj:bob@host");
      registry.getByFullName("proj:bob@host")?.teams.add("backend");
      registry.unregister("proj:bob@host");
      registry.unregister("proj:alice@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.mailbox).toBe(true);
      expect(router.mailbox.get("proj:bob@host")?.outcome).toBe("nak");
    });

    test("team send with no online members reports mailbox:false when nobody was deposited", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      teams.join("backend", "proj:alice@host");
      registry.unregister("proj:alice@host");

      const result = router.routeTeam(
        "proj:alice@host",
        "backend",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.mailbox).toBe(false);
    });

    test("send to the dashboard target deposits nothing", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });

      router.routeDirect("proj:alice@host", "dashboard", "hi", "message");
      expect(router.mailbox.get("dashboard")).toBeNull();
      expect(router.mailbox.get("dashboard@hub")).toBeNull();
    });

    test("a second send to the same recipient overwrites the mailbox", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:bob@host", wsB, undefined, {
        channelCapable: true,
      });

      router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "first",
        "message",
      );
      router.routeDirect(
        "proj:alice@host",
        "proj:bob@host",
        "second",
        "message",
      );
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.content).toBe("second");
    });
  });

  describe("routeSystemNotification mailbox deposits", () => {
    test("delivered path does NOT deposit — preserves the recipient's existing slot", () => {
      const wsA = mockWs();
      const wsBob = mockWs();
      registry.register("proj:carol@host", wsA, undefined, {
        channelCapable: true,
      });
      registry.register("proj:alice@host", wsBob, undefined, {
        channelCapable: true,
      });
      router.routeDirect(
        "proj:carol@host",
        "proj:alice@host",
        "IMPORTANT unread",
        "message",
      );

      const result = router.routeSystemNotification(
        "proj:alice@host",
        "delivery report",
      );
      expect(result.outcome).toBe("delivered");
      const entry = router.mailbox.get("proj:alice@host");
      expect(entry?.content).toBe("IMPORTANT unread");
    });

    test("offline path deposits with outcome skipped, reason offline", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA);
      registry.unregister("proj:alice@host");

      const result = router.routeSystemNotification(
        "proj:alice@host",
        "delivery report",
      );
      expect(result.outcome).toBe("skipped");
      const entry = router.mailbox.get("proj:alice@host");
      expect(entry?.outcome).toBe("skipped");
      expect(entry?.reason).toBe("offline");
      expect(entry?.from).toBe("system@claude-net");
    });

    test("no-channel path deposits with outcome skipped, reason no-channel", () => {
      const wsA = mockWs();
      registry.register("proj:alice@host", wsA, undefined, {
        channelCapable: false,
      });

      const result = router.routeSystemNotification(
        "proj:alice@host",
        "delivery report",
      );
      expect(result.outcome).toBe("skipped");
      const entry = router.mailbox.get("proj:alice@host");
      expect(entry?.outcome).toBe("skipped");
      expect(entry?.reason).toBe("no-channel");
    });

    test("transport-error path deposits with outcome skipped, reason transport-error", () => {
      const throwingWs = {
        send: () => {
          throw new Error("boom");
        },
      };
      registry.register("proj:alice@host", throwingWs, undefined, {
        channelCapable: true,
      });

      const result = router.routeSystemNotification(
        "proj:alice@host",
        "delivery report",
      );
      expect(result.outcome).toBe("skipped");
      const entry = router.mailbox.get("proj:alice@host");
      expect(entry?.outcome).toBe("skipped");
      expect(entry?.reason).toBe("transport-error");
    });

    test("a name ambiguous among online agents reports ambiguous instead of depositing under an unrelated seen name", () => {
      const wsOff = mockWs();
      registry.register("x:someone@host3", wsOff);
      registry.unregister("x:someone@host3");

      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("s1:x@host1", wsA);
      registry.register("s2:x@host2", wsB);

      const result = router.routeSystemNotification("x", "hub notice");
      expect(result.outcome).toBe("skipped");
      expect(result.reason).toBe("ambiguous");
      // Must NOT have deposited into the unrelated seen-but-offline agent's
      // slot — resolveSeenNameOrAmbiguous would collapse "x" to
      // x:someone@host3 (a session-tier match) even though the live
      // ambiguity is a different pair of agents entirely.
      expect(router.mailbox.get("x:someone@host3")).toBeNull();
    });

    test("offline path does not clobber an existing unread agent-to-agent message", () => {
      const wsBob = mockWs();
      const wsCarol = mockWs();
      registry.register("proj:bob@host", wsBob);
      registry.register("proj:carol@host", wsCarol, undefined, {
        channelCapable: true,
      });
      router.routeDirect(
        "proj:carol@host",
        "proj:bob@host",
        "real unread message",
        "message",
      );
      registry.unregister("proj:bob@host");

      const result = router.routeSystemNotification(
        "proj:bob@host",
        "api-error correlation notice",
      );
      expect(result.outcome).toBe("skipped");
      const entry = router.mailbox.get("proj:bob@host");
      // The genuine agent-to-agent message survives untouched.
      expect(entry?.content).toBe("real unread message");
      expect(entry?.from).toBe("proj:carol@host");
    });

    test("no-channel path does not clobber an existing unread agent-to-agent message", () => {
      const wsBob = mockWs();
      const wsCarol = mockWs();
      registry.register("proj:bob@host", wsBob, undefined, {
        channelCapable: false,
      });
      registry.register("proj:carol@host", wsCarol, undefined, {
        channelCapable: true,
      });
      router.routeDirect(
        "proj:carol@host",
        "proj:bob@host",
        "real unread message",
        "message",
      );

      const result = router.routeSystemNotification(
        "proj:bob@host",
        "api-error correlation notice",
      );
      expect(result.outcome).toBe("skipped");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.content).toBe("real unread message");
    });

    test("a live-delivered entry (read_at still null) does not block a later system notification", () => {
      const wsBob = mockWs();
      const wsCarol = mockWs();
      registry.register("proj:bob@host", wsBob, undefined, {
        channelCapable: true,
      });
      registry.register("proj:carol@host", wsCarol, undefined, {
        channelCapable: true,
      });
      router.routeDirect(
        "proj:carol@host",
        "proj:bob@host",
        "live agent msg",
        "message",
      );
      registry.unregister("proj:bob@host");

      // The slot holds a "delivered" entry with read_at still null — bob
      // saw it live, so this must not be mistaken for an unread message.
      const result = router.routeSystemNotification(
        "proj:bob@host",
        "api-error correlation notice",
      );
      expect(result.outcome).toBe("skipped");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.content).toBe("api-error correlation notice");
      expect(entry?.from).toBe("system@claude-net");
    });

    test("once the existing entry has been read, a system notification may overwrite it", () => {
      const wsBob = mockWs();
      const wsCarol = mockWs();
      registry.register("proj:bob@host", wsBob);
      registry.register("proj:carol@host", wsCarol, undefined, {
        channelCapable: true,
      });
      router.routeDirect(
        "proj:carol@host",
        "proj:bob@host",
        "already-seen message",
        "message",
      );
      router.mailbox.markRead("proj:bob@host");
      registry.unregister("proj:bob@host");

      const result = router.routeSystemNotification(
        "proj:bob@host",
        "api-error correlation notice",
      );
      expect(result.outcome).toBe("skipped");
      const entry = router.mailbox.get("proj:bob@host");
      expect(entry?.content).toBe("api-error correlation notice");
      expect(entry?.from).toBe("system@claude-net");
    });
  });
});
