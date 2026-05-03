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
  /**
   * Whether the plugin's Claude Code binary advertises the experimental
   * `claude/channel` capability. Set from `Server.getClientCapabilities()`
   * after the MCP `initialize` handshake completes. Hub refuses to
   * promise direct delivery to recipients with `channel_capable: false`
   * and silently skips them on broadcast/team sends.   */
  channel_capable: boolean;
  /**
   * Plugin's self-reported version — sourced from the same value declared
   * on the MCP `Server({ version })` constructor. The hub compares this
   * against its own `PLUGIN_VERSION_CURRENT` (from package.json) on
   * register; on mismatch or missing it returns an `upgrade_hint` in the
   * register response data.   */
  plugin_version: string;
  /**
   * Claude Code PID (plugin's `process.ppid` — the plugin is `exec`-
   * replaced from bash so its parent IS Claude Code itself). Paired
   * with the @host suffix of the agent name, the hub uses this to join
   * mirror sessions to MCP agents on register so a `register("foo")`
   * rename propagates to the dashboard's mirror-session label even
   * across hub restarts. Optional — pre-rollout plugins won't send it.
   */
  cc_pid?: number;
  requestId?: string;
}

/**
 * Shape of the `data` payload on the register response frame. Documents
 * the register-time contract between hub and plugin:
 *   - `name` / `full_name` mirror the plugin's identity as the hub sees it.
 *   - `upgrade_hint` (optional) is present iff `plugin_version` did not
 *     exactly match `PLUGIN_VERSION_CURRENT`; the plugin stores the
 *     string and surfaces it on the next tool result. */
export interface RegisterResponseData {
  name: string;
  full_name: string;
  upgrade_hint?: string;
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

export interface QueryEventsFrame {
  action: "query_events";
  /** Prefix-match on event name: "agent" matches agent.registered, etc. */
  event?: string;
  /** Return only events with ts > since (epoch ms). */
  since?: number;
  /** Max entries returned (default 100, max 1000). */
  limit?: number;
  /** Substring match against from/to/fullName fields in event data. */
  agent?: string;
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

/**
 * Agent → hub reply to a MirrorHistoryRequestFrame. Carries up to `limit`
 * backfilled frames in chronological order (oldest first). `exhausted`
 * indicates the agent reached the start of its JSONL before filling the
 * request, so the dashboard can grey the load-earlier button.
 */
export interface MirrorHistoryChunkFrame {
  action: "mirror_history_chunk";
  sid: string;
  requestId: string;
  frames: MirrorEventFrame[];
  exhausted: boolean;
  error?: string;
}

/**
 * Ephemeral "is Claude currently working" signal from the agent. Not
 * stored in the transcript — broadcast-only to watchers. Derived from
 * the Claude Code hook stream:
 * - UserPromptSubmit → active=true, startedAt=now
 * - PreToolUse       → active=true, tool=<name>
 * - PostToolUse      → active=true, tool=null (between tools)
 * - Stop/SubagentStop / session_end → active=false
 * The dashboard computes elapsed time client-side from startedAt so the
 * ghost row's "✻ Thinking for Ns" counter ticks without any further
 * network traffic.
 */
export interface MirrorThinkingFrame {
  action: "mirror_thinking";
  sid: string;
  active: boolean;
  /** ISO-ish epoch ms timestamp when the current turn started. */
  startedAt?: number;
  /** Tool name if a tool is currently running, else null. */
  tool?: string | null;
}

/**
 * Agent → hub report of the session's context-window utilisation, derived
 * from the `usage` field on JSONL assistant records. Broadcast to watchers
 * and cached on the session so late-joining watchers receive a snapshot.
 */
export interface MirrorStatuslineFrame {
  action: "mirror_statusline";
  sid: string;
  ctx_pct: number;
  ctx_tokens: number;
  ctx_window: number;
  ts: number;
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
  | QueryEventsFrame
  | MirrorEventFrame
  | MirrorPasteDoneFrame
  | MirrorCommandsDoneFrame
  | MirrorHistoryChunkFrame
  | MirrorThinkingFrame
  | MirrorStatuslineFrame;

// ── Hub → Plugin frames (discriminated union on `event`) ──────────────────

export interface ResponseFrame {
  event: "response";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ── Send-outcome response shapes (informational) ──────────────────────────
//
// These document the `data` payloads returned on send/broadcast/send_team
// responses. The ResponseFrame wire format is unchanged; these aliases
// exist so call sites that need to interpret `data` can do so with a
// typed view.

export type SendNakReason =
  | "offline"
  | "no-channel"
  | "transport-error"
  | "no-dashboard";

export type SendDirectResponseData =
  | {
      outcome: "delivered";
      message_id: string;
      /** Kept for backwards compatibility with existing dashboard parsers. */
      delivered: true;
      to_dashboard?: boolean;
    }
  | { outcome: "nak"; reason: SendNakReason };

export interface SendBroadcastResponseData {
  message_id: string;
  delivered_to: number;
  /** Count of online agents skipped because their `channel_capable` is false. */
  skipped_no_channel: number;
}

export interface SendTeamResponseData {
  message_id: string;
  delivered_to: number;
  /** Count of online team members skipped because `channel_capable` is false. */
  skipped_no_channel: number;
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

/**
 * Hub → agent request for backfilled history older than what the hub's
 * in-memory ring still has. Agent reads its on-disk JSONL, walking
 * backward from `before_ts` (or from EOF if null) to gather up to
 * `limit` records strictly older than that cutoff, then converts them
 * to MirrorEventFrame with kind="history_text" and replies with
 * MirrorHistoryChunkFrame.
 *
 * Anchor is a timestamp rather than a uuid because every live frame's
 * uuid is synthetic from the JSONL's perspective (hook frames generate
 * random uuids, JSONL-derived assistant blocks suffix `-text-N`), so a
 * uuid match would never succeed. Timestamps work regardless of source.
 */
export interface MirrorHistoryRequestFrame {
  event: "mirror_history_request";
  sid: string;
  requestId: string;
  before_ts: number | null;
  limit: number;
}

/**
 * Hub → agent request to send an Escape keypress to the session's
 * pane — mirrors the TUI "Esc to interrupt" shortcut. Fire and
 * forget, no correlated ack.
 */
export interface MirrorStopFrame {
  event: "mirror_stop";
  sid: string;
  origin: { watcher: string; ts: number };
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
  | MirrorHistoryRequestFrame
  | MirrorStopFrame
  | MirrorControlFrame;

// ── Hub → Dashboard frames (discriminated union on `event`) ───────────────

export interface AgentConnectedEvent {
  event: "agent:connected";
  name: string;
  full_name: string;
  /**
   * Mirrors the `channel_capable` reported by the plugin on register.
   * Dashboards use this to render a distinct indicator for agents that
   * cannot receive inbound messages.   */
  channel_capable: boolean;
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
  watcher_id: string;
}

export interface MirrorWatcherLeftEvent {
  event: "mirror:watcher_left";
  sid: string;
  watcher_id: string;
}

/**
 * Lightweight activity ping broadcast to the dashboard socket every time a
 * mirror session records an event. Carries only sid + ts so dashboards can
 * bump last_event_at and re-sort the sidebar without receiving full
 * per-session payloads (which can be KB-sized).
 */
/**
 * Coarse "is the agent busy or waiting on the user?" state, derived
 * from frame kinds the hub has already seen. The dashboard uses it to
 * draw an attention pulse on the session-row dot when the agent has
 * stopped working and is waiting on input — without any new hooks.
 */
export type MirrorActivityState = "busy" | "awaiting_input";

export interface MirrorActivityEvent {
  event: "mirror:activity";
  sid: string;
  ts: number;
  /** Latest derived activity state for the session. */
  activity_state: MirrorActivityState;
}

/**
 * Broadcast when an MCP agent renames itself via register(). Every mirror
 * session whose ownerAgent matched the old name has been rewritten to the
 * new name; dashboards update their sidebar labels in place.
 */
export interface MirrorOwnerRenamedEvent {
  event: "mirror:owner_renamed";
  old_owner: string;
  new_owner: string;
  sids: string[];
}

// ── Host channel (daemon → hub long-lived WS at /ws/host) ────────────────

/**
 * First frame the daemon sends on /ws/host after opening. Identifies the
 * host + advertises its launch policy so the dashboard knows which RPCs
 * to expose for it.
 */
export interface HostRegisterFrame {
  action: "host_register";
  host_id: string;
  user: string;
  hostname: string;
  home: string;
  recent_cwds: string[];
  allow_dangerous_skip: boolean;
}

// Hub → daemon RPC requests, all replied to by the matching _done frame.
export interface HostLsRequest {
  action: "host_ls";
  request_id: string;
  path: string;
}

export interface HostMkdirRequest {
  action: "host_mkdir";
  request_id: string;
  path: string;
}

export interface HostLaunchRequest {
  action: "host_launch";
  request_id: string;
  cwd: string;
  create_if_missing?: boolean;
  skip_permissions?: boolean;
}

export interface HostLsDoneFrame {
  action: "host_ls_done";
  request_id: string;
  entries?: Array<{ name: string; is_dir: boolean }>;
  error?: string;
}

export interface HostMkdirDoneFrame {
  action: "host_mkdir_done";
  request_id: string;
  ok?: boolean;
  error?: string;
}

export interface HostLaunchDoneFrame {
  action: "host_launch_done";
  request_id: string;
  ok?: boolean;
  tmux_session?: string;
  error?: string;
}

export interface HostConnectedEvent {
  event: "host:connected";
  host_id: string;
  user: string;
  hostname: string;
  home: string;
  recent_cwds: string[];
  allow_dangerous_skip: boolean;
  connected_at: string;
}

export interface HostDisconnectedEvent {
  event: "host:disconnected";
  host_id: string;
}

/** Real-time broadcast of every EventLog entry to dashboard clients. */
export interface SystemEvent {
  event: "system:event";
  ts: number;
  /** The EventLog event name, e.g. "agent.registered", "ping.tick". */
  name: string;
  data: Record<string, unknown>;
}

export interface HostSummary {
  host_id: string;
  user: string;
  hostname: string;
  home: string;
  recent_cwds: string[];
  allow_dangerous_skip: boolean;
  connected_at: string;
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
  | MirrorWatcherLeftEvent
  | MirrorActivityEvent
  | MirrorOwnerRenamedEvent
  | HostConnectedEvent
  | HostDisconnectedEvent
  | SystemEvent;

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
  | "compact"
  | "history_text";

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
  /**
   * True when this frame originated from Claude Code's SubagentStop hook
   * rather than the top-level Stop. The parent agent is still busy, so
   * the hub does not flip session activity state to awaiting_input.
   */
  subagent?: boolean;
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

/**
 * Backfilled record from the on-disk JSONL — emitted only when the
 * dashboard explicitly requests history older than the hub's in-memory
 * ring. Tool calls/results in the backfilled range collapse to inline
 * `[tool: name]` / `[result]` placeholders within `text`.
 */
export interface MirrorHistoryTextPayload {
  kind: "history_text";
  role: "user" | "assistant" | "system";
  text: string;
}

export type MirrorEventPayload =
  | MirrorSessionStartPayload
  | MirrorSessionEndPayload
  | MirrorUserPromptPayload
  | MirrorAssistantMessagePayload
  | MirrorToolCallPayload
  | MirrorToolResultPayload
  | MirrorNotificationPayload
  | MirrorCompactPayload
  | MirrorHistoryTextPayload;

// ── Mirror data models ────────────────────────────────────────────────────

// Public summary suitable for `GET /api/mirror/sessions`.
export interface MirrorSessionSummary {
  sid: string;
  owner_agent: string;
  cwd: string;
  created_at: string;
  last_event_at: string;
  /** ISO string if the session has been closed, null otherwise. */
  closed_at: string | null;
  watcher_count: number;
  transcript_len: number;
  /** Coarse derived state used to color the dashboard session-row dot. */
  activity_state: MirrorActivityState;
}
