// Covers POST /api/mirror/:sid/keep-warm - the per-session toggle that
// starts/stops the hub pinging an idle session to keep its prompt cache
// warm. Connects KeepWarm to a real MirrorRegistry the same way
// index.ts does: enabled/disabled transitions write back through
// setKeepWarm, and onSessionClosed disables the timer when a session
// closes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KeepWarm } from "@/hub/keep-warm";
import { MirrorRegistry, mirrorPlugin } from "@/hub/mirror";
import { Elysia } from "elysia";

function startHub(withKeepWarm: boolean, retentionMs = 0) {
  const reg = new MirrorRegistry({ transcriptRing: 100, retentionMs });
  const fired: Array<{ sid: string; text: string; host?: string }> = [];
  let keepWarm: KeepWarm | undefined;
  if (withKeepWarm) {
    keepWarm = new KeepWarm({
      fireInject: (sid, text, _watcher, host) => {
        fired.push({ sid, text, ...(host ? { host } : {}) });
        return { ok: true };
      },
      getState: (sid, host) => reg.keepWarmState(sid, host),
    });
    reg.setKeepWarmText(keepWarm.text);
    keepWarm.setNotify((action, info) => {
      if (action === "enabled" || action === "disabled") {
        reg.setKeepWarm(info.sid, action === "enabled", info.host);
      }
    });
    reg.onSessionClosed((sid, host) =>
      keepWarm?.disable(sid, host, { forget: true }),
    );
  }
  const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg, keepWarm }));
  app.listen(0);
  // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
  const port = app.server!.port;
  return {
    port,
    reg,
    keepWarm,
    fired,
    stop: () => {
      keepWarm?.stop();
      app.stop();
    },
  };
}

describe("POST /api/mirror/:sid/keep-warm", () => {
  test("501s when keepWarm is not passed to the plugin", async () => {
    const hub = startHub(false);
    try {
      const r = await fetch(
        `http://localhost:${hub.port}/api/mirror/any-sid/keep-warm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(r.status).toBe(501);
    } finally {
      hub.stop();
    }
  });

  describe("with keepWarm enabled", () => {
    let hub: ReturnType<typeof startHub>;

    beforeEach(() => {
      hub = startHub(true);
    });

    afterEach(() => {
      hub.stop();
    });

    test("400s when enabled is missing or not boolean", async () => {
      const c = hub.reg.createSession("a:u@h", "/a", "sid-1");
      expect(c.ok).toBe(true);

      const missing = await fetch(
        `http://localhost:${hub.port}/api/mirror/sid-1/keep-warm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(missing.status).toBe(400);

      const wrongType = await fetch(
        `http://localhost:${hub.port}/api/mirror/sid-1/keep-warm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: "yes" }),
        },
      );
      expect(wrongType.status).toBe(400);
    });

    test("400s, not 500s, when the request has no body at all", async () => {
      const c = hub.reg.createSession("a:u@h", "/a", "sid-nobody");
      expect(c.ok).toBe(true);

      const r = await fetch(
        `http://localhost:${hub.port}/api/mirror/sid-nobody/keep-warm`,
        { method: "POST" },
      );
      expect(r.status).toBe(400);
    });

    test("404s for an unknown sid", async () => {
      const r = await fetch(
        `http://localhost:${hub.port}/api/mirror/no-such-sid/keep-warm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(r.status).toBe(404);
    });

    test("409s for a closed session", async () => {
      // Retention must outlive the close so the entry lingers as a
      // gravestone instead of vanishing immediately (retentionMs: 0
      // elsewhere in this file means "drop on close", not "keep it").
      const closedHub = startHub(true, 60_000);
      try {
        const c = closedHub.reg.createSession("a:u@h", "/a", "sid-closed");
        expect(c.ok).toBe(true);
        if (!c.ok) return;
        closedHub.reg.closeSession("sid-closed");

        const r = await fetch(
          `http://localhost:${closedHub.port}/api/mirror/sid-closed/keep-warm`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: true }),
          },
        );
        expect(r.status).toBe(409);
      } finally {
        closedHub.stop();
      }
    });

    test("enables, reflects in sessions/all, then disables and clears the flag", async () => {
      const c = hub.reg.createSession("a:u@h", "/a", "sid-toggle");
      expect(c.ok).toBe(true);

      const on = await fetch(
        `http://localhost:${hub.port}/api/mirror/sid-toggle/keep-warm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(on.status).toBe(200);
      const onBody = (await on.json()) as {
        enabled: boolean;
        interval_ms: number;
      };
      expect(onBody.enabled).toBe(true);
      expect(typeof onBody.interval_ms).toBe("number");

      const listRes = await fetch(
        `http://localhost:${hub.port}/api/mirror/sessions/all`,
      );
      const list = (await listRes.json()) as Array<Record<string, unknown>>;
      const row = list.find((s) => s.sid === "sid-toggle");
      expect(row?.keep_warm).toBe(true);

      const off = await fetch(
        `http://localhost:${hub.port}/api/mirror/sid-toggle/keep-warm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(off.status).toBe(200);
      const offBody = (await off.json()) as { enabled: boolean };
      expect(offBody.enabled).toBe(false);

      const listRes2 = await fetch(
        `http://localhost:${hub.port}/api/mirror/sessions/all`,
      );
      const list2 = (await listRes2.json()) as Array<Record<string, unknown>>;
      const row2 = list2.find((s) => s.sid === "sid-toggle");
      expect(row2).not.toHaveProperty("keep_warm");
    });

    test("disabling an already-off session still returns 200", async () => {
      const c = hub.reg.createSession("a:u@h", "/a", "sid-idle");
      expect(c.ok).toBe(true);

      const off = await fetch(
        `http://localhost:${hub.port}/api/mirror/sid-idle/keep-warm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(off.status).toBe(200);
    });

    test("closing the session disables the keep-warm timer", async () => {
      const c = hub.reg.createSession("a:u@h", "/a", "sid-close");
      expect(c.ok).toBe(true);

      const on = await fetch(
        `http://localhost:${hub.port}/api/mirror/sid-close/keep-warm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(on.status).toBe(200);
      expect(hub.keepWarm?.isEnabled("sid-close")).toBe(true);

      hub.reg.closeSession("sid-close");
      expect(hub.keepWarm?.isEnabled("sid-close")).toBe(false);
    });
  });

  test("GET /config includes keep_warm_interval_ms", async () => {
    const hub = startHub(true);
    try {
      const r = await fetch(`http://localhost:${hub.port}/api/mirror/config`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { keep_warm_interval_ms: number };
      expect(typeof body.keep_warm_interval_ms).toBe("number");
      expect(body.keep_warm_interval_ms).toBeGreaterThan(0);
    } finally {
      hub.stop();
    }
  });
});
