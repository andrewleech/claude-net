// Plugin entry point — served by the hub at /plugin.ts and run on client machines.
// Claude Code spawns this as a stdio subprocess via:
//   bun run http://<hub>:4815/plugin.ts
//
// SINGLE-FILE CONSTRAINT: This file is served by the hub and fetched by
// `bun run http://hub:4815/plugin.ts`. It CAN import npm packages but
// CANNOT import local project files. Types are duplicated inline.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

// ── Inline type definitions (mirrors src/shared/types.ts) ─────────────────

type MessageType = "message" | "reply";

interface ResponseFrame {
  event: "response";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface InboundMessageFrame {
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

interface RegisteredFrame {
  event: "registered";
  name: string;
  full_name: string;
}

interface ErrorFrame {
  event: "error";
  message: string;
}

type HubFrame =
  | ResponseFrame
  | InboundMessageFrame
  | RegisteredFrame
  | ErrorFrame;

// ── Constants ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const INSTRUCTIONS = `claude-net agent messaging plugin.

Inbound messages from other agents arrive as <channel> tags:
  <channel source="claude-net" from="session:user@host" type="message|reply" message_id="..." reply_to="..." team="...">
    message content
  </channel>

Agent name format: session:user@host
  - session = project folder name (basename of cwd)
  - user = OS username
  - host = hostname
  - Example: "claude-net:andrew@laptop"

Available tools:
- whoami() — return your current registered name, or an error if not registered
- register(name) — claim a name. Provide just a session name (e.g. "reviewer") and it auto-expands to "reviewer:user@host", or provide the full "session:user@host" format.
- send_message(to, content, reply_to?) — send to an agent. Addressing modes:
    - Full name: "claude-net:andrew@laptop" (exact match)
    - session:user: "claude-net:andrew" (matches across hosts)
    - user@host: "andrew@laptop" (matches across sessions)
    - Plain string: tries session name, then user, then host
- broadcast(content) — send to all online agents
- send_team(team, content, reply_to?) — send to all online members of a team
- join_team(team) — join a team (creates it if new)
- leave_team(team) — leave a team
- list_agents() — list all agents with status
- list_teams() — list all teams with members

IDENTITY AND REGISTRATION:
On startup the plugin tries to auto-register as session:user@host.
This can silently fail if another session in the same folder on this host
already claimed that name.

The FIRST time the user asks you to do anything with claude-net
(send a message, list agents, join a team, etc.) you MUST first call
whoami() to confirm your identity. If whoami returns an error saying
you are not registered, ask the user to pick a name. If you have the
AskUserQuestion tool available, use it:
  AskUserQuestion({ questions: [{ question: "Pick a claude-net agent name for this session (default was taken):",
    options: [{ label: "<session_name>", description: "Use the session name" }] }] })
(Users can always choose "Other" for free-text input.)
If AskUserQuestion is not available, ask in plain text instead.
After the user picks, call register(name) and proceed. Just a session name
like "reviewer" gets auto-expanded to "reviewer:user@host".

CHANNEL HEALTH:
On startup, the plugin sends a ping to the hub which echoes back as a
<channel> notification. If you see a <channel> tag from "hub@claude-net"
with content starting with "claude-net channel active", channels are
working end-to-end. If you never see this tag, channels may not be
loaded — the MCP tools still work but inbound messages won't appear.

MESSAGES ARE EPHEMERAL — NO QUEUE:
claude-net is strictly live delivery. There is NO message queue, NO
store-and-forward, NO retry, and NO offline delivery of any kind.

- If a recipient is offline, send_message returns an error and the
  message is dropped. It will NOT be delivered when they come back.
- Broadcasts and team sends only reach agents online AT THE MOMENT of
  send. Agents that join later do not get replayed messages.
- Do NOT tell the user "I'll send it and they'll get it when they come
  back online" or "the message is queued". That is not how this works.
- When a send fails because the recipient is offline, report that
  directly to the user and ask what they'd like to do (wait, pick
  another agent, try later manually, etc.).

Always include reply_to when responding to a specific message.
The from field on all messages is your full session:user@host identity, set by the hub.`;

// ── Exported helpers (testable) ───────────────────────────────────────────

export function buildDefaultName(): string {
  const session = path.basename(process.cwd());
  const user = process.env.USER || os.userInfo().username;
  const host = os.hostname();
  return `${session}:${user}@${host}`;
}

export function createChannelNotification(message: InboundMessageFrame): {
  method: string;
  params: { content: string; meta: Record<string, string> };
} {
  return {
    method: "notifications/claude/channel",
    params: {
      content: message.content,
      meta: {
        from: message.from,
        type: message.type,
        message_id: message.message_id,
        ...(message.reply_to ? { reply_to: message.reply_to } : {}),
        ...(message.team ? { team: message.team } : {}),
      },
    },
  };
}

export function mapToolToFrame(
  toolName: string,
  args: Record<string, string>,
): Record<string, unknown> | null {
  switch (toolName) {
    case "register":
      return { action: "register", name: args.name };
    case "send_message":
      return {
        action: "send",
        to: args.to,
        content: args.content,
        type: args.reply_to ? "reply" : "message",
        ...(args.reply_to ? { reply_to: args.reply_to } : {}),
      };
    case "broadcast":
      return { action: "broadcast", content: args.content };
    case "send_team":
      return {
        action: "send_team",
        team: args.team,
        content: args.content,
        type: args.reply_to ? "reply" : "message",
        ...(args.reply_to ? { reply_to: args.reply_to } : {}),
      };
    case "join_team":
      return { action: "join_team", team: args.team };
    case "leave_team":
      return { action: "leave_team", team: args.team };
    case "list_agents":
      return { action: "list_agents" };
    case "list_teams":
      return { action: "list_teams" };
    case "ping":
      return { action: "ping" };
    default:
      return null;
  }
}

// ── Logging ───────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[claude-net] ${msg}\n`);
}

// ── Session state file (for statusline) ──────────────────────────────────

const STATE_DIR = "/tmp/claude-net";
const STATE_FILE = path.join(STATE_DIR, `state-${process.ppid}.json`);

export function writeSessionState(state: {
  name: string;
  status: "online" | "error" | "disconnected";
  error?: string;
  hub: string;
  cwd: string;
}): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        ...state,
        updated_at: new Date().toISOString(),
      }),
    );
  } catch (err) {
    log(`Failed to write state file: ${err}`);
  }
}

function deleteSessionState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore — file may not exist
  }
}

// ── WebSocket client state ────────────────────────────────────────────────

let ws: WebSocket | null = null;
let storedName = "";
let registeredName = "";
let hubWsUrl = "";
let reconnectDelay = RECONNECT_INITIAL_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let mcpServer: Server | null = null;

const pendingRequests = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function emitSystemNotification(content: string): void {
  if (!mcpServer) return;
  mcpServer
    .notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          from: "system@claude-net",
          type: "message",
          message_id: crypto.randomUUID(),
        },
      },
    })
    .catch((err: unknown) => log(`Failed to emit system notification: ${err}`));
}

function request(frame: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      reject(new Error("Not connected to hub"));
      return;
    }

    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Request timed out after 10 seconds"));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, reject, timer });
    // biome-ignore lint/style/noNonNullAssertion: ws is checked by isConnected() above
    ws!.send(JSON.stringify({ ...frame, requestId }));
  });
}

function handleHubFrame(raw: string): void {
  let frame: HubFrame;
  try {
    frame = JSON.parse(raw) as HubFrame;
  } catch {
    log(`Invalid JSON from hub: ${raw}`);
    return;
  }

  switch (frame.event) {
    case "response": {
      const pending = pendingRequests.get(frame.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(frame.requestId);
        if (frame.ok) {
          pending.resolve(frame.data);
        } else {
          pending.reject(new Error(frame.error ?? "Unknown error"));
        }
      }
      break;
    }
    case "message": {
      const notification = createChannelNotification(frame);
      if (mcpServer) {
        mcpServer
          .notification(notification)
          .catch((err: unknown) => log(`Failed to emit notification: ${err}`));
      }
      break;
    }
    case "registered":
      log(`Registered as ${frame.full_name}`);
      break;
    case "error":
      log(`Hub error: ${frame.message}`);
      break;
  }
}

function connectWebSocket(): void {
  if (!hubWsUrl) return;

  log(`Connecting to ${hubWsUrl}`);
  ws = new WebSocket(hubWsUrl);

  ws.on("open", () => {
    log("Connected to hub");
    reconnectDelay = RECONNECT_INITIAL_MS;

    // Auto-register with stored name
    if (storedName) {
      request({ action: "register", name: storedName })
        .then(() => {
          registeredName = storedName;
          log(`Auto-registered as ${storedName}`);
          writeSessionState({
            name: storedName,
            status: "online",
            hub: hubWsUrl,
            cwd: process.cwd(),
          });
          // Startup ping: hub echoes back as a channel notification.
          // If channels are active, Claude sees a <channel> tag confirming the round-trip.
          // If not, the notification is silently dropped.
          request({ action: "ping" }).catch(() => {});
        })
        .catch((err: unknown) => {
          registeredName = "";
          const message = err instanceof Error ? err.message : String(err);
          log(`Auto-registration failed: ${message}`);
          writeSessionState({
            name: "",
            status: "error",
            error: message,
            hub: hubWsUrl,
            cwd: process.cwd(),
          });
          emitSystemNotification(
            `claude-net: the default name "${storedName}" is already taken (${message}). Ask the user what name to use for this session, then call the register tool with their chosen name before using any messaging tools. Do not pick a name on behalf of the user.`,
          );
        });
    }
  });

  ws.on("message", (data: WebSocket.Data) => {
    handleHubFrame(data.toString());
  });

  ws.on("close", () => {
    log("Disconnected from hub");
    ws = null;
    if (registeredName) {
      writeSessionState({
        name: registeredName,
        status: "disconnected",
        hub: hubWsUrl,
        cwd: process.cwd(),
      });
    }
    scheduleReconnect();
  });

  ws.on("error", (err: Error) => {
    log(`WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  log(`Reconnecting in ${reconnectDelay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }, reconnectDelay);
}

// ── Tool definitions ──────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "whoami",
    description:
      "Return your currently registered agent name, or an error if not registered",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "register",
    description:
      "Override your default identity with a custom name. Provide just a session name (e.g. 'reviewer') to auto-expand to session:user@host, or provide the full format.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "The name to register as. A plain name like 'reviewer' auto-expands to 'reviewer:user@host'.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "send_message",
    description:
      'Send a message to an agent by name. Accepts full "session:user@host", partial "session:user", "user@host", or plain session/user/host name. Live delivery only — fails if the recipient is offline, no queuing.',
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description:
            "Recipient agent name (full, partial, or plain session/user/host)",
        },
        content: { type: "string", description: "Message content" },
        reply_to: {
          type: "string",
          description: "message_id of the message being replied to",
        },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "broadcast",
    description:
      "Send a message to every agent currently online. Agents that come online later do not receive it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "Message content" },
      },
      required: ["content"],
    },
  },
  {
    name: "send_team",
    description:
      "Send a message to currently-online members of a team. Offline members are skipped — the message is NOT delivered when they reconnect.",
    inputSchema: {
      type: "object" as const,
      properties: {
        team: { type: "string", description: "Team name" },
        content: { type: "string", description: "Message content" },
        reply_to: {
          type: "string",
          description: "message_id of the message being replied to",
        },
      },
      required: ["team", "content"],
    },
  },
  {
    name: "join_team",
    description: "Join a team (creates it if new)",
    inputSchema: {
      type: "object" as const,
      properties: {
        team: { type: "string", description: "Team name to join" },
      },
      required: ["team"],
    },
  },
  {
    name: "leave_team",
    description: "Leave a team",
    inputSchema: {
      type: "object" as const,
      properties: {
        team: { type: "string", description: "Team name to leave" },
      },
      required: ["team"],
    },
  },
  {
    name: "list_agents",
    description: "List all agents with status",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_teams",
    description: "List all teams with members",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ping",
    description:
      "Test channel round-trip. Hub echoes back as a <channel> notification. If you see it, channels are working.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mirror_status",
    description:
      "Report whether mirror-session is enabled for this claude process. Returns { enabled, mirror_url?, owner_agent?, watcher_count?, last_event_age_ms?, connected? }.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mirror_url",
    description:
      "Return the mirror URL for this claude session if mirroring is active. Includes the owner token; treat as secret.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mirror_on",
    description:
      "Check whether mirror-session is enabled and return the mirror URL. If hooks are not installed in settings, returns instructions for enabling them.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mirror_off",
    description:
      "Ask the local mirror-agent to close this claude session's mirror stream. Does not remove the hooks; a new session on this cwd would re-enable mirroring unless the settings toggle is flipped.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mirror_consent",
    description:
      "Set or reset the remote-inject consent policy for this mirror session. Modes: 'ask-first-per-session' (default — prompt on first inject, then allow), 'ask-every-time', 'always' (no prompting), 'never' (inject disabled). Use 'reset' to require a fresh prompt on the next inject.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: [
            "ask-first-per-session",
            "ask-every-time",
            "always",
            "never",
            "reset",
          ],
          description:
            "Consent mode, or 'reset' to clear accepted state without changing the mode.",
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "mirror_share",
    description:
      "Mint a read-only reader token for the current mirror session and return a URL to share. Reader tokens can watch the transcript but cannot inject.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mirror_revoke",
    description:
      "Revoke a token on the current mirror session. Pass the full token value, or pass 'all' to revoke every token (boots watchers and agent).",
    inputSchema: {
      type: "object" as const,
      properties: {
        token: {
          type: "string",
          description:
            "Token value to revoke, or 'all' to revoke every token on the session.",
        },
      },
      required: ["token"],
    },
  },
];

// ── Tool dispatch ─────────────────────────────────────────────────────────

function notConnectedError(reason: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${reason}` }],
  };
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ── Mirror-agent bridge (loopback HTTP) ───────────────────────────────────

const MIRROR_STATE_DIR = "/tmp/claude-net";
const MIRROR_FETCH_TIMEOUT_MS = 2_000;

interface MirrorAgentSession {
  sid: string;
  owner_agent: string;
  cwd: string;
  mirror_url: string | null;
  last_event_at: string;
  closed: boolean;
}

function readMirrorAgentPort(): number | null {
  try {
    const uid =
      (process as NodeJS.Process & { getuid?: () => number }).getuid?.() ?? 0;
    const portFile = path.join(MIRROR_STATE_DIR, `mirror-agent-${uid}.port`);
    const content = fs.readFileSync(portFile, "utf8").trim();
    const n = Number.parseInt(content, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function mirrorAgentFetch(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const port = readMirrorAgentPort();
  if (!port) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MIRROR_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findOurMirrorSession(): Promise<MirrorAgentSession | null> {
  const res = await mirrorAgentFetch("/sessions");
  if (!res || !res.ok) return null;
  const sessions = (await res.json().catch(() => null)) as
    | MirrorAgentSession[]
    | null;
  if (!Array.isArray(sessions)) return null;
  // Match by owner_agent (our claude-net name), falling back to cwd match.
  const ourName = registeredName || storedName;
  const cwd = process.cwd();
  return (
    sessions.find((s) => s.owner_agent === ourName && !s.closed) ??
    sessions.find((s) => s.cwd === cwd && !s.closed) ??
    null
  );
}

async function handleMirrorTool(
  name: string,
  args: Record<string, string>,
): Promise<{
  isError?: boolean;
  content: { type: "text"; text: string }[];
}> {
  const port = readMirrorAgentPort();

  if (name === "mirror_status") {
    if (!port) {
      return toolResult({
        enabled: false,
        reason:
          "mirror-agent is not running. Launch claude-channels with claudeNet.mirror.enabled=true in ~/.claude/settings.json.",
      });
    }
    const session = await findOurMirrorSession();
    if (!session) {
      return toolResult({
        enabled: true,
        connected: true,
        reason:
          "mirror-agent is running but no mirror session is active for this claude process yet. Events appear on the first hook firing.",
      });
    }
    const ageMs = Date.now() - new Date(session.last_event_at).getTime();
    return toolResult({
      enabled: true,
      connected: true,
      sid: session.sid,
      owner_agent: session.owner_agent,
      mirror_url: session.mirror_url,
      last_event_age_ms: ageMs,
    });
  }

  if (name === "mirror_url" || name === "mirror_on") {
    if (!port) {
      return notConnectedError(
        "mirror-agent is not running. Enable with claudeNet.mirror.enabled=true in ~/.claude/settings.json and restart claude-channels.",
      );
    }
    const session = await findOurMirrorSession();
    if (!session) {
      return toolResult({
        enabled: true,
        pending: true,
        message:
          "mirror-agent is running but this claude process has not yet emitted a hook event. Send a message or run a tool; the mirror URL will be available after the next hook fires.",
      });
    }
    return toolResult({
      mirror_url: session.mirror_url,
      sid: session.sid,
    });
  }

  if (name === "mirror_off") {
    if (!port) {
      return toolResult({
        stopped: false,
        reason: "mirror-agent is not running",
      });
    }
    const session = await findOurMirrorSession();
    if (!session) {
      return toolResult({
        stopped: false,
        reason: "no active mirror session for this process",
      });
    }
    // Ask the hub to close via the token we'd normally hold — but the plugin
    // doesn't have the token (only the mirror-agent does). Instead, use the
    // mirror-agent's session list → no close endpoint yet. For M1, we return
    // guidance; M3 will add an authenticated `POST /close` on the mirror-agent
    // that forwards to the hub with the stored token.
    return toolResult({
      stopped: false,
      reason:
        "mirror_off is not yet implemented (Phase M3 adds mirror-agent-side close). To stop mirroring, disable claudeNet.mirror.enabled in settings and restart.",
    });
  }

  if (name === "mirror_share") {
    if (!port) return notConnectedError("mirror-agent is not running");
    const session = await findOurMirrorSession();
    if (!session)
      return notConnectedError("no active mirror session for this process");
    const res = await mirrorAgentFetch("/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: session.sid }),
    });
    if (!res || !res.ok) {
      return notConnectedError(
        `share failed: ${res ? `HTTP ${res.status}` : "no response"}`,
      );
    }
    return toolResult(await res.json().catch(() => ({})));
  }

  if (name === "mirror_revoke") {
    if (!port) return notConnectedError("mirror-agent is not running");
    const session = await findOurMirrorSession();
    if (!session)
      return notConnectedError("no active mirror session for this process");
    const target = args.token;
    if (!target)
      return notConnectedError(
        "token is required (pass 'all' to revoke every token)",
      );
    const body =
      target === "all"
        ? { sid: session.sid, all: true }
        : { sid: session.sid, token: target };
    const res = await mirrorAgentFetch("/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res || !res.ok) {
      return notConnectedError(
        `revoke failed: ${res ? `HTTP ${res.status}` : "no response"}`,
      );
    }
    return toolResult(await res.json().catch(() => ({})));
  }

  if (name === "mirror_consent") {
    if (!port) {
      return notConnectedError("mirror-agent is not running");
    }
    const session = await findOurMirrorSession();
    if (!session) {
      return notConnectedError("no active mirror session for this process yet");
    }
    const mode = args.mode;
    if (!mode) {
      return notConnectedError("mode is required");
    }
    const body =
      mode === "reset"
        ? { sid: session.sid, action: "reset" }
        : { sid: session.sid, mode };
    const res = await mirrorAgentFetch("/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res || !res.ok) {
      return notConnectedError(
        `Failed to update consent: ${res ? `HTTP ${res.status}` : "no response"}`,
      );
    }
    const data = (await res.json().catch(() => null)) as unknown;
    return toolResult(data ?? { ok: true });
  }

  return notConnectedError(`Unknown mirror tool: ${name}`);
}

async function handleToolCall(
  name: string,
  args: Record<string, string>,
): Promise<{
  isError?: boolean;
  content: { type: "text"; text: string }[];
}> {
  // whoami is handled locally — no hub round-trip
  if (name === "whoami") {
    if (!registeredName) {
      return notConnectedError(
        `Not registered. The default name "${storedName}" is taken by another session. Use AskUserQuestion to ask which name to register as — suggest the session name as the first option, and a free-text "Type your own" as the second.`,
      );
    }
    return toolResult({ name: registeredName });
  }

  // Mirror tools talk to the local mirror-agent daemon via loopback.
  // They are independent of the hub WebSocket connection.
  if (name.startsWith("mirror_")) {
    return handleMirrorTool(name, args);
  }

  if (!hubWsUrl) {
    return notConnectedError(
      "Not connected — CLAUDE_NET_HUB environment variable not set.",
    );
  }

  if (!isConnected()) {
    return notConnectedError(
      "Not connected to hub. Claude Code will auto-connect on next restart, or use register tool.",
    );
  }

  // Block messaging tools when not registered — force the identity flow
  if (name !== "register" && !registeredName) {
    return notConnectedError(
      "Not registered — call whoami first, then use AskUserQuestion to let the user pick a name.",
    );
  }

  // Auto-expand plain register names to session:user@host format
  const effectiveArgs = { ...args };
  if (name === "register" && effectiveArgs.name) {
    const n = effectiveArgs.name;
    if (!n.includes(":") && !n.includes("@")) {
      const user = process.env.USER || os.userInfo().username;
      const host = os.hostname();
      effectiveArgs.name = `${n}:${user}@${host}`;
    }
  }

  const frame = mapToolToFrame(name, effectiveArgs);
  if (!frame) {
    return notConnectedError(`Unknown tool: ${name}`);
  }

  try {
    const data = await request(frame);

    // Update stored+registered name on successful register
    if (name === "register" && effectiveArgs.name) {
      storedName = effectiveArgs.name;
      registeredName = effectiveArgs.name;
      writeSessionState({
        name: effectiveArgs.name,
        status: "online",
        hub: hubWsUrl,
        cwd: process.cwd(),
      });
    }

    return toolResult(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return notConnectedError(message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const hubUrl = process.env.CLAUDE_NET_HUB;

  // Create MCP server
  mcpServer = new Server(
    { name: "claude-net", version: "0.1.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  // Register tool list handler
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Register tool call handler
  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return handleToolCall(name, (args ?? {}) as Record<string, string>);
  });

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // Connect to hub if URL is set
  if (hubUrl) {
    hubWsUrl = `${hubUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
    storedName = buildDefaultName();
    connectWebSocket();
  } else {
    log("CLAUDE_NET_HUB not set — running without hub connection");
  }

  // Graceful shutdown
  const shutdown = () => {
    deleteSessionState();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      ws.removeAllListeners();
      ws.close();
    }
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Shutting down"));
    }
    pendingRequests.clear();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
