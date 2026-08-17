import { describe, expect, test } from "bun:test";
import { hostPlugin } from "@/hub/host";
import { HostRegistry } from "@/hub/host-registry";
import type { HostRegisterFrame, HostRestoreResult } from "@/shared/types";
import { Elysia } from "elysia";

const HOST_ID = "alice@box";

function registerFrame(
  overrides: Partial<HostRegisterFrame> = {},
): HostRegisterFrame {
  return {
    action: "host_register",
    host_id: HOST_ID,
    user: "alice",
    hostname: "box",
    home: "/home/alice",
    recent_cwds: [],
    allow_dangerous_skip: true,
    ...overrides,
  };
}

/**
 * Wire a registry to an app whose fake daemon answers every RPC with
 * `reply(frame)`. Returns the frames the daemon received so tests can
 * assert on what the hub relayed.
 */
function harness(
  reply: (frame: Record<string, unknown>) => Record<string, unknown> | null,
  registerOverrides: Partial<HostRegisterFrame> = {},
) {
  const registry = new HostRegistry();
  const received: Record<string, unknown>[] = [];
  const hostId = registerOverrides.host_id ?? HOST_ID;
  registry.register(registerFrame(registerOverrides), {
    wsIdentity: {},
    send: (data: string) => {
      const frame = JSON.parse(data) as Record<string, unknown>;
      received.push(frame);
      const response = reply(frame);
      if (response) {
        queueMicrotask(() => {
          // biome-ignore lint/suspicious/noExplicitAny: test double
          registry.resolveRpc(hostId, response as any);
        });
      }
    },
  });
  const app = new Elysia().use(hostPlugin({ hostRegistry: registry }));
  return { app, registry, received };
}

function post(app: Elysia, url: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("GET /api/host/:id/recoverable", () => {
  test("relays the daemon's candidate list", async () => {
    const sessions = [
      {
        session_id: "sid-1",
        cwd: "/home/alice/projects/foo",
        label: "foo",
        last_active: "2026-08-17T14:42:00.000Z",
        turns: 12,
        preview: "do the thing",
        needs_trust: false,
        tmux_conflict: null,
      },
    ];
    const { app, received } = harness((frame) => ({
      action: "host_recoverable_done",
      request_id: frame.request_id,
      sessions,
    }));

    const res = await app.handle(
      new Request(
        `http://localhost/api/host/${HOST_ID}/recoverable?within_hours=48`,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions });
    expect(received[0].action).toBe("host_recoverable");
    expect(received[0].within_hours).toBe(48);
  });

  test("rejects a non-positive within_hours", async () => {
    const { app } = harness(() => null);
    const res = await app.handle(
      new Request(
        `http://localhost/api/host/${HOST_ID}/recoverable?within_hours=0`,
      ),
    );
    expect(res.status).toBe(400);
  });

  test("404s for a host that isn't connected", async () => {
    const { app } = harness(() => null);
    const res = await app.handle(
      new Request("http://localhost/api/host/nobody@nowhere/recoverable"),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/host/:id/restore", () => {
  test("relays ids and returns per-session results", async () => {
    const results: HostRestoreResult[] = [
      { session_id: "sid-1", ok: true, tmux_session: "foo" },
      { session_id: "sid-2", ok: false, error: "no longer recoverable" },
    ];
    const { app, received } = harness((frame) => ({
      action: "host_restore_done",
      request_id: frame.request_id,
      results,
    }));

    const res = await post(app, `/api/host/${HOST_ID}/restore`, {
      session_ids: ["sid-1", "sid-2"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results });
    expect(received[0].session_ids).toEqual(["sid-1", "sid-2"]);
    // Auto-trust is the default for restore; the directory already hosted
    // the session being resumed.
    expect(received[0].auto_trust).toBe(true);
  });

  test("passes auto_trust: false straight through when asked", async () => {
    const { app, received } = harness((frame) => ({
      action: "host_restore_done",
      request_id: frame.request_id,
      results: [],
    }));
    await post(app, `/api/host/${HOST_ID}/restore`, {
      session_ids: ["sid-1"],
      auto_trust: false,
    });
    expect(received[0].auto_trust).toBe(false);
  });

  test("rejects an empty or malformed session_ids", async () => {
    const { app } = harness(() => null);
    expect((await post(app, `/api/host/${HOST_ID}/restore`, {})).status).toBe(
      400,
    );
    expect(
      (await post(app, `/api/host/${HOST_ID}/restore`, { session_ids: [] }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(app, `/api/host/${HOST_ID}/restore`, {
          session_ids: ["ok", 7],
        })
      ).status,
    ).toBe(400);
  });

  test("rejects a batch above the ceiling", async () => {
    const { app } = harness(() => null);
    const res = await post(app, `/api/host/${HOST_ID}/restore`, {
      session_ids: Array.from({ length: 21 }, (_, i) => `sid-${i}`),
    });
    expect(res.status).toBe(400);
  });

  test("403s skip_permissions when the host forbids it", async () => {
    const { app } = harness(() => null, { allow_dangerous_skip: false });
    const res = await post(app, `/api/host/${HOST_ID}/restore`, {
      session_ids: ["sid-1"],
      skip_permissions: true,
    });
    expect(res.status).toBe(403);
  });

  test("surfaces a daemon-level error as a 400", async () => {
    const { app } = harness((frame) => ({
      action: "host_restore_done",
      request_id: frame.request_id,
      error: "skip_permissions not allowed on this host",
    }));
    const res = await post(app, `/api/host/${HOST_ID}/restore`, {
      session_ids: ["sid-1"],
    });
    expect(res.status).toBe(400);
  });

  test("rate limits repeated restores", async () => {
    const { app } = harness((frame) => ({
      action: "host_restore_done",
      request_id: frame.request_id,
      results: [],
    }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post(app, `/api/host/${HOST_ID}/restore`, {
        session_ids: ["sid-1"],
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });
});
