export * as TuiEvent from "./tui-event"

import { Effect, Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { PositiveInt } from "./schema"
import { SessionID } from "./session-id"

const DEFAULT_TOAST_DURATION = 5000

export const PromptAppend = Event.define({
  type: "tui.prompt.append",
  schema: {
    text: Schema.String,
    submit: optional(Schema.Boolean),
    sessionID: optional(SessionID),
  },
})

export const PromptSynthetic = Event.define({
  type: "tui.prompt.synthetic",
  schema: {
    text: Schema.String,
    sessionID: SessionID,
    visible: optional(Schema.Boolean),
    caller: optional(Schema.String),
  },
})

export const CommandExecute = Event.define({
  type: "tui.command.execute",
  schema: {
    command: Schema.Union([
      Schema.Literals([
        "session.list",
        "session.new",
        "session.share",
        "session.interrupt",
        "session.compact",
        "session.page.up",
        "session.page.down",
        "session.line.up",
        "session.line.down",
        "session.half.page.up",
        "session.half.page.down",
        "session.first",
        "session.last",
        "prompt.clear",
        "prompt.submit",
        "agent.cycle",
      ]),
      Schema.String,
    ]),
  },
})

export const ToastShow = Event.define({
  type: "tui.toast.show",
  schema: {
    title: optional(Schema.String),
    message: Schema.String,
    variant: Schema.Literals(["info", "success", "warning", "error"]),
    duration: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_TOAST_DURATION))).annotate({
      description: "Duration in milliseconds",
    }),
  },
})

export const SessionSelect = Event.define({
  type: "tui.session.select",
  schema: {
    sessionID: SessionID.annotate({ description: "Session ID to navigate to" }),
  },
})

export const AgentState = Event.define({
  type: "tui.agent.state",
  schema: {
    agent: Schema.String,
    model: optional(
      Schema.Struct({
        providerID: Schema.String,
        modelID: Schema.String,
      }),
    ),
    variant: optional(Schema.String),
  },
})

export const Definitions = Event.inventory(
  PromptAppend,
  PromptSynthetic,
  CommandExecute,
  ToastShow,
  SessionSelect,
  AgentState,
)
