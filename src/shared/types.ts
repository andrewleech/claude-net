// ── Message types ──────────────────────────────────────────────────────────

export type MessageType = "message" | "reply";

// ── Plugin → Hub frames (discriminated union on `action`) ─────────────────

export interface RegisterFrame {
  action: "register";
  name: string;
  requestId?: string;
}

export interface SendFrame {
  action: "send";
  to: string;
  content: string;
  type: MessageType;
  reply_to?: string;
  requestId?: string;
}

export interface BroadcastFrame {
  action: "broadcast";
  content: string;
  requestId?: string;
}

export interface SendTeamFrame {
  action: "send_team";
  team: string;
  content: string;
  type: MessageType;
  reply_to?: string;
  requestId?: string;
}

export interface JoinTeamFrame {
  action: "join_team";
  team: string;
  requestId?: string;
}

export interface LeaveTeamFrame {
  action: "leave_team";
  team: string;
  requestId?: string;
}

export interface ListAgentsFrame {
  action: "list_agents";
  requestId?: string;
}

export interface ListTeamsFrame {
  action: "list_teams";
  requestId?: string;
}

export type PluginFrame =
  | RegisterFrame
  | SendFrame
  | BroadcastFrame
  | SendTeamFrame
  | JoinTeamFrame
  | LeaveTeamFrame
  | ListAgentsFrame
  | ListTeamsFrame;

// ── Hub → Plugin frames (discriminated union on `event`) ──────────────────

export interface ResponseFrame {
  event: "response";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface InboundMessageFrame {
  event: "message";
  message_id: string;
  from: string;
  to: string;
  type: MessageType;
  content: string;
  reply_to?: string;
  team?: string;
  timestamp: string;
}

export interface RegisteredFrame {
  event: "registered";
  name: string;
  full_name: string;
}

export interface ErrorFrame {
  event: "error";
  message: string;
}

export type HubFrame =
  | ResponseFrame
  | InboundMessageFrame
  | RegisteredFrame
  | ErrorFrame;

// ── Hub → Dashboard frames (discriminated union on `event`) ───────────────

export interface AgentConnectedEvent {
  event: "agent:connected";
  name: string;
  full_name: string;
}

export interface AgentDisconnectedEvent {
  event: "agent:disconnected";
  name: string;
  full_name: string;
}

export interface MessageRoutedEvent {
  event: "message:routed";
  message_id: string;
  from: string;
  to: string;
  type: string;
  content: string;
  reply_to?: string;
  team?: string;
  timestamp: string;
}

export interface TeamChangedEvent {
  event: "team:changed";
  team: string;
  members: string[];
  action: "joined" | "left" | "created" | "deleted";
}

export type DashboardEvent =
  | AgentConnectedEvent
  | AgentDisconnectedEvent
  | MessageRoutedEvent
  | TeamChangedEvent;

// ── Data model types ──────────────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  fullName: string;
  shortName: string;
  user: string;
  host: string;
  status: "online" | "offline";
  teams: string[];
  connectedAt: string;
}

export interface TeamInfo {
  name: string;
  members: { name: string; status: "online" | "offline" }[];
}
