import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  INSTRUCTIONS,
  PLUGIN_VERSION,
  Plugin,
  TOOL_DEFINITIONS,
  buildChannelSelfTestText,
  buildDefaultName,
  createChannelNotification,
  detectChannelCapability,
  withSessionSuffix,
  writeSessionState,
} from "@/plugin/plugin";

describe("plugin helpers", () => {
  // Fresh Plugin per test so channelCapable / pendingNudges /
  // registeredName can't leak between cases. `undefined` hubEnvUrl
  // skips WS connection — these unit tests never want one.
  let plugin: Plugin;
  beforeEach(() => {
    plugin = new Plugin(undefined);
  });

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
      const frame = plugin.mapToolToFrame("register", { name: "myagent" });
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
        cc_pid: process.ppid,
        cwd: expect.any(String),
      });
    });

    test("register: plugin_version is non-empty (FR8)", () => {
      const frame = plugin.mapToolToFrame("register", { name: "myagent" }) as {
        plugin_version: string;
      };
      // The MCP `Server({ version })` declaration and the register-frame
      // plugin_version share a single constant. Non-empty is the
      // contract the hub relies on.
      expect(typeof frame.plugin_version).toBe("string");
      expect(frame.plugin_version.length).toBeGreaterThan(0);
    });

    test("send_message: maps to send action with type message", () => {
      const frame = plugin.mapToolToFrame("send_message", {
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
      const frame = plugin.mapToolToFrame("send_message", {
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
      const frame = plugin.mapToolToFrame("broadcast", {
        content: "announcement",
      });
      expect(frame).toEqual({ action: "broadcast", content: "announcement" });
    });

    test("send_team: maps to send_team action with type message", () => {
      const frame = plugin.mapToolToFrame("send_team", {
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
      const frame = plugin.mapToolToFrame("send_team", {
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
      const frame = plugin.mapToolToFrame("join_team", { team: "frontend" });
      expect(frame).toEqual({ action: "join_team", team: "frontend" });
    });

    test("leave_team: maps to leave_team action", () => {
      const frame = plugin.mapToolToFrame("leave_team", { team: "frontend" });
      expect(frame).toEqual({ action: "leave_team", team: "frontend" });
    });

    test("list_agents: maps to list_agents action", () => {
      const frame = plugin.mapToolToFrame("list_agents", {});
      expect(frame).toEqual({ action: "list_agents" });
    });

    test("list_teams: maps to list_teams action", () => {
      const frame = plugin.mapToolToFrame("list_teams", {});
      expect(frame).toEqual({ action: "list_teams" });
    });

    test("hub_events: no args produces query_events with default since", () => {
      const before = Date.now() - 60 * 60_000 - 100;
      const frame = plugin.mapToolToFrame("hub_events", {}) as Record<
        string,
        unknown
      >;
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
      const frame = plugin.mapToolToFrame("hub_events", {
        filter: "message",
      }) as Record<string, unknown>;
      expect(frame.action).toBe("query_events");
      expect(frame.event).toBe("message");
    });

    test("hub_events: since_minutes overrides the default window", () => {
      const before = Date.now() - 5 * 60_000 - 200;
      const frame = plugin.mapToolToFrame("hub_events", {
        since_minutes: "5",
      }) as Record<string, unknown>;
      expect(frame.since as number).toBeGreaterThan(before);
      expect(frame.since as number).toBeLessThan(Date.now() - 4 * 60_000);
    });

    test("hub_events: limit and agent are forwarded", () => {
      const frame = plugin.mapToolToFrame("hub_events", {
        limit: "50",
        agent: "alice",
      }) as Record<string, unknown>;
      expect(frame.limit).toBe(50);
      expect(frame.agent).toBe("alice");
    });

    test("unknown tool: returns null", () => {
      const frame = plugin.mapToolToFrame("unknown_tool", {});
      expect(frame).toBeNull();
    });
  });

  describe("detectChannelCapability", () => {
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

  describe("ackChannel", () => {
    test("first call returns acked=true and flips channelCapable", async () => {
      expect(plugin.channelCapable).toBe(false);
      const result = await plugin.ackChannel();
      expect(result).toEqual({ acked: true });
      expect(plugin.channelCapable).toBe(true);
    });

    test("subsequent calls report already-acked", async () => {
      await plugin.ackChannel();
      const second = await plugin.ackChannel();
      expect(second).toEqual({ acked: true, already: true });
    });
  });

  describe("drainNudges (nudge queue)", () => {
    afterEach(() => {
      plugin.pendingNudges.length = 0;
    });

    test("returns unchanged result when queue is empty", () => {
      const result = {
        content: [{ type: "text" as const, text: "original" }],
      };
      const out = plugin.drainNudges(result);
      expect(out.content).toHaveLength(1);
      expect(out.content[0]?.text).toBe("original");
    });

    test("appends all queued nudges to result.content", () => {
      plugin.pendingNudges.push({ text: "nudge A" }, { text: "nudge B" });
      const result = {
        content: [{ type: "text" as const, text: "tool output" }],
      };
      plugin.drainNudges(result);
      expect(result.content).toHaveLength(3);
      expect(result.content[1]?.text).toBe("nudge A");
      expect(result.content[2]?.text).toBe("nudge B");
    });

    test("removes consumed nudges — fires exactly once", () => {
      plugin.pendingNudges.push({ text: "one-shot" });
      const first = { content: [{ type: "text" as const, text: "r1" }] };
      plugin.drainNudges(first);
      expect(plugin.pendingNudges).toHaveLength(0);

      const second = { content: [{ type: "text" as const, text: "r2" }] };
      plugin.drainNudges(second);
      expect(second.content).toHaveLength(1);
    });

    test("skips nudges whose guard returns false", () => {
      let ready = false;
      plugin.pendingNudges.push({ text: "guarded", guard: () => ready });
      plugin.pendingNudges.push({ text: "unguarded" });

      const first = { content: [{ type: "text" as const, text: "r1" }] };
      plugin.drainNudges(first);
      expect(first.content).toHaveLength(2);
      expect(first.content[1]?.text).toBe("unguarded");
      expect(plugin.pendingNudges).toHaveLength(1);

      ready = true;
      const second = { content: [{ type: "text" as const, text: "r2" }] };
      plugin.drainNudges(second);
      expect(second.content).toHaveLength(2);
      expect(second.content[1]?.text).toBe("guarded");
      expect(plugin.pendingNudges).toHaveLength(0);
    });
  });

  describe("buildChannelSelfTestText", () => {
    test("includes registered name and instructs single _ack_channel call", () => {
      const text = buildChannelSelfTestText("git-autosquash:corona@carbon");
      expect(text).toContain("git-autosquash:corona@carbon");
      expect(text).toContain("_ack_channel");
      expect(text.toLowerCase()).toContain("once");
    });

    test("avoids prompt-injection-shaped phrasing", () => {
      // Older wording asked the LLM to invoke a tool *and* hide it from
      // the user — exactly the pattern Anthropic alignment training
      // flags as injection. Stricter models (Opus 4.7+) refuse. The
      // tool description on `_ack_channel` itself carries the
      // suppress-narration intent (tool metadata is harness config,
      // not data), so the wrapper notification doesn't need it.
      const text = buildChannelSelfTestText("foo:bar@baz").toLowerCase();
      expect(text).not.toContain("not narrate");
      expect(text).not.toContain("do not");
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

  // ── Phase 1 baseline for the Plugin class refactor ───────────────
  // These tests pin behaviour that the class extraction must not
  // change. They are written against the current module-level code
  // and will continue to hold after the refactor moves state onto a
  // Plugin instance. See docs/PLUGIN_REFACTOR_PLAN.md.
  describe("refactor baseline", () => {
    test("PLUGIN_VERSION is a non-empty semver-shaped string", () => {
      expect(typeof PLUGIN_VERSION).toBe("string");
      expect(PLUGIN_VERSION.length).toBeGreaterThan(0);
      // Loose semver: at least one dot-separated numeric segment.
      expect(PLUGIN_VERSION).toMatch(/^\d+(\.\d+)+/);
    });

    test("INSTRUCTIONS string covers every user-facing feature", () => {
      // If any of these substrings disappears, the system prompt
      // stops instructing Claude to call the corresponding tool or
      // to follow the corresponding convention. The refactor must
      // preserve the full instruction surface.
      expect(typeof INSTRUCTIONS).toBe("string");
      const required = [
        "send_message",
        "register",
        "whoami",
        "broadcast",
        "send_team",
        "join_team",
        "leave_team",
        "list_agents",
        "list_teams",
        "ping",
        "hub_events",
        "install-channels",
      ];
      for (const phrase of required) {
        expect(INSTRUCTIONS).toContain(phrase);
      }
    });

    test("TOOL_DEFINITIONS has 12 well-formed entries", () => {
      expect(Array.isArray(TOOL_DEFINITIONS)).toBe(true);
      expect(TOOL_DEFINITIONS.length).toBe(12);
      const names = new Set<string>();
      for (const tool of TOOL_DEFINITIONS as Array<{
        name: string;
        description: string;
        inputSchema: unknown;
      }>) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
        expect(names.has(tool.name)).toBe(false);
        names.add(tool.name);
      }
      // The canonical set — refactor must not silently drop or
      // rename any of these.
      expect([...names].sort()).toEqual(
        [
          "_ack_channel",
          "broadcast",
          "hub_events",
          "join_team",
          "leave_team",
          "list_agents",
          "list_teams",
          "ping",
          "register",
          "send_message",
          "send_team",
          "whoami",
        ].sort(),
      );
    });

    test("register frame carries channel_capable drawn from plugin state", () => {
      // Today this value is a module-level `let channelCapable` read
      // by closure. After the refactor it will be `this.channelCapable`
      // on the Plugin instance. Either way, the register frame must
      // include the flag as a boolean and the default (no init yet)
      // must be `false`. Tests running in isolation never complete an
      // MCP initialize handshake, so the default is the observable.
      const frame = plugin.mapToolToFrame("register", { name: "x" }) as {
        action: string;
        channel_capable: unknown;
        plugin_version: unknown;
      };
      expect(frame.action).toBe("register");
      expect(typeof frame.channel_capable).toBe("boolean");
      expect(frame.channel_capable).toBe(false);
      expect(frame.plugin_version).toBe(PLUGIN_VERSION);
    });

    test("pure helpers are stateless (identical output for identical input)", () => {
      // These top-level helpers are declared stateless by the plan
      // and must remain top-level exports after the refactor. Calling
      // each twice with the same input must return identical output.
      expect(buildDefaultName()).toBe(buildDefaultName());
      expect(withSessionSuffix("a:b@c", 2)).toBe(withSessionSuffix("a:b@c", 2));
      expect(buildChannelSelfTestText("a:b@c")).toBe(
        buildChannelSelfTestText("a:b@c"),
      );
      expect(detectChannelCapability(undefined)).toBe(
        detectChannelCapability(undefined),
      );
      expect(detectChannelCapability({ experimental: {} })).toBe(false);
      expect(
        detectChannelCapability({ experimental: { "claude/channel": {} } }),
      ).toBe(true);
    });
  });
});
