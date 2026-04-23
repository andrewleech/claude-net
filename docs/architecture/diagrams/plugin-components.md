# Level 3: Plugin Component Diagram

```mermaid
C4Component
    title Plugin Components

    Container_Ext(claudeCode, "Claude Code Session", "Communicates via stdio MCP protocol")
    Container_Ext(hubServer, "Hub Server", "WebSocket endpoint at /ws on port 4815")

    Container_Boundary(plugin, "Plugin (TypeScript, MCP SDK, runs on client machine)") {
        Component(mcpServer, "MCP Server", "MCP SDK", "Declares claude/channel and tools capabilities. Registers 11 tools. Provides instructions string for Claude's system prompt.")
        Component(capDetector, "Channel Capability Detector", "TypeScript", "Reads experimental[claude/channel] from MCP initialize capabilities. Sets channel_capable flag reported to hub on register.")
        Component(toolDispatch, "Tool Dispatch", "TypeScript", "Maps MCP tool calls to outbound hub WebSocket frames. Assigns requestId, awaits response (10s timeout). Returns structured results or errors.")
        Component(hubConnection, "Hub Connection", "WebSocket client", "WebSocket client to hub /ws. Connection lifecycle, exponential backoff reconnect (1s to 30s). Request/response correlation via requestId.")
        Component(channelEmitter, "Channel Emitter", "TypeScript", "Converts inbound hub message events to notifications/claude/channel MCP notifications. Sets meta: from, type, message_id, reply_to, team.")
        Component(versionReporter, "Version Reporter", "TypeScript", "Reports plugin_version on register. Stores upgrade_hint from hub response for one-shot surfacing via nudge queue.")
        Component(nudgeQueue, "Nudge Queue", "TypeScript", "One-shot text queue appended to the next tool result. Carries rename suggestions, channels-off warnings, upgrade hints. Entries support guard conditions for deferred emission.")
    }

    Rel(claudeCode, mcpServer, "MCP tool calls", "stdio")
    Rel(mcpServer, capDetector, "initialize capabilities")
    Rel(mcpServer, toolDispatch, "Forwards tool calls")
    Rel(capDetector, hubConnection, "Sets channel_capable for register frame")
    Rel(toolDispatch, nudgeQueue, "Reads and drains nudges into tool results")
    Rel(toolDispatch, hubConnection, "Sends WebSocket frames with requestId")
    Rel(versionReporter, nudgeQueue, "Queues upgrade hint on version mismatch")
    Rel(hubConnection, versionReporter, "upgrade_hint from register response")
    Rel(hubConnection, hubServer, "WebSocket connection", "WebSocket (/ws)")
    Rel(hubServer, hubConnection, "Pushes inbound messages and RPCs", "WebSocket")
    Rel(hubConnection, channelEmitter, "Forwards message events")
    Rel(channelEmitter, mcpServer, "Emits channel notifications")
    Rel(mcpServer, claudeCode, "Channel notifications", "stdio")

    UpdateElementStyle(mcpServer, $bgColor="#56C26A", $fontColor="#ffffff")
    UpdateElementStyle(capDetector, $bgColor="#56C26A", $fontColor="#ffffff")
    UpdateElementStyle(toolDispatch, $bgColor="#56C26A", $fontColor="#ffffff")
    UpdateElementStyle(hubConnection, $bgColor="#56C26A", $fontColor="#ffffff")
    UpdateElementStyle(channelEmitter, $bgColor="#56C26A", $fontColor="#ffffff")
    UpdateElementStyle(versionReporter, $bgColor="#56C26A", $fontColor="#ffffff")
    UpdateElementStyle(nudgeQueue, $bgColor="#56C26A", $fontColor="#ffffff")
```
