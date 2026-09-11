import { describe, expect, test } from "bun:test";
import { HostRegistry } from "@/hub/host-registry";
import { parseHostRegisterFrame } from "@/hub/ws-host";
import type { ConfigDirInfo, DashboardEvent } from "@/shared/types";

const CONFIG_DIRS: ConfigDirInfo[] = [
  { path: "/home/alice/.claude", label: "", is_default: true },
  { path: "/home/alice/.claude-work", label: "work", is_default: false },
];

function rawFrame(overrides: Record<string, unknown> = {}) {
  return {
    action: "host_register",
    host_id: "alice@box",
    user: "alice",
    hostname: "box",
    home: "/home/alice",
    recent_cwds: ["/home/alice/projects/foo"],
    allow_dangerous_skip: true,
    ...overrides,
  };
}

/**
 * parseHostRegisterFrame rebuilds the daemon's payload field by field,
 * so a field with no line of its own is silently dropped on the way to
 * the registry rather than failing loudly.
 */
describe("parseHostRegisterFrame", () => {
  test("keeps the config dirs the daemon registered with", () => {
    const parsed = parseHostRegisterFrame(
      rawFrame({ config_dirs: CONFIG_DIRS }),
    );
    expect(parsed?.config_dirs).toEqual(CONFIG_DIRS);
  });

  test("keeps every other field the daemon sent", () => {
    expect(
      parseHostRegisterFrame(rawFrame({ config_dirs: CONFIG_DIRS })),
    ).toEqual({
      action: "host_register",
      host_id: "alice@box",
      user: "alice",
      hostname: "box",
      home: "/home/alice",
      recent_cwds: ["/home/alice/projects/foo"],
      allow_dangerous_skip: true,
      config_dirs: CONFIG_DIRS,
    });
  });

  test("defaults config dirs to an empty list for a pre-rollout daemon", () => {
    expect(parseHostRegisterFrame(rawFrame())?.config_dirs).toEqual([]);
  });

  test("ignores a config_dirs value that isn't a list", () => {
    expect(
      parseHostRegisterFrame(rawFrame({ config_dirs: "/home/alice/.claude" }))
        ?.config_dirs,
    ).toEqual([]);
  });

  test("rejects a frame missing a required field", () => {
    for (const key of ["host_id", "user", "hostname", "home"]) {
      const frame = rawFrame();
      delete (frame as Record<string, unknown>)[key];
      expect(parseHostRegisterFrame(frame)).toBeNull();
    }
  });
});

describe("host registration", () => {
  test("a parsed frame carries the config dirs through to /api/hosts", () => {
    const registry = new HostRegistry();
    const frame = parseHostRegisterFrame(
      rawFrame({ config_dirs: CONFIG_DIRS }),
    );
    if (!frame) throw new Error("frame should parse");
    registry.register(frame, { wsIdentity: {}, send: () => {} });

    expect(registry.list()[0]?.config_dirs).toEqual(CONFIG_DIRS);
  });

  test("announces the config dirs on the host:connected event", () => {
    const registry = new HostRegistry();
    const events: DashboardEvent[] = [];
    registry.setDashboardBroadcast((e) => {
      events.push(e);
    });
    const frame = parseHostRegisterFrame(
      rawFrame({ config_dirs: CONFIG_DIRS }),
    );
    if (!frame) throw new Error("frame should parse");
    registry.register(frame, { wsIdentity: {}, send: () => {} });

    expect(events.find((e) => e.event === "host:connected")).toMatchObject({
      config_dirs: CONFIG_DIRS,
    });
  });
});
