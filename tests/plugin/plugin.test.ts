import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildChannelsOffNudge,
  buildDefaultName,
  createChannelNotification,
  detectChannelCapability,
  drainNudges,
  mapToolToFrame,
  pendingNudges,
  withSessionSuffix,
  writeSessionState,
} from "@/plugin/plugin";

describe("plugin helpers", () => {
  describe("buildDefaultName", () => {
    test("returns session:user@hostname format", () => {
      const session = path.basename(process.cwd());
      const user = process.env.USER || os.userInfo().username;
      const host = os.hostname();
      const expected = `${session}:${user}@${host}`;
      expect(buildDefaultName()).toBe(expected);
    });

    test("contains : and @ separators", () => {
      const name = buildDefaultName();
      expect(name).toContain(":");
      expect(name).toContain("@");
    });
  });

  describe("withSessionSuffix", () => {
    test("inserts -N before the colon", () => {
      expect(withSessionSuffix("claude-net:apium@laptop", 2)).toBe(
        "claude-net-2:apium@laptop",
      );
      expect(withSessionSuffix("foo:bob@host", 7)).toBe("foo-7:bob@host");
    });

    test("appends when no colon present (legacy name@host)", () => {
      expect(withSessionSuffix("bob@host", 3)).toBe("bob@host-3");
    });
  });

  describe("createChannelNotification", () => {
    test("formats direct message notification correctly", () => {
      const message = {
        event: "message" as const,
        message_id: "msg-123",
        from: "alice@laptop",
        to: "bob@desktop",
        type: "message" as const,
        content: "Hello Bob",
        timestamp: "2026-01-01T00:00:00Z",
      };

      const notification = createChannelNotification(message);

      expect(notification.method).toBe("notifications/claude/channel");
      expect(notification.params.content).toBe("Hello Bob");
      expect(notification.params.meta.from).toBe("alice@laptop");
      expect(notification.params.meta.type).toBe("message");
      expect(notification.params.meta.message_id).toBe("msg-123");
      expect(notification.params.meta.reply_to).toBeUndefined();
      expect(notification.params.meta.team).toBeUndefined();
    });

    test("formats reply notification with reply_to", () => {
      const message = {
        event: "message" as const,
        message_id: "msg-456",
        from: "bob@desktop",
        to: "alice@laptop",
        type: "reply" as const,
        content: "Hi Alice",
        reply_to: "msg-123",
        timestamp: "2026-01-01T00:00:01Z",
      };

      const notification = createChannelNotification(message);

      expect(notification.params.meta.type).toBe("reply");
      expect(notification.params.meta.reply_to).toBe("msg-123");
    });

    test("includes team in meta when present", () => {
      const message = {
        event: "message" as const,
        message_id: "msg-789",
        from: "alice@laptop",
        to: "team:backend",
        type: "message" as const,
        content: "Team update",
        team: "backend",
        timestamp: "2026-01-01T00:00:02Z",
      };

      const notification = createChannelNotification(message);

      expect(notification.params.meta.team).toBe("backend");
    });

    test("does not include source in meta", () => {
      const message = {
        event: "message" as const,
        message_id: "msg-100",
        from: "alice@laptop",
        to: "bob@desktop",
        type: "message" as const,
        content: "test",
        timestamp: "2026-01-01T00:00:00Z",
      };

      const notification = createChannelNotification(message);
      expect("source" in notification.params.meta).toBe(false);
    });
  });

  describe("mapToolToFrame", () => {
    test("register: maps to register action", () => {
      const frame = mapToolToFrame("register", { name: "myagent" });
      // channelCapable is module-local state in plugin.ts; mapToolToFrame
      // mirrors it into the frame so manual register() calls carry the
      // same capability flag as the auto-register. The exact value is
      // irrelevant here — the shape is what matters. FR8: plugin_version
      // is also carried so the hub can decide whether to emit an
      // upgrade_hint; its exact value is asserted below.
      expect(frame).toEqual({
        action: "register",
        name: "myagent",
        channel_capable: expect.any(Boolean),
        plugin_version: expect.any(String),
      });
    });

    test("register: plugin_version is non-empty (FR8)", () => {
      const frame = mapToolToFrame("register", { name: "myagent" }) as {
        plugin_version: string;
      };
      // The MCP `Server({ version })` declaration and the register-frame
      // plugin_version share a single constant. Non-empty is the
      // contract the hub relies on.
      expect(typeof frame.plugin_version).toBe("string");
      expect(frame.plugin_version.length).toBeGreaterThan(0);
    });

    test("send_message: maps to send action with type message", () => {
      const frame = mapToolToFrame("send_message", {
        to: "bob@host",
        content: "hello",
      });
      expect(frame).toEqual({
        action: "send",
        to: "bob@host",
        content: "hello",
        type: "message",
      });
    });

    test("send_message: maps to send action with type reply when reply_to provided", () => {
      const frame = mapToolToFrame("send_message", {
        to: "bob@host",
        content: "response",
        reply_to: "msg-123",
      });
      expect(frame).toEqual({
        action: "send",
        to: "bob@host",
        content: "response",
        type: "reply",
        reply_to: "msg-123",
      });
    });

    test("broadcast: maps to broadcast action", () => {
      const frame = mapToolToFrame("broadcast", { content: "announcement" });
      expect(frame).toEqual({ action: "broadcast", content: "announcement" });
    });

    test("send_team: maps to send_team action with type message", () => {
      const frame = mapToolToFrame("send_team", {
        team: "backend",
        content: "heads up",
      });
      expect(frame).toEqual({
        action: "send_team",
        team: "backend",
        content: "heads up",
        type: "message",
      });
    });

    test("send_team: maps to send_team action with type reply when reply_to provided", () => {
      const frame = mapToolToFrame("send_team", {
        team: "backend",
        content: "noted",
        reply_to: "msg-456",
      });
      expect(frame).toEqual({
        action: "send_team",
        team: "backend",
        content: "noted",
        type: "reply",
        reply_to: "msg-456",
      });
    });

    test("join_team: maps to join_team action", () => {
      const frame = mapToolToFrame("join_team", { team: "frontend" });
      expect(frame).toEqual({ action: "join_team", team: "frontend" });
    });

    test("leave_team: maps to leave_team action", () => {
      const frame = mapToolToFrame("leave_team", { team: "frontend" });
      expect(frame).toEqual({ action: "leave_team", team: "frontend" });
    });

    test("list_agents: maps to list_agents action", () => {
      const frame = mapToolToFrame("list_agents", {});
      expect(frame).toEqual({ action: "list_agents" });
    });

    test("list_teams: maps to list_teams action", () => {
      const frame = mapToolToFrame("list_teams", {});
      expect(frame).toEqual({ action: "list_teams" });
    });

    test("hub_events: no args produces query_events with default since", () => {
      const before = Date.now() - 60 * 60_000 - 100;
      const frame = mapToolToFrame("hub_events", {}) as Record<string, unknown>;
      expect(frame).not.toBeNull();
      expect(frame.action).toBe("query_events");
      // since should be approximately now - 60 minutes
      expect(typeof frame.since).toBe("number");
      expect(frame.since as number).toBeGreaterThan(before);
      expect(frame.event).toBeUndefined();
      expect(frame.limit).toBeUndefined();
      expect(frame.agent).toBeUndefined();
    });

    test("hub_events: filter sets event field", () => {
      const frame = mapToolToFrame("hub_events", {
        filter: "message",
      }) as Record<string, unknown>;
      expect(frame.action).toBe("query_events");
      expect(frame.event).toBe("message");
    });

    test("hub_events: since_minutes overrides the default window", () => {
      const before = Date.now() - 5 * 60_000 - 200;
      const frame = mapToolToFrame("hub_events", {
        since_minutes: "5",
      }) as Record<string, unknown>;
      expect(frame.since as number).toBeGreaterThan(before);
      expect(frame.since as number).toBeLessThan(Date.now() - 4 * 60_000);
    });

    test("hub_events: limit and agent are forwarded", () => {
      const frame = mapToolToFrame("hub_events", {
        limit: "50",
        agent: "alice",
      }) as Record<string, unknown>;
      expect(frame.limit).toBe(50);
      expect(frame.agent).toBe("alice");
    });

    test("unknown tool: returns null", () => {
      const frame = mapToolToFrame("unknown_tool", {});
      expect(frame).toBeNull();
    });
  });

  describe("detectChannelCapability (FR2)", () => {
    test("true when experimental.claude/channel is an object", () => {
      expect(
        detectChannelCapability({ experimental: { "claude/channel": {} } }),
      ).toBe(true);
    });

    test("true when experimental.claude/channel is a truthy boolean", () => {
      expect(
        detectChannelCapability({ experimental: { "claude/channel": true } }),
      ).toBe(true);
    });

    test("false when experimental.claude/channel is missing", () => {
      expect(detectChannelCapability({ experimental: {} })).toBe(false);
    });

    test("false when experimental is missing", () => {
      expect(detectChannelCapability({})).toBe(false);
    });

    test("false when capabilities object is null/undefined", () => {
      expect(detectChannelCapability(null)).toBe(false);
      expect(detectChannelCapability(undefined)).toBe(false);
    });

    test("false when value is falsy (null / false / 0)", () => {
      expect(
        detectChannelCapability({ experimental: { "claude/channel": null } }),
      ).toBe(false);
      expect(
        detectChannelCapability({ experimental: { "claude/channel": false } }),
      ).toBe(false);
      expect(
        detectChannelCapability({ experimental: { "claude/channel": 0 } }),
      ).toBe(false);
    });
  });

  describe("drainNudges (nudge queue)", () => {
    afterEach(() => {
      pendingNudges.length = 0;
    });

    test("returns unchanged result when queue is empty", () => {
      const result = {
        content: [{ type: "text" as const, text: "original" }],
      };
      const out = drainNudges(result);
      expect(out.content).toHaveLength(1);
      expect(out.content[0]?.text).toBe("original");
    });

    test("appends all queued nudges to result.content", () => {
      pendingNudges.push({ text: "nudge A" }, { text: "nudge B" });
      const result = {
        content: [{ type: "text" as const, text: "tool output" }],
      };
      drainNudges(result);
      expect(result.content).toHaveLength(3);
      expect(result.content[1]?.text).toBe("nudge A");
      expect(result.content[2]?.text).toBe("nudge B");
    });

    test("removes consumed nudges — fires exactly once", () => {
      pendingNudges.push({ text: "one-shot" });
      const first = { content: [{ type: "text" as const, text: "r1" }] };
      drainNudges(first);
      expect(pendingNudges).toHaveLength(0);

      const second = { content: [{ type: "text" as const, text: "r2" }] };
      drainNudges(second);
      expect(second.content).toHaveLength(1);
    });

    test("skips nudges whose guard returns false", () => {
      let ready = false;
      pendingNudges.push({ text: "guarded", guard: () => ready });
      pendingNudges.push({ text: "unguarded" });

      const first = { content: [{ type: "text" as const, text: "r1" }] };
      drainNudges(first);
      expect(first.content).toHaveLength(2);
      expect(first.content[1]?.text).toBe("unguarded");
      expect(pendingNudges).toHaveLength(1);

      ready = true;
      const second = { content: [{ type: "text" as const, text: "r2" }] };
      drainNudges(second);
      expect(second.content).toHaveLength(2);
      expect(second.content[1]?.text).toBe("guarded");
      expect(pendingNudges).toHaveLength(0);
    });
  });

  describe("buildChannelsOffNudge (FR2)", () => {
    test("mentions install-channels and that inbound is broken", () => {
      const nudge = buildChannelsOffNudge();
      expect(nudge).toContain("install-channels");
      expect(nudge.toLowerCase()).toContain("inbound");
      // One-shot: the text itself should say it only fires once so the
      // LLM doesn't repeat it.
      expect(nudge.toLowerCase()).toContain("once");
    });
  });

  describe("writeSessionState", () => {
    const stateDir = "/tmp/claude-net";
    const stateFile = path.join(stateDir, `state-${process.ppid}.json`);

    afterEach(() => {
      try {
        fs.unlinkSync(stateFile);
      } catch {
        // ignore
      }
    });

    test("writes online state file with correct shape", () => {
      writeSessionState({
        name: "test@host",
        status: "online",
        hub: "ws://localhost:4815/ws",
        cwd: "/tmp/test",
      });

      const content = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(content.name).toBe("test@host");
      expect(content.status).toBe("online");
      expect(content.hub).toBe("ws://localhost:4815/ws");
      expect(content.cwd).toBe("/tmp/test");
      expect(content.updated_at).toBeDefined();
    });

    test("writes error state file with error field", () => {
      writeSessionState({
        name: "",
        status: "error",
        error: "Name already taken.",
        hub: "ws://localhost:4815/ws",
        cwd: "/tmp/test",
      });

      const content = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(content.status).toBe("error");
      expect(content.error).toBe("Name already taken.");
      expect(content.name).toBe("");
    });

    test("writes disconnected state file", () => {
      writeSessionState({
        name: "agent@host",
        status: "disconnected",
        hub: "ws://localhost:4815/ws",
        cwd: "/tmp/test",
      });

      const content = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(content.status).toBe("disconnected");
      expect(content.name).toBe("agent@host");
    });
  });
});
