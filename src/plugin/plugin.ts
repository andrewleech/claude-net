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
const MAX_AUTO_REGISTER_ATTEMPTS = 9; // tries base, base-2, …, base-9

// Single source of truth for the plugin version. Consumed by both the
// MCP `Server({ version })` declaration below AND the register frame
// that reports `plugin_version` to the hub. Must stay in lockstep
// with the hub's `PLUGIN_VERSION_CURRENT` — which is sourced from
// package.json — since the /plugin.ts bundle is served by the hub.
// When bumping the version: change package.json AND this constant.
export const PLUGIN_VERSION = "0.1.0";

export const INSTRUCTIONS = `claude-net agent messaging plugin.

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
- hub_events(filter?, since_minutes?, limit?, agent?) — query recent hub events. Use to diagnose delivery failures: e.g. filter="message.sent" agent="recipient-name" since_minutes=5

IDENTITY AND REGISTRATION:
On startup the plugin auto-registers as session:user@host. If that
default name is taken (e.g. a second Claude Code session opened in the
same folder — fork-session), the plugin automatically picks a distinct
suffix: session-2:user@host, session-3:user@host, and so on up to -9.
So concurrent sessions in one folder each get a visible unique identity
without user input.

The FIRST time the user asks you to do anything with claude-net
(send a message, list agents, join a team, etc.) call whoami() to
confirm your identity. Only if whoami returns an error saying you are
not registered (very rare — every default and -2…-9 suffix was taken)
should you ask the user to pick a name. If you have the AskUserQuestion
tool available, use it:
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

If channels aren't enabled on your Claude Code binary, you will receive
a one-time notice on your first tool call and will not be able to
receive messages from other agents. You can still send. Ask the user to
run \`install-channels\` on this host to enable inbound delivery.

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

// ── Exported stateless helpers (testable) ────────────────────────────────

/**
 * Inspect an MCP client's advertised capabilities and decide whether the
 * experimental `claude/channel` hook is supported. Accepts any truthy
 * value for `experimental["claude/channel"]` — Claude Code currently
 * sends `{}`, but a boolean `true` or any other truthy shape would
 * also count as "supported". Exported for unit testability; the
 * plugin's `oninitialized` callback calls this internally.
 */
export function detectChannelCapability(
  capabilities: { experimental?: Record<string, unknown> } | undefined | null,
): boolean {
  return !!capabilities?.experimental?.["claude/channel"];
}

/**
 * Build the one-shot LLM nudge shown when the plugin detects that
 * Claude Code does not advertise channel support. The text rides on
 * the next tool result's content — it must NOT use
 * `emitSystemNotification` because MCP notifications are the exact
 * channel that's broken on a channels-off client.
 */
export function buildChannelsOffNudge(): string {
  return "claude-net: this Claude Code binary does not advertise experimental channels. Inbound messages from other agents will not be delivered to this session (outbound tools still work). Ask the user to run `install-channels` on this host, then restart Claude Code. This notice only fires once.";
}

export function buildDefaultName(): string {
  const session = path.basename(process.cwd());
  const user = process.env.USER || os.userInfo().username;
  const host = os.hostname();
  return `${session}:${user}@${host}`;
}

/**
 * Insert a `-N` suffix into the session portion of a `session:user@host`
 * name. Used when the default name collides — e.g. a second Claude Code
 * session opened in the same folder (fork-session) — so each session ends
 * up with a distinct, visible identity.
 */
export function withSessionSuffix(fullName: string, n: number): string {
  const colon = fullName.indexOf(":");
  if (colon === -1) return `${fullName}-${n}`;
  return `${fullName.slice(0, colon)}-${n}${fullName.slice(colon)}`;
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

// ── Tool definitions ──────────────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
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
      'Send a message to an agent by name. Accepts full "session:user@host", partial "session:user", "user@host", or plain session/user/host name. Live delivery only — fails if the recipient is offline, no queuing. Returns an error with a `reason` field (`offline` / `no-channel` / `unknown` / `no-dashboard`) if delivery cannot be confirmed.',
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
    name: "hub_events",
    description:
      "Query recent hub events — agent connections/disconnections, message delivery outcomes, evictions, version mismatches. Use when diagnosing delivery failures or checking system health.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: {
          type: "string",
          description:
            "Prefix-filter by event name. 'agent' matches agent.registered, agent.disconnected, etc. 'message' matches message.sent, message.broadcast, etc.",
        },
        since_minutes: {
          type: "number",
          description:
            "Only return events from the last N minutes (default 60).",
        },
        limit: {
          type: "number",
          description: "Max events to return (default 100, max 1000).",
        },
        agent: {
          type: "string",
          description:
            "Substring filter on agent name (from/to/fullName fields).",
        },
      },
      required: [],
    },
  },
];

// ── Plugin class ─────────────────────────────────────────────────────────
//
// All mutable runtime state lives on an instance of this class. Keeping
// state on a single object instead of module-scope `let`s means
// subsystems (connection, identity, MCP lifecycle, nudge queue) can be
// reasoned about together, tests can set state explicitly without
// backdoor exports, and previously-hidden dependencies (e.g.
// `mapToolToFrame` reading `channelCapable`) become explicit
// `this.x` references.

interface PendingNudge {
  text: string;
  guard?: () => boolean;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

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

export class Plugin {
  // ── Connection ───────────────────────────
  private ws: WebSocket | null = null;
  private hubWsUrl = "";
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  // ── Identity ─────────────────────────────
  // storedName is the last-attempted name; registeredName is only set
  // once the hub confirms a successful register. Tests read
  // registeredName through the guarded nudge queue.
  private storedName = "";
  registeredName = "";

  // ── MCP lifecycle ────────────────────────
  // channelCapable is public so tests can pin it and mapToolToFrame
  // can reference it without a hidden module-scope read.
  private mcpServer: Server | null = null;
  private mcpInitialized = false;
  channelCapable = false;

  // ── One-shot nudge queue ─────────────────
  // Public & readonly-as-a-reference so tests and external callers can
  // push() into it but not reassign. The array is drained by
  // drainNudges() on every tool result.
  readonly pendingNudges: PendingNudge[] = [];

  constructor(private readonly hubEnvUrl: string | undefined) {}

  // ── Stateless-on-instance helpers ────────

  private isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Map an MCP tool call to the WebSocket frame the hub expects. Reads
   * this.channelCapable explicitly rather than through a hidden
   * module-scope closure — previously `mapToolToFrame` looked pure
   * but silently depended on the initialize handshake having run.
   */
  mapToolToFrame(
    toolName: string,
    args: Record<string, string>,
  ): Record<string, unknown> | null {
    switch (toolName) {
      case "register":
        return {
          action: "register",
          name: args.name,
          channel_capable: this.channelCapable,
          plugin_version: PLUGIN_VERSION,
        };
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
      case "hub_events": {
        const sinceMinutes = args.since_minutes
          ? Number(args.since_minutes)
          : 60;
        return {
          action: "query_events",
          ...(args.filter ? { event: args.filter } : {}),
          since: Date.now() - sinceMinutes * 60_000,
          ...(args.limit ? { limit: Number(args.limit) } : {}),
          ...(args.agent ? { agent: args.agent } : {}),
        };
      }
      default:
        return null;
    }
  }

  /**
   * Drain all ready nudges into a tool result's content array. Entries
   * whose `guard` returns false are left in the queue; entries with no
   * guard or a truthy guard are appended and removed.
   */
  drainNudges<T extends { content: { type: "text"; text: string }[] }>(
    result: T,
  ): T {
    const kept: PendingNudge[] = [];
    for (const nudge of this.pendingNudges) {
      if (nudge.guard && !nudge.guard()) {
        kept.push(nudge);
      } else {
        result.content.push({ type: "text", text: nudge.text });
      }
    }
    this.pendingNudges.length = 0;
    this.pendingNudges.push(...kept);
    return result;
  }

  // ── Inbound MCP tool calls ───────────────

  async handleToolCall(
    name: string,
    args: Record<string, string>,
  ): Promise<{
    isError?: boolean;
    content: { type: "text"; text: string }[];
  }> {
    // whoami is handled locally — no hub round-trip
    if (name === "whoami") {
      if (!this.registeredName) {
        return notConnectedError(
          `Not registered. The default name "${this.storedName}" is taken by another session. Use AskUserQuestion to ask which name to register as — suggest the session name as the first option, and a free-text "Type your own" as the second.`,
        );
      }
      return this.drainNudges(
        toolResult({
          name: this.registeredName,
          channel_capable: this.channelCapable,
        }),
      );
    }

    if (!this.hubWsUrl) {
      return notConnectedError(
        "Not connected — CLAUDE_NET_HUB environment variable not set.",
      );
    }

    if (!this.isConnected()) {
      return notConnectedError(
        "Not connected to hub. Claude Code will auto-connect on next restart, or use register tool.",
      );
    }

    // Block messaging tools when not registered — force the identity flow
    if (name !== "register" && !this.registeredName) {
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

    const frame = this.mapToolToFrame(name, effectiveArgs);
    if (!frame) {
      return notConnectedError(`Unknown tool: ${name}`);
    }

    try {
      const data = await this.request(frame);

      // Update stored+registered name on successful register.
      // A manual register cancels any pending rename nudge — the user has
      // already chosen a name, so we don't want to prompt them again.
      if (name === "register" && effectiveArgs.name) {
        this.storedName = effectiveArgs.name;
        this.registeredName = effectiveArgs.name;
        // Clear any pending rename nudge — user explicitly chose a name.
        const renameIdx = this.pendingNudges.findIndex(
          (n) => n.guard && n.text.startsWith("Rename suggestion:"),
        );
        if (renameIdx !== -1) this.pendingNudges.splice(renameIdx, 1);
        writeSessionState({
          name: effectiveArgs.name,
          status: "online",
          hub: this.hubWsUrl,
          cwd: process.cwd(),
        });
      }

      return this.drainNudges(toolResult(data));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return notConnectedError(message);
    }
  }

  // ── Outbound WS requests / hub frame dispatch ────

  private emitSystemNotification(content: string): void {
    if (!this.mcpServer) return;
    this.mcpServer
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
      .catch((err: unknown) =>
        log(`Failed to emit system notification: ${err}`),
      );
  }

  private request(frame: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error("Not connected to hub"));
        return;
      }

      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("Request timed out after 10 seconds"));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      // biome-ignore lint/style/noNonNullAssertion: ws is checked by isConnected() above
      this.ws!.send(JSON.stringify({ ...frame, requestId }));
    });
  }

  private handleHubFrame(raw: string): void {
    let frame: HubFrame;
    try {
      frame = JSON.parse(raw) as HubFrame;
    } catch {
      log(`Invalid JSON from hub: ${raw}`);
      return;
    }

    switch (frame.event) {
      case "response": {
        const pending = this.pendingRequests.get(frame.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(frame.requestId);
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
        if (this.mcpServer) {
          this.mcpServer
            .notification(notification)
            .catch((err: unknown) =>
              log(`Failed to emit notification: ${err}`),
            );
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

  private async autoRegisterWithRetry(baseName: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_AUTO_REGISTER_ATTEMPTS; attempt++) {
      const candidate =
        attempt === 0 ? baseName : withSessionSuffix(baseName, attempt + 1);
      try {
        const data = (await this.request({
          action: "register",
          name: candidate,
          channel_capable: this.channelCapable,
          plugin_version: PLUGIN_VERSION,
        })) as { upgrade_hint?: string } | undefined;
        // The hub returns `upgrade_hint` in the register response
        // data when our plugin_version doesn't match its PLUGIN_VERSION_CURRENT.
        // Store it for one-shot surfacing on the next tool result.
        if (data && typeof data.upgrade_hint === "string") {
          this.pendingNudges.push({ text: data.upgrade_hint });
        }
        this.storedName = candidate;
        this.registeredName = candidate;
        if (attempt > 0) {
          this.pendingNudges.push({
            text: `Rename suggestion: the default claude-net name "${baseName}" was already taken, so this session was auto-registered as "${candidate}". Before doing more claude-net work, please ask the user whether they would like a more meaningful name for this session (e.g. reviewer, tester, fork-a). If yes, call register(<name>) with their choice. If no, keep the current name and carry on. This notice only fires once.`,
            guard: () => !!this.registeredName,
          });
        }
        log(
          attempt === 0
            ? `Auto-registered as ${candidate}`
            : `Auto-registered as ${candidate} (base "${baseName}" was taken)`,
        );
        writeSessionState({
          name: candidate,
          status: "online",
          hub: this.hubWsUrl,
          cwd: process.cwd(),
        });
        this.request({ action: "ping" }).catch(() => {});
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isCollision = /already registered/i.test(message);
        if (!isCollision || attempt === MAX_AUTO_REGISTER_ATTEMPTS - 1) {
          this.registeredName = "";
          log(
            `Auto-registration failed after ${attempt + 1} attempt(s): ${message}`,
          );
          writeSessionState({
            name: "",
            status: "error",
            error: message,
            hub: this.hubWsUrl,
            cwd: process.cwd(),
          });
          this.emitSystemNotification(
            `claude-net: could not auto-register (tried ${candidate} and earlier suffixes; last error: ${message}). Ask the user what name to use for this session, then call the register tool with their chosen name before using any messaging tools.`,
          );
          return;
        }
        log(`Name "${candidate}" taken; trying next suffix`);
      }
    }
  }

  /**
   * Send the initial auto-register frame iff BOTH preconditions hold:
   *   (a) MCP `initialize` has completed, so `channelCapable` is the real
   *       value rather than the `false` default.
   *   (b) The hub WebSocket is open, so the frame can actually be sent.
   *
   * Called by both the WS `open` handler and the MCP `oninitialized`
   * callback. Whichever fires second triggers the register. If the WS
   * drops between the two events we just wait for the reconnect `open`
   * to call us again — `mcpInitialized` stays true across reconnects.
   */
  private maybeSendRegister(): void {
    if (!this.mcpInitialized) return;
    if (!this.isConnected()) return;
    if (!this.storedName) return;
    this.autoRegisterWithRetry(this.storedName).catch(() => {
      // Already handled (notification + state write) inside the helper.
    });
  }

  private connectWebSocket(): void {
    if (!this.hubWsUrl) return;

    log(`Connecting to ${this.hubWsUrl}`);
    this.ws = new WebSocket(this.hubWsUrl);

    this.ws.on("open", () => {
      log("Connected to hub");
      this.reconnectDelay = RECONNECT_INITIAL_MS;

      // Defer register until MCP `initialize` has completed — otherwise
      // `channel_capable` on the wire would be the `false` default and
      // the hub would store a permanently-stale value for this agent.
      this.maybeSendRegister();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.handleHubFrame(data.toString());
    });

    this.ws.on("close", () => {
      log("Disconnected from hub");
      this.ws = null;
      if (this.registeredName) {
        writeSessionState({
          name: this.registeredName,
          status: "disconnected",
          hub: this.hubWsUrl,
          cwd: process.cwd(),
        });
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      log(`WebSocket error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    log(`Reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    }, this.reconnectDelay);
  }

  // ── Lifecycle ────────────────────────────

  /**
   * Create the MCP server, wire handlers, connect the stdio transport,
   * and if CLAUDE_NET_HUB was provided, open the hub WebSocket. The
   * register frame is deferred until BOTH the MCP initialize handshake
   * has completed AND the WebSocket is open (see maybeSendRegister).
   */
  async start(): Promise<void> {
    this.mcpServer = new Server(
      { name: "claude-net", version: PLUGIN_VERSION },
      {
        capabilities: {
          experimental: { "claude/channel": {} },
          tools: {},
        },
        instructions: INSTRUCTIONS,
      },
    );

    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS,
    }));

    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      return this.handleToolCall(name, (args ?? {}) as Record<string, string>);
    });

    // Wire the initialize-complete hook BEFORE connecting the transport.
    // Once `initialize` is exchanged the MCP SDK invokes `oninitialized`
    // synchronously; attaching after `connect` would race the handshake
    // and `getClientCapabilities()` could return undefined on a fast
    // client.
    this.mcpServer.oninitialized = () => {
      const caps = this.mcpServer?.getClientCapabilities() as
        | { experimental?: Record<string, unknown> }
        | undefined;
      this.channelCapable = detectChannelCapability(caps);
      this.mcpInitialized = true;

      if (!this.channelCapable) {
        this.pendingNudges.push({ text: buildChannelsOffNudge() });
      }

      // Flush any register that was waiting on this callback.
      this.maybeSendRegister();
    };

    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);

    if (this.hubEnvUrl) {
      this.hubWsUrl = `${this.hubEnvUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
      this.storedName = buildDefaultName();
      this.connectWebSocket();
    } else {
      log("CLAUDE_NET_HUB not set — running without hub connection");
    }
  }

  shutdown(): void {
    deleteSessionState();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Shutting down"));
    }
    this.pendingRequests.clear();
    process.exit(0);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const plugin = new Plugin(process.env.CLAUDE_NET_HUB);
  await plugin.start();
  process.on("SIGINT", () => plugin.shutdown());
  process.on("SIGTERM", () => plugin.shutdown());
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
