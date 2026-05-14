# MCP TUI notifications

Contract for MCP servers that drive opencode's TUI through JSON-RPC notifications.

## Overview

- Five one-way notification methods, all under the `notifications/opencode/` namespace.
- Server-initiated, no response or ack — fire-and-forget.
- Notification handlers are installed in `packages/opencode/src/mcp/index.ts`; payloads are republished on the internal bus and consumed by the TUI (`packages/opencode/src/cli/cmd/tui/event.ts`, `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`).
- In headless / non-TUI server mode the bus events still fire, but the user-visible effects (textarea, toast, navigation) are no-ops.

## Methods

### `notifications/opencode/prompt/append`

Insert text into the user's prompt textarea. Optionally auto-submit after insertion.

```json
{
  "method": "notifications/opencode/prompt/append",
  "params": {
    "text": "string",
    "submit": false,
    "sessionID": "ses_..."
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `text` | `string` | Required. Inserted at the current cursor position. |
| `submit` | `boolean` | Optional, default `false`. When `true`, the prompt fires after a short debounce (~100 ms) so the inserted text is included. |
| `sessionID` | `string` | Optional. When set, only the prompt component mounted for that session consumes the event. Use this to avoid the text landing in whichever session happens to be focused. |

### `notifications/opencode/prompt/synthetic`

Send a hidden user message directly into the model conversation. Does **not** show up in the textarea or in the visible message stream as user input.

```json
{
  "method": "notifications/opencode/prompt/synthetic",
  "params": {
    "text": "string",
    "sessionID": "ses_..."
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `text` | `string` | Required. Sent as `{ type: "text", text, synthetic: true }` so renderers can filter it out. |
| `sessionID` | `string` | Required. Per-session FIFO queue, drained serially when that session becomes active. Messages for not-yet-mounted sessions are held, not dropped. |

Use cases: background work-tracker pings, agent-injected context, anything that should reach the model without polluting human input.

### `notifications/opencode/command/execute`

Trigger a registered TUI command by name.

```json
{
  "method": "notifications/opencode/command/execute",
  "params": {
    "command": "prompt.submit"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `command` | `string` | Required. Command name as registered in the keymap layer. Unknown commands are dropped silently. |

Built-in command names include `session.list`, `session.new`, `session.share`, `session.interrupt`, `session.compact`, `prompt.clear`, `prompt.submit`, `agent.cycle`, plus any plugin-registered commands. Keybinds are not accepted — use command names.

### `notifications/opencode/toast/show`

Surface a toast in the TUI.

```json
{
  "method": "notifications/opencode/toast/show",
  "params": {
    "title": "Heads up",
    "message": "Index rebuilt",
    "variant": "success",
    "duration": 3000
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `title` | `string` | Optional. |
| `message` | `string` | Required. |
| `variant` | `"info" \| "success" \| "warning" \| "error"` | Required. |
| `duration` | `number` | Optional. Positive integer in milliseconds. Default `5000`. |

### `notifications/opencode/session/select`

Navigate the TUI to a specific session.

```json
{
  "method": "notifications/opencode/session/select",
  "params": {
    "sessionID": "ses_..."
  }
}
```

## Minimal MCP server skeleton

Using `@modelcontextprotocol/sdk` over stdio:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const server = new Server({ name: "my-tui-driver", version: "0.1.0" }, { capabilities: { tools: {} } })

async function appendPrompt(text: string, opts?: { submit?: boolean; sessionID?: string }) {
  await server.notification({
    method: "notifications/opencode/prompt/append",
    params: { text, ...opts },
  })
}

async function syntheticPrompt(sessionID: string, text: string) {
  await server.notification({
    method: "notifications/opencode/prompt/synthetic",
    params: { sessionID, text },
  })
}

async function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  await server.notification({
    method: "notifications/opencode/toast/show",
    params: { message, variant },
  })
}

async function executeCommand(command: string) {
  await server.notification({
    method: "notifications/opencode/command/execute",
    params: { command },
  })
}

async function selectSession(sessionID: string) {
  await server.notification({
    method: "notifications/opencode/session/select",
    params: { sessionID },
  })
}

// register tools/resources as usual, then connect:
await server.connect(new StdioServerTransport())
```

Register the server with opencode (`opencode.json` or `~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "my-tui-driver": {
      "type": "local",
      "command": ["node", "/abs/path/to/server.js"]
    }
  }
}
```

Remote servers (`type: "remote"`) work the same — notifications fire over the SSE/streamable-HTTP transport once the client is connected. For OAuth-protected remotes the handler is only installed after a successful authentication.

## Caveats

- **One-way only.** opencode never responds to or acks these notifications. Errors in the notification payload (wrong shape, unknown method) are dropped — they do not propagate back to the server.
- **No throttling.** Flooding `prompt/append` with `submit: true` enqueues multiple submits; gate this server-side.
- **`prompt/synthetic` queue is in-process.** If opencode restarts, queued-but-undrained messages are lost. Don't treat it as a durable channel.
- **`sessionID` scoping for `prompt/append`** matches the *mounted* prompt component's session. If the user has navigated elsewhere, the event is dropped (not queued). Use `prompt/synthetic` if you need queueing semantics.
- **SDK types lag the runtime.** The autogenerated TypeScript SDK in `packages/sdk/js/src/v2/gen/` may not yet expose `prompt/synthetic` or the `submit`/`sessionID` fields on `prompt/append`. Send raw JSON-RPC notifications (as in the skeleton above) — the runtime accepts the payloads regardless of the generated bindings.
