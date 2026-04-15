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
  <channel source="claude-net" from="name@host" type="message|reply" message_id="..." reply_to="..." team="...">
    message content
  </channel>

Available tools:
- whoami() — return your current registered name, or an error if not registered
- register(name) — claim a name (required on first use if default name is taken)
- send_message(to, content, reply_to?) — send to an agent by name (full "name@host" or short "name")
- broadcast(content) — send to all online agents
- send_team(team, content, reply_to?) — send to all online members of a team
- join_team(team) — join a team (creates it if new)
- leave_team(team) — leave a team
- list_agents() — list all agents with status
- list_teams() — list all teams with members

IDENTITY AND REGISTRATION:
On startup the plugin tries to auto-register as basename(cwd)@hostname.
This can silently fail if another session in the same folder on this host
already claimed that name.

The FIRST time the user asks you to do anything with claude-net
(send a message, list agents, join a team, etc.) you MUST first call
whoami() to confirm your identity. If whoami returns an error saying
you are not registered, use the AskUserQuestion tool to ask which name
to register as. Offer these options:
  1. The current session name (if you know it from session context)
  2. A "Type your own" free-text option
Explain briefly that the default name was already taken.
After the user picks, call register(name) and proceed with their request.

Messages to offline agents will fail — there is no queuing.
Always include reply_to when responding to a specific message.
The from field on all messages is your full name@host identity, set by the hub.`;

// ── Exported helpers (testable) ───────────────────────────────────────────

export function buildDefaultName(): string {
  return `${path.basename(process.cwd())}@${os.hostname()}`;
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
    description: "Override your default identity with a custom name",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "The name to register as" },
      },
      required: ["name"],
    },
  },
  {
    name: "send_message",
    description:
      'Send a message to an agent by name (full "name@host" or short "name")',
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient agent name" },
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
    description: "Send a message to all online agents",
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
    description: "Send a message to all online members of a team",
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

  const frame = mapToolToFrame(name, args);
  if (!frame) {
    return notConnectedError(`Unknown tool: ${name}`);
  }

  try {
    const data = await request(frame);

    // Update stored+registered name on successful register
    if (name === "register" && args.name) {
      storedName = args.name;
      registeredName = args.name;
      writeSessionState({
        name: args.name,
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
