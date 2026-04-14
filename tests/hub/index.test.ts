import { afterAll, describe, expect, test } from "bun:test";
import { app } from "@/hub/index";

describe("hub server", () => {
  afterAll(() => {
    app.stop();
  });

  test("GET /health returns enhanced status info", async () => {
    const port = app.server?.port;
    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.agents).toBe("number");
    expect(typeof body.teams).toBe("number");
  });
});
