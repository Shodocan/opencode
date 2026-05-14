# MCP TUI notifications

Contract for MCP servers that interact with opencode's TUI and session state through JSON-RPC notifications.

## Overview

- Six notification methods, all under the `notifications/opencode/` namespace.
- Five are **server → opencode** (TUI actions): `prompt/append`, `prompt/synthetic`, `command/execute`, `toast/show`, `session/select`.
- One is **opencode → server** (status push): `session/status`. Servers opt in by registering a notification handler — there's no separate subscribe request.
- All notifications are one-way, no response or ack.
- Server → opencode handlers live in `packages/opencode/src/mcp/index.ts`; payloads republish on the internal bus and are consumed by the TUI.
- opencode → server fanout subscribes to the `session.status` bus event and pushes to every connected MCP client; unhandled notifications are dropped silently by the SDK.
- In headless / non-TUI server mode the inbound TUI events still publish on the bus, but visible effects (textarea, toast, navigation) are no-ops; the outbound `session/status` push works in any mode.

## Methods (server → opencode)

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

## Methods (opencode → server)

### `notifications/opencode/session/status`

Pushed by opencode whenever a session's status changes (`busy`, `retry`, `idle`).

```json
{
  "method": "notifications/opencode/session/status",
  "params": {
    "sessionID": "ses_...",
    "status": { "type": "idle" }
  }
}
```

`status` is a discriminated union mirroring `packages/opencode/src/session/status.ts`:

```ts
type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | {
      type: "retry"
      attempt: number
      message: string
      next: number // ms epoch when the next attempt will fire
      action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string }
    }
```

To opt in, register a handler on your MCP server for the method name above. There is no subscribe request — opencode broadcasts to every connected MCP server and the SDK drops the notification for servers without a handler.

Example handler (using `@modelcontextprotocol/sdk` server):

```ts
import { z } from "zod"

const SessionStatusNotificationSchema = z.object({
  method: z.literal("notifications/opencode/session/status"),
  params: z.object({
    sessionID: z.string(),
    status: z.discriminatedUnion("type", [
      z.object({ type: z.literal("idle") }),
      z.object({ type: z.literal("busy") }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number().int().nonnegative(),
        message: z.string(),
        next: z.number().int().nonnegative(),
        action: z
          .object({
            reason: z.string(),
            provider: z.string(),
            title: z.string(),
            message: z.string(),
            label: z.string(),
            link: z.string().optional(),
          })
          .optional(),
      }),
    ]),
  }),
})

server.setNotificationHandler(SessionStatusNotificationSchema, async (notification) => {
  const { sessionID, status } = notification.params
  if (status.type === "idle") onSessionIdle(sessionID)
  // ...
})
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
- **`session/status` is best-effort.** opencode fires the notification per status transition (`busy`, `retry`, `idle`). Notifications that fail (closed transport, slow server) are logged and dropped — there is no retry. Servers should treat status as a hint and reconcile from `GET /event` if they need stronger guarantees.
- **`session/status` fans out to all servers.** Every connected MCP server receives every transition. If you have many sessions and many servers this can be chatty; filter by `sessionID` server-side.
- **SDK types lag the runtime.** The autogenerated TypeScript SDK in `packages/sdk/js/src/v2/gen/` may not yet expose `prompt/synthetic`, `session/status`, or the `submit`/`sessionID` fields on `prompt/append`. Send raw JSON-RPC notifications (as in the skeleton above) — the runtime accepts the payloads regardless of the generated bindings.
