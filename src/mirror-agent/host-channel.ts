// Long-lived daemon → hub WebSocket at /ws/host.
//
// Distinct from the per-session /ws/mirror/:sid sockets. Identifies
// this host on the hub so the dashboard can group sessions by host
// and expose per-host RPCs (ls / mkdir / launch — wired in Phase B).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HostRegisterFrame } from "@/shared/types";
import { HubClient } from "./hub-client";

export interface HostChannelOptions {
  hubUrl: string;
  /** Provides the last-N cwds from active/recent sessions for the popover. */
  getRecentCwds: () => string[];
}

/**
 * Read `claudeNet.workspaces` + `claudeNet.launch` from the user's
 * ~/.claude/settings.json, filling in defaults. Fails soft — a missing
 * or unparseable file just yields the defaults.
 */
export function loadHostConfig(): {
  roots: string[];
  allowDangerousSkip: boolean;
} {
  const defaults = {
    roots: [path.join(os.homedir(), "projects")],
    allowDangerousSkip: true,
  };
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return defaults;
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      claudeNet?: {
        workspaces?: { roots?: string[] };
        launch?: { allow_dangerous_skip?: boolean };
      };
    };
    const roots = parsed.claudeNet?.workspaces?.roots;
    const allowSkip = parsed.claudeNet?.launch?.allow_dangerous_skip;
    return {
      roots:
        Array.isArray(roots) && roots.length > 0
          ? roots.map((r) => expandHome(r))
          : defaults.roots,
      allowDangerousSkip:
        typeof allowSkip === "boolean"
          ? allowSkip
          : defaults.allowDangerousSkip,
    };
  } catch {
    return defaults;
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function deriveHostId(): string {
  const user = os.userInfo().username || process.env.USER || "user";
  const host = os.hostname() || "host";
  return `${user}@${host}`;
}

export interface HostChannelHandle {
  stop(): void;
  /** Expose the loaded roots so other RPC handlers (Phase B) can reuse them. */
  getRoots(): string[];
}

export function startHostChannel(opts: HostChannelOptions): HostChannelHandle {
  const { roots, allowDangerousSkip } = loadHostConfig();
  const hostId = deriveHostId();
  const wsBase = opts.hubUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/+$/, "");

  const client = new HubClient({
    url: `${wsBase}/ws/host`,
    logPrefix: "claude-net/host",
    onOpen: () => {
      const frame: HostRegisterFrame = {
        action: "host_register",
        host_id: hostId,
        user: os.userInfo().username || process.env.USER || "user",
        hostname: os.hostname() || "host",
        home: os.homedir(),
        recent_cwds: opts.getRecentCwds().slice(0, 20),
        allow_dangerous_skip: allowDangerousSkip,
      };
      client.send(JSON.stringify(frame));
    },
    onMessage: (_raw) => {
      // Phase B will handle inbound host_ls / host_mkdir / host_launch
      // frames. Phase A ignores everything the hub sends back except
      // acknowledgement (which we treat as advisory).
    },
  });
  client.start();

  return {
    stop: () => client.stop(),
    getRoots: () => roots,
  };
}
