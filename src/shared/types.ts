// Naming convention:
//   - Fields that cross the wire (serialized JSON on a WebSocket or HTTP body)
//     use snake_case, e.g. `message_id`, `session_id`, `reply_to`.
//   - Hub-internal / TS-only object shapes use camelCase,
//     e.g. `AgentInfo.fullName`, `AgentInfo.connectedAt`.
// If you add a new wire-facing type used by the plugin (src/plugin/plugin.ts),
// mirror the definition inline there — plugin.ts cannot import from @/* because
// it is served standalone by the hub.

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

export interface PingFrame {
  action: "ping";
  requestId?: string;
}

export interface MirrorEventFrame {
  action: "mirror_event";
  sid: string;
  uuid: string;
  kind: MirrorEventKind;
  ts: number;
  payload: MirrorEventPayload;
  requestId?: string;
}

/**
 * Agent → hub reply to a MirrorPasteFrame request. Either `path` (success)
 * or `error` (failure) will be set, keyed on the same `requestId`.
 */
export interface MirrorPasteDoneFrame {
  action: "mirror_paste_done";
  sid: string;
  requestId: string;
  path?: string;
  error?: string;
}

/**
 * Agent → hub reply to a MirrorListCommandsFrame request. Carries the
 * slash-command catalog for the session's Claude Code environment.
 */
export interface MirrorCommandsDoneFrame {
  action: "mirror_commands_done";
  sid: string;
  requestId: string;
  commands?: Array<{
    name: string;
    description?: string;
    source: string;
  }>;
  error?: string;
}

export type PluginFrame =
  | RegisterFrame
  | SendFrame
  | BroadcastFrame
  | SendTeamFrame
  | JoinTeamFrame
  | LeaveTeamFrame
  | ListAgentsFrame
  | ListTeamsFrame
  | PingFrame
  | MirrorEventFrame
  | MirrorPasteDoneFrame
  | MirrorCommandsDoneFrame;

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

export interface MirrorInjectFrame {
  event: "mirror_inject";
  sid: string;
  text: string;
  seq: number;
  origin: { watcher: string; ts: number };
}

/**
 * Hub → agent request to stash a blob too large for a single tmux inject.
 * Agent writes the text to a local temp file and replies with
 * MirrorPasteDoneFrame carrying the path.
 */
export interface MirrorPasteFrame {
  event: "mirror_paste";
  sid: string;
  requestId: string;
  text: string;
  origin: { watcher: string; ts: number };
}

/**
 * Hub → agent request to list the slash commands available to this
 * session's Claude Code. Agent walks the .claude/ directory trees and
 * replies with MirrorCommandsDoneFrame.
 */
export interface MirrorListCommandsFrame {
  event: "mirror_list_commands";
  sid: string;
  requestId: string;
}

export interface MirrorControlFrame {
  event: "mirror_control";
  sid: string;
  op: "pause" | "resume" | "close";
}

export type HubFrame =
  | ResponseFrame
  | InboundMessageFrame
  | RegisteredFrame
  | ErrorFrame
  | MirrorInjectFrame
  | MirrorPasteFrame
  | MirrorListCommandsFrame
  | MirrorControlFrame;

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

export interface MirrorSessionStartedEvent {
  event: "mirror:session_started";
  sid: string;
  owner_agent: string;
  cwd: string;
  created_at: string;
}

export interface MirrorSessionEndedEvent {
  event: "mirror:session_ended";
  sid: string;
  ended_at: string;
}

export interface MirrorEventBroadcastEvent {
  event: "mirror:event";
  sid: string;
  uuid: string;
  kind: MirrorEventKind;
  ts: number;
  payload: MirrorEventPayload;
}

export interface MirrorWatcherJoinedEvent {
  event: "mirror:watcher_joined";
  sid: string;
  token_type: MirrorTokenType;
  watcher_id: string;
}

export interface MirrorWatcherLeftEvent {
  event: "mirror:watcher_left";
  sid: string;
  watcher_id: string;
}

export type DashboardEvent =
  | AgentConnectedEvent
  | AgentDisconnectedEvent
  | MessageRoutedEvent
  | TeamChangedEvent
  | MirrorSessionStartedEvent
  | MirrorSessionEndedEvent
  | MirrorEventBroadcastEvent
  | MirrorWatcherJoinedEvent
  | MirrorWatcherLeftEvent;

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

// ── Mirror-session types ──────────────────────────────────────────────────
//
// Wire-facing. See the naming-convention note at the top of the file.

export type MirrorEventKind =
  | "session_start"
  | "session_end"
  | "user_prompt"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "notification"
  | "compact";

export type MirrorSessionSource = "startup" | "resume" | "clear" | "compact";

export interface MirrorSessionStartPayload {
  kind: "session_start";
  source: MirrorSessionSource;
  transcript_path: string;
  cwd: string;
}

export interface MirrorSessionEndPayload {
  kind: "session_end";
  reason: "exit" | "clear" | "compact" | "agent_timeout";
}

export interface MirrorUserPromptPayload {
  kind: "user_prompt";
  prompt: string;
  cwd: string;
  truncated?: boolean;
}

export interface MirrorAssistantMessagePayload {
  kind: "assistant_message";
  text: string;
  stop_reason: string;
  truncated?: boolean;
}

export interface MirrorToolCallPayload {
  kind: "tool_call";
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  truncated?: boolean;
}

export interface MirrorToolResultPayload {
  kind: "tool_result";
  tool_use_id: string;
  tool_name: string;
  response: unknown;
  is_error?: boolean;
  truncated?: boolean;
}

export interface MirrorNotificationPayload {
  kind: "notification";
  text: string;
  source?: string;
}

export interface MirrorCompactPayload {
  kind: "compact";
  phase: "pre" | "post";
  summary?: string;
}

export type MirrorEventPayload =
  | MirrorSessionStartPayload
  | MirrorSessionEndPayload
  | MirrorUserPromptPayload
  | MirrorAssistantMessagePayload
  | MirrorToolCallPayload
  | MirrorToolResultPayload
  | MirrorNotificationPayload
  | MirrorCompactPayload;

// ── Mirror data models ────────────────────────────────────────────────────

export type MirrorTokenType = "owner" | "reader";

// Storage-only. Token `value` must never be included in payloads returned to
// dashboard clients or included in broadcast events.
export interface MirrorToken {
  value: string;
  type: MirrorTokenType;
  sid: string;
  created_at: string;
  revoked_at?: string;
}

// Public summary suitable for `GET /api/mirror/sessions`.
export interface MirrorSessionSummary {
  sid: string;
  owner_agent: string;
  cwd: string;
  created_at: string;
  last_event_at: string;
  watcher_count: number;
  transcript_len: number;
}
