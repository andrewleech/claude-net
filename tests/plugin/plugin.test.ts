import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDefaultName,
  createChannelNotification,
  mapToolToFrame,
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
    test("register: maps to register action with cc_pid", () => {
      const frame = mapToolToFrame("register", { name: "myagent" });
      expect(frame).toEqual({
        action: "register",
        name: "myagent",
        cc_pid: process.ppid,
      });
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

    test("unknown tool: returns null", () => {
      const frame = mapToolToFrame("unknown_tool", {});
      expect(frame).toBeNull();
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
