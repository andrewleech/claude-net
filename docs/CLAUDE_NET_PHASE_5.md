# claude-net - Phase 5: Dashboard

**Part of:** CLAUDE_NET_PLAN.md
**Phase:** 5 of 6
**Depends on:** Phase 2 (Hub Server Core)
**Parallel with:** Phase 4 (REST API & Setup)

## Goal

Build a single-page HTML dashboard served by the hub at `GET /`. It connects to the hub via WebSocket at `/ws/dashboard` for live updates, and uses the REST API (Phase 4) for sending messages. Shows connected agents, teams, and a live message feed.

**Use the `/frontend-design` skill when implementing this phase for design quality.**

## Prerequisites

- [ ] Phase 2 completed (hub core with WebSocket handler, registry, teams, router)
- [ ] Phase 4 completed or in progress (REST API for sending messages)
- [ ] Spec file read: docs/CLAUDE_NET_SPEC.md (Dashboard events section)
- [ ] Main plan reviewed: CLAUDE_NET_PLAN.md

## Files to Create

- `src/hub/ws-dashboard.ts` — Elysia WebSocket handler for `/ws/dashboard`
- `src/hub/dashboard.html` — Single-page HTML file with embedded CSS and JS

## Files to Modify

- `src/hub/index.ts` — Mount `/ws/dashboard` handler and `GET /` route serving the HTML
- `src/hub/ws-plugin.ts` — Wire the `dashboardBroadcast()` function to actually send events to dashboard clients

## Key Requirements

### 1. Dashboard WebSocket Handler (`src/hub/ws-dashboard.ts`)

**`/ws/dashboard` endpoint:**
- On `open`: add the WS to a `dashboardClients` set
- On `close`: remove from `dashboardClients`
- On `message`: handle messages from dashboard (for future extensibility, but not required now — dashboard sends via REST)

**`broadcastToDashboards(event: DashboardEvent)`:**
- Export this function
- Iterate `dashboardClients`, send `JSON.stringify(event)` to each
- This replaces the no-op placeholder from Phase 2

**Initial state push:** On dashboard connect, immediately send:
- Current agent list (as a series of `agent:connected` events for each online agent)
- Current team state (as `team:changed` events with action `"created"` for each team)

This bootstraps the dashboard with current state without needing a separate REST call.

### 2. Wire Dashboard Events into Plugin WS Handler

Modify `src/hub/ws-plugin.ts` to call `broadcastToDashboards()` at the right points:
- Agent registers → `{ event: "agent:connected", name, full_name }`
- Agent disconnects → `{ event: "agent:disconnected", name, full_name }`
- Message routed (direct, broadcast, team) → `{ event: "message:routed", ...messageFields }`
- Team join → `{ event: "team:changed", team, members, action: "joined" }`
- Team leave → `{ event: "team:changed", team, members, action: "left" }`
- Team created (first join) → `{ event: "team:changed", team, members, action: "created" }`
- Team deleted (last leave) → `{ event: "team:changed", team, members: [], action: "deleted" }`

### 3. Dashboard HTML (`src/hub/dashboard.html`)

A single self-contained HTML file with embedded `<style>` and `<script>`. No external CSS or JS dependencies. Modern browser APIs only (no IE support needed).

**Layout (three-panel):**

```
┌──────────────────────────────────────────────────────────────┐
│  claude-net                                    status: ●     │
├──────────────┬───────────────────────┬───────────────────────┤
│              │                       │                       │
│   Agents     │    Message Feed       │    Teams              │
│              │                       │                       │
│  ● reviewer  │  reviewer → arch...   │  backend (2)          │
│  ● architect │  architect → all...   │    ● reviewer         │
│  ○ tester    │  dashboard → rev...   │    ● architect        │
│              │                       │                       │
│              │                       │  frontend (1)         │
│              │                       │    ● designer         │
│              │                       │                       │
├──────────────┴───────────────────────┴───────────────────────┤
│  Send: [to ▼] [message                          ] [Send]     │
└──────────────────────────────────────────────────────────────┘
```

**Panels:**

1. **Agent sidebar (left)**
   - Lists all agents with online (●) / offline (○) indicator
   - Sorted: online first, then alphabetically
   - Clicking an agent name populates the "to" field in the send bar

2. **Message feed (center)**
   - Scrolling list of recent messages (newest at bottom, auto-scroll)
   - Each entry shows: from → to (or "broadcast" or "team:name"), timestamp, content preview
   - Different visual treatment for direct vs broadcast vs team messages
   - Cap at 200 messages in the UI (drop oldest)

3. **Team panel (right)**
   - Lists all teams with member count
   - Expandable: click team name to see members with online/offline status

4. **Send bar (bottom)**
   - Dropdown/input for recipient: agent name, "broadcast", or team name
   - Text input for message content
   - Send button
   - Sends via `POST /api/send`, `POST /api/broadcast`, or `POST /api/send_team` depending on recipient selection

5. **Header**
   - "claude-net" title
   - Connection status indicator (● green = WebSocket connected, ● red = disconnected)
   - Agent count and team count

**WebSocket client (in `<script>`):**

```javascript
// Connect to /ws/dashboard
const ws = new WebSocket(`ws://${location.host}/ws/dashboard`);

ws.onmessage = (e) => {
  const event = JSON.parse(e.data);
  switch (event.event) {
    case "agent:connected": // add to agent list
    case "agent:disconnected": // mark offline or remove
    case "message:routed": // append to feed
    case "team:changed": // update team panel
  }
};
```

**State management (in `<script>`):**
- `agents: Map<fullName, { name, fullName, status }>` — updated by agent events
- `teams: Map<teamName, { members: string[] }>` — updated by team events
- `messages: Array<MessageEntry>` — appended by message events, capped at 200

**Sending messages (in `<script>`):**
- Parse the "to" field to determine route:
  - Starts with `team:` → `POST /api/send_team` with team name
  - Equals `broadcast` → `POST /api/broadcast`
  - Otherwise → `POST /api/send` with agent name
- On success, clear the message input
- On error, show the error message inline

### 4. Serving the Dashboard

In `src/hub/index.ts`, add:
```
GET / → serve the contents of src/hub/dashboard.html
```

Read the file once at startup and serve from memory. Or use Bun's `Bun.file()` for efficient serving.

## Integration Points

- Dashboard WebSocket handler imports `DashboardEvent` types from `src/shared/types.ts`
- `broadcastToDashboards()` is called from `ws-plugin.ts` (plugin connection handler) and potentially from `api.ts` (REST message sending)
- REST API routes (Phase 4) are used by the dashboard for sending messages — the dashboard's `<script>` calls `fetch('/api/send', ...)` etc.
- If Phase 4 isn't complete yet, the send bar won't work but the live feed and agent/team panels will function from WebSocket events alone

## Implementation Guidance

**Design quality:** Use the `/frontend-design` skill for the dashboard implementation. The dashboard should look clean and professional despite being a single HTML file.

**Color scheme suggestions:**
- Dark background (developer-friendly)
- Green for online status, muted for offline
- Distinct colors for direct / broadcast / team messages in the feed
- Monospace font for message content

**Responsive:** Not required — this is a monitoring dashboard viewed on a desktop/laptop.

**No framework:** Vanilla JS, no React/Vue/Svelte. Keep it simple. Template literals for dynamic HTML.

## Testing Strategy

**Tester agent responsibilities for this phase:**

Dashboard testing is primarily manual/visual, but some aspects can be automated.

**Test files to create:**

- `tests/hub/ws-dashboard.test.ts`
  - Connect to `/ws/dashboard`, verify initial state events arrive (agent list, team list)
  - Register an agent via `/ws`, verify dashboard WS receives `agent:connected` event
  - Disconnect an agent, verify dashboard WS receives `agent:disconnected` event
  - Send a message between agents, verify dashboard WS receives `message:routed` event
  - Join/leave a team, verify dashboard WS receives `team:changed` events
  - Multiple dashboard connections receive the same events

- Manual testing checklist (for Reviewer):
  - Dashboard loads at `http://localhost:4815/`
  - Agent list updates live as agents connect/disconnect
  - Message feed scrolls and shows new messages
  - Team panel updates on join/leave
  - Send bar can send direct messages, broadcasts, and team messages
  - Connection status indicator reflects WebSocket state

## Risks and Mitigations

- **Risk:** Single HTML file with embedded JS becomes unwieldy
  - **Mitigation:** Keep the JS focused on state management and DOM updates. Use CSS grid/flexbox for layout. Target ~300-500 lines total.
- **Risk:** WebSocket reconnect in the dashboard
  - **Mitigation:** Add a simple reconnect loop in the dashboard JS (try every 3 seconds on disconnect). Show red indicator while disconnected.
- **Risk:** Dashboard and REST API phases run in parallel — send bar may not work until Phase 4 completes
  - **Mitigation:** The live feed and agent/team panels work from WebSocket alone. Send bar is additive. Test send bar after Phase 4 merges.

## Success Criteria

- [ ] Dashboard loads at `http://localhost:4815/`
- [ ] WebSocket connects to `/ws/dashboard` and receives initial state
- [ ] Agent list updates live on connect/disconnect
- [ ] Message feed shows all routed messages in real time
- [ ] Team panel shows teams and members with correct status
- [ ] Send bar sends messages via REST API (direct, broadcast, team)
- [ ] Connection status indicator works
- [ ] Dashboard WS tests pass

## Next Steps

After completing this phase:
1. Tester runs automated tests and performs manual checklist
2. Reviewer evaluates: visual quality, usability, event handling completeness
3. Phase 5 is complete. Proceed to Phase 6 once all prior phases are done.
