import { describe, expect, test } from "bun:test";
import type {
  AgentConnectedEvent,
  AgentDisconnectedEvent,
  AgentInfo,
  BroadcastFrame,
  DashboardEvent,
  ErrorFrame,
  HubFrame,
  InboundMessageFrame,
  JoinTeamFrame,
  LeaveTeamFrame,
  ListAgentsFrame,
  ListTeamsFrame,
  MessageRoutedEvent,
  MessageType,
  PluginFrame,
  RegisterFrame,
  RegisteredFrame,
  ResponseFrame,
  SendFrame,
  SendTeamFrame,
  TeamChangedEvent,
  TeamInfo,
} from "@/shared/types";

describe("shared types", () => {
  test("MessageType accepts valid values", () => {
    const msg: MessageType = "message";
    const reply: MessageType = "reply";
    expect(msg).toBe("message");
    expect(reply).toBe("reply");
  });

  describe("Plugin → Hub frames (discriminated on action)", () => {
    test("RegisterFrame", () => {
      const frame: PluginFrame = {
        action: "register",
        name: "test@host",
        channel_capable: true,
      };
      expect(frame.action).toBe("register");
      if (frame.action === "register") {
        expect(frame.name).toBe("test@host");
        expect(frame.channel_capable).toBe(true);
      }
    });

    test("SendFrame", () => {
      const frame: PluginFrame = {
        action: "send",
        to: "other@host",
        content: "hello",
        type: "message",
        requestId: "req-1",
      };
      expect(frame.action).toBe("send");
      if (frame.action === "send") {
        expect(frame.to).toBe("other@host");
        expect(frame.type).toBe("message");
      }
    });

    test("BroadcastFrame", () => {
      const frame: PluginFrame = { action: "broadcast", content: "announce" };
      expect(frame.action).toBe("broadcast");
    });

    test("SendTeamFrame", () => {
      const frame: PluginFrame = {
        action: "send_team",
        team: "backend",
        content: "heads up",
        type: "message",
      };
      if (frame.action === "send_team") {
        expect(frame.team).toBe("backend");
      }
    });

    test("JoinTeamFrame", () => {
      const frame: PluginFrame = { action: "join_team", team: "backend" };
      if (frame.action === "join_team") {
        expect(frame.team).toBe("backend");
      }
    });

    test("LeaveTeamFrame", () => {
      const frame: PluginFrame = { action: "leave_team", team: "backend" };
      if (frame.action === "leave_team") {
        expect(frame.team).toBe("backend");
      }
    });

    test("ListAgentsFrame", () => {
      const frame: PluginFrame = { action: "list_agents", requestId: "r1" };
      if (frame.action === "list_agents") {
        expect(frame.requestId).toBe("r1");
      }
    });

    test("ListTeamsFrame", () => {
      const frame: PluginFrame = { action: "list_teams" };
      expect(frame.action).toBe("list_teams");
    });

    test("discriminated union narrows correctly", () => {
      const frame: PluginFrame = {
        action: "send",
        to: "a@b",
        content: "x",
        type: "reply",
        reply_to: "msg-1",
      };

      switch (frame.action) {
        case "register":
          // frame.name would be accessible here
          break;
        case "send":
          expect(frame.reply_to).toBe("msg-1");
          break;
        case "broadcast":
        case "send_team":
        case "join_team":
        case "leave_team":
        case "list_agents":
        case "list_teams":
          break;
      }
    });
  });

  describe("Hub → Plugin frames (discriminated on event)", () => {
    test("ResponseFrame", () => {
      const frame: HubFrame = {
        event: "response",
        requestId: "r1",
        ok: true,
        data: { delivered: true },
      };
      if (frame.event === "response") {
        expect(frame.ok).toBe(true);
        expect(frame.requestId).toBe("r1");
      }
    });

    test("InboundMessageFrame", () => {
      const frame: HubFrame = {
        event: "message",
        message_id: "m1",
        from: "a@host",
        to: "b@host",
        type: "message",
        content: "hello",
        timestamp: "2026-01-01T00:00:00Z",
      };
      if (frame.event === "message") {
        expect(frame.from).toBe("a@host");
        expect(frame.message_id).toBe("m1");
      }
    });

    test("RegisteredFrame", () => {
      const frame: HubFrame = {
        event: "registered",
        name: "test",
        full_name: "test@host",
      };
      if (frame.event === "registered") {
        expect(frame.full_name).toBe("test@host");
      }
    });

    test("ErrorFrame", () => {
      const frame: HubFrame = {
        event: "error",
        message: "something went wrong",
      };
      if (frame.event === "error") {
        expect(frame.message).toBe("something went wrong");
      }
    });
  });

  describe("Hub → Dashboard frames (discriminated on event)", () => {
    test("AgentConnectedEvent", () => {
      const event: DashboardEvent = {
        event: "agent:connected",
        name: "test",
        full_name: "test@host",
        channel_capable: true,
      };
      expect(event.event).toBe("agent:connected");
    });

    test("AgentDisconnectedEvent", () => {
      const event: DashboardEvent = {
        event: "agent:disconnected",
        name: "test",
        full_name: "test@host",
      };
      expect(event.event).toBe("agent:disconnected");
    });

    test("MessageRoutedEvent", () => {
      const event: DashboardEvent = {
        event: "message:routed",
        message_id: "m1",
        from: "a@h",
        to: "b@h",
        type: "message",
        content: "hi",
        timestamp: "2026-01-01T00:00:00Z",
      };
      if (event.event === "message:routed") {
        expect(event.message_id).toBe("m1");
      }
    });

    test("TeamChangedEvent", () => {
      const event: DashboardEvent = {
        event: "team:changed",
        team: "backend",
        members: ["a@h", "b@h"],
        action: "joined",
      };
      if (event.event === "team:changed") {
        expect(event.members).toHaveLength(2);
        expect(event.action).toBe("joined");
      }
    });
  });

  describe("Data model types", () => {
    test("AgentInfo", () => {
      const agent: AgentInfo = {
        name: "test:alice@host",
        fullName: "test:alice@host",
        shortName: "test",
        user: "alice",
        host: "host",
        status: "online",
        teams: ["backend"],
        connectedAt: "2026-01-01T00:00:00Z",
      };
      expect(agent.status).toBe("online");
      expect(agent.teams).toContain("backend");
    });

    test("TeamInfo", () => {
      const team: TeamInfo = {
        name: "backend",
        members: [
          { name: "a@h", status: "online" },
          { name: "b@h", status: "offline" },
        ],
      };
      expect(team.members).toHaveLength(2);
    });
  });
});
