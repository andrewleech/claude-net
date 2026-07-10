workspace "claude-net" "C4 architecture model for claude-net: a lightweight LAN messaging hub for Claude Code agents." {

    model {
        // People
        developer = person "Developer" "Runs multiple Claude Code sessions and monitors agent activity via the dashboard." {
            tags "Person"
        }

        // External systems
        claudeCode = softwareSystem "Claude Code Session" "Interactive Claude Code CLI session. Spawns the plugin as a stdio subprocess and communicates via MCP." {
            tags "External"
        }

        // Primary system
        claudeNet = softwareSystem "claude-net Hub" "LAN messaging hub that routes messages between Claude Code agents, manages identity and teams, and serves the monitoring dashboard." {
            tags "Hub"

            // Containers
            hubServer = container "Hub Server" "Single Bun process running Elysia. Manages agent registry, teams, message routing. Serves dashboard, plugin script, and setup endpoint. Listens on port 4815." "Bun + Elysia, TypeScript" {
                tags "HubServer"

                // Hub components
                registry = component "Registry" "Agent registration, name resolution (full and short name), uniqueness enforcement, disconnect timeout tracking." "TypeScript module (registry.ts)" {
                    tags "HubComponent"
                }
                teams = component "Teams" "Team lifecycle management: implicit creation/deletion, join/leave, membership timeout on disconnect (2h window)." "TypeScript module (teams.ts)" {
                    tags "HubComponent"
                }
                router = component "Router" "Message routing: direct (by name), team (all online members except sender). Generates message_id, stamps from and timestamp." "TypeScript module (router.ts)" {
                    tags "HubComponent"
                }
                pluginWsHandler = component "Plugin WS Handler" "WebSocket endpoint at /ws. Accepts plugin connections, dispatches incoming frames to registry/teams/router, pushes outbound messages to connected plugins." "TypeScript module (ws-plugin.ts)" {
                    tags "HubComponent"
                }
                dashboardWsHandler = component "Dashboard WS Handler" "WebSocket endpoint at /ws/dashboard. Pushes agent:connected, agent:disconnected, message:routed, and team:changed events to dashboard clients." "TypeScript module (ws-dashboard.ts)" {
                    tags "HubComponent"
                }
                restApi = component "REST API" "HTTP endpoints under /api/*. GET /api/agents, GET /api/teams, POST /api/send, POST /api/send_team, GET /api/status." "TypeScript module (api.ts)" {
                    tags "HubComponent"
                }
                setup = component "Setup" "GET /setup endpoint. Returns a shell script that registers the claude-net MCP server in the client's Claude Code configuration. Resolves hub address from CLAUDE_NET_HOST env var or request Host header." "TypeScript module (setup.ts)" {
                    tags "HubComponent"
                }
                sharedTypes = component "Shared Types" "TypeScript type definitions for WebSocket frames (plugin and dashboard), message structures, agent records, and team records. Used by all other components." "TypeScript module (types.ts)" {
                    tags "HubComponent"
                }
            }

            plugin = container "Plugin" "Single TypeScript file fetched from the hub at startup. Spawned by Claude Code as a stdio subprocess via 'bun run http://hub:4815/plugin.ts'. Bridges MCP channel notifications with hub WebSocket messages. Runs on the client machine." "TypeScript, MCP SDK, Bun" {
                tags "Plugin"

                // Plugin components
                mcpServer = component "MCP Server" "Declares claude/channel capability and tools capability. Registers MCP tools (register, send_message, send_team, join_team, leave_team, list_agents, list_teams). Provides instructions string for Claude's system prompt." "MCP SDK" {
                    tags "PluginComponent"
                }
                hubConnection = component "Hub Connection" "WebSocket client connecting to hub at /ws. Handles connection lifecycle, exponential backoff reconnect (1s to 30s max), and request/response correlation via requestId with 10s timeout." "WebSocket client" {
                    tags "PluginComponent"
                }
                channelEmitter = component "Channel Emitter" "Converts inbound hub message events into MCP notifications/claude/channel notifications with correct meta attributes (source, from, type, message_id, reply_to, team)." "TypeScript" {
                    tags "PluginComponent"
                }
                toolDispatch = component "Tool Dispatch" "Maps MCP tool calls to outbound hub WebSocket frames. Assigns requestId to each request and awaits the hub response. Returns structured results or errors to Claude Code." "TypeScript" {
                    tags "PluginComponent"
                }
            }

            dashboard = container "Dashboard" "Single-page HTML application served by the hub at /. Displays connected agents, teams, and a live message feed. Allows sending messages to agents and teams from the browser." "HTML, CSS, JavaScript" {
                tags "Dashboard"
            }
        }

        // Relationships — Level 1 (System Context)
        developer -> claudeNet "Views agent status, teams, and message feed; sends messages via dashboard" "HTTP, WebSocket" {
            tags "Relationship"
        }
        developer -> claudeCode "Starts Claude Code sessions with --dangerously-load-development-channels flag" "" {
            tags "Relationship"
        }
        claudeCode -> claudeNet "Plugin connects to hub for message routing" "WebSocket" {
            tags "Relationship"
        }

        // Relationships — Level 2 (Container)
        developer -> dashboard "Views agent activity and sends messages" "HTTP (browser)" {
            tags "Relationship"
        }
        claudeCode -> plugin "Spawns as stdio subprocess; exchanges MCP tool calls and channel notifications" "stdio (MCP protocol)" {
            tags "Relationship"
        }
        plugin -> hubServer "Registers agent, sends/receives messages, manages team membership" "WebSocket (port 4815, /ws)" {
            tags "Relationship"
        }
        dashboard -> hubServer "Receives live events; sends messages via REST" "WebSocket (/ws/dashboard), REST (/api/*)" {
            tags "Relationship"
        }
        hubServer -> plugin "Pushes inbound messages to connected plugins" "WebSocket" {
            tags "Relationship"
        }
        hubServer -> dashboard "Serves dashboard HTML at /" "HTTP" {
            tags "Relationship"
        }

        // Relationships — Level 3 (Hub Components)
        pluginWsHandler -> registry "Dispatches register actions, queries agent names" "" {
            tags "InternalRelationship"
        }
        pluginWsHandler -> teams "Dispatches join_team, leave_team, list_teams actions" "" {
            tags "InternalRelationship"
        }
        pluginWsHandler -> router "Dispatches send, send_team actions" "" {
            tags "InternalRelationship"
        }
        router -> registry "Resolves recipient names, checks online status" "" {
            tags "InternalRelationship"
        }
        router -> teams "Resolves team membership for team messages" "" {
            tags "InternalRelationship"
        }
        restApi -> router "Delegates message sending from dashboard" "" {
            tags "InternalRelationship"
        }
        restApi -> registry "Queries agent list and status" "" {
            tags "InternalRelationship"
        }
        restApi -> teams "Queries team list and membership" "" {
            tags "InternalRelationship"
        }
        dashboardWsHandler -> registry "Subscribes to agent connect/disconnect events" "" {
            tags "InternalRelationship"
        }
        dashboardWsHandler -> router "Subscribes to message:routed events" "" {
            tags "InternalRelationship"
        }
        dashboardWsHandler -> teams "Subscribes to team:changed events" "" {
            tags "InternalRelationship"
        }
        registry -> sharedTypes "Uses type definitions" "" {
            tags "InternalRelationship"
        }
        teams -> sharedTypes "Uses type definitions" "" {
            tags "InternalRelationship"
        }
        router -> sharedTypes "Uses type definitions" "" {
            tags "InternalRelationship"
        }
        pluginWsHandler -> sharedTypes "Uses type definitions" "" {
            tags "InternalRelationship"
        }
        dashboardWsHandler -> sharedTypes "Uses type definitions" "" {
            tags "InternalRelationship"
        }
        restApi -> sharedTypes "Uses type definitions" "" {
            tags "InternalRelationship"
        }
        setup -> sharedTypes "Uses type definitions" "" {
            tags "InternalRelationship"
        }

        // Relationships — Level 3 (Plugin Components)
        mcpServer -> toolDispatch "Forwards MCP tool calls" "" {
            tags "InternalRelationship"
        }
        toolDispatch -> hubConnection "Sends WebSocket frames with requestId" "" {
            tags "InternalRelationship"
        }
        hubConnection -> channelEmitter "Forwards inbound message events from hub" "" {
            tags "InternalRelationship"
        }
        channelEmitter -> mcpServer "Emits notifications/claude/channel notifications" "" {
            tags "InternalRelationship"
        }

        // Deployment
        deploymentEnvironment "LAN" {
            deploymentNode "Hub Machine" "Machine running the hub Docker container" "Linux / Docker" {
                deploymentNode "Docker Container" "oven/bun:1 based image" "Docker" {
                    containerInstance hubServer
                }
            }
            deploymentNode "Client Machine" "Developer workstation running Claude Code" "Linux / macOS / WSL" {
                deploymentNode "Claude Code Process" "Interactive CLI session" "Claude Code" {
                    containerInstance plugin
                }
                deploymentNode "Web Browser" "Dashboard viewer" "Browser" {
                    containerInstance dashboard
                }
            }
        }
    }

    views {
        systemContext claudeNet "SystemContext" "Level 1: System Context diagram showing claude-net hub and its external actors." {
            include *
            autoLayout
        }

        container claudeNet "Containers" "Level 2: Container diagram showing the hub server, plugin, and dashboard." {
            include *
            autoLayout
        }

        component hubServer "HubComponents" "Level 3: Component diagram showing the internal modules of the hub server." {
            include *
            autoLayout
        }

        component plugin "PluginComponents" "Level 3: Component diagram showing the internal modules of the plugin." {
            include *
            autoLayout
        }

        deployment claudeNet "LAN" "Deployment" "Deployment diagram showing hub Docker container and client-side processes." {
            include *
            autoLayout
        }

        styles {
            element "Person" {
                shape Person
                background #08427B
                color #ffffff
            }
            element "External" {
                background #999999
                color #ffffff
            }
            element "Hub" {
                background #1168BD
                color #ffffff
            }
            element "HubServer" {
                background #2B7CD0
                color #ffffff
            }
            element "Plugin" {
                background #2EA44F
                color #ffffff
            }
            element "Dashboard" {
                background #E8820C
                color #ffffff
            }
            element "HubComponent" {
                background #4A90D9
                color #ffffff
            }
            element "PluginComponent" {
                background #56C26A
                color #ffffff
            }
        }
    }

}
