import { Elysia } from "elysia";

export interface SetupDeps {
  port: number;
}

export function setupPlugin(deps: SetupDeps): Elysia {
  const { port } = deps;

  return new Elysia().get("/setup", ({ request, set }) => {
    const envHost = process.env.CLAUDE_NET_HOST;
    let host: string;

    if (envHost) {
      host = envHost;
    } else {
      const headerHost = request.headers.get("host");
      host = headerHost ?? `localhost:${port}`;
    }

    // If no port in the resolved host, append the configured port
    if (!host.includes(":")) {
      host = `${host}:${port}`;
    }

    set.headers["content-type"] = "text/plain";

    const hubUrl = `http://${host}`;

    return `#!/bin/bash
set -e

echo "Registering claude-net MCP server..."
claude mcp add \\
  --scope user \\
  -e CLAUDE_NET_HUB=${hubUrl} \\
  --transport stdio \\
  claude-net -- bash -c 'P=$(mktemp /tmp/claude-net-plugin.XXXXXX.ts) && curl -fsSL ${hubUrl}/plugin.ts -o "\$P" && exec bun run "\$P"'

echo ""
echo "claude-net registered (user-wide). Restart Claude Code to activate."
`;
  });
}
