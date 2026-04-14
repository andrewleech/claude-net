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

    return `#!/bin/bash
set -e
HUB="${host}"
echo "Registering claude-net MCP server..."
claude mcp add --transport stdio \\
  --env CLAUDE_NET_HUB=http://$HUB \\
  claude-net -- bun run http://$HUB/plugin.ts
echo ""
echo "claude-net registered. Start Claude Code with:"
echo "  claude --dangerously-load-development-channels server:claude-net"
`;
  });
}
