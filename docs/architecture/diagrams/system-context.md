# Level 1: System Context Diagram

```mermaid
C4Context
    title claude-net System Context

    Person(developer, "Developer", "Runs multiple Claude Code sessions and monitors agent activity, session transcripts, and system health via the dashboard.")

    System(claudeNet, "claude-net Hub", "LAN messaging hub that routes messages between Claude Code agents, manages identity and teams, stores session mirror transcripts, and serves the monitoring dashboard.")

    System_Ext(claudeCode, "Claude Code Session", "Interactive Claude Code CLI session. Spawns the plugin as a stdio subprocess and communicates via MCP.")

    System_Ext(mirrorAgent, "Mirror-Agent Daemon", "Long-running local process. Captures Claude Code hook events and streams them to the hub. Handles inject/paste RPCs from dashboard watchers.")

    Boundary(lan, "LAN / VPN", "Network trust boundary") {
    }

    Rel(developer, claudeNet, "Views agents, teams, session transcripts; sends messages; launches sessions via host dashboard", "HTTP, WebSocket")
    Rel(developer, claudeCode, "Starts sessions via claude-channels launcher")
    Rel(claudeCode, claudeNet, "Plugin connects to hub for message routing", "WebSocket")
    Rel(mirrorAgent, claudeNet, "Streams mirror events; receives inject/paste/stop RPCs", "WebSocket")
    Rel(claudeCode, mirrorAgent, "Hook events via claude-net-mirror-push", "HTTP (loopback)")

    UpdateRelStyle(developer, claudeNet, $offsetY="-30")
    UpdateRelStyle(developer, claudeCode, $offsetX="-120")
    UpdateRelStyle(claudeCode, claudeNet, $offsetY="30")
    UpdateRelStyle(mirrorAgent, claudeNet, $offsetX="20")
```
