import { describe, expect, test } from "bun:test"
import { createPromptEventHandlers } from "../../../src/cli/cmd/tui/component/prompt/events"
import { SessionID } from "../../../src/session/schema"

describe("prompt event handlers", () => {
  test("routes session-scoped prompt appends to the matching prompt", () => {
    const current = SessionID.make("session-current")
    const other = SessionID.make("session-other")
    const visible: Array<{ text: string; sessionID?: string; submit?: boolean }> = []
    const synthetic: Array<{ text: string; sessionID: string }> = []
    const handlers = createPromptEventHandlers({
      sessionID: () => current,
      onAppend: (event) => visible.push(event),
      onSynthetic: (event) => synthetic.push(event),
    })

    handlers.onAppend({ text: "visible", sessionID: current, submit: true })
    handlers.onAppend({ text: "fallback" })
    handlers.onAppend({ text: "ignored", sessionID: other })

    expect(visible).toEqual([{ text: "visible", sessionID: current, submit: true }, { text: "fallback" }])
    expect(synthetic).toEqual([])
  })

  test("routes synthetic prompts without touching the visible append path", () => {
    const current = SessionID.make("session-current")
    const other = SessionID.make("session-other")
    const visible: Array<{ text: string; sessionID?: string; submit?: boolean }> = []
    const synthetic: Array<{ text: string; sessionID: string }> = []
    const handlers = createPromptEventHandlers({
      sessionID: () => current,
      onAppend: (event) => visible.push(event),
      onSynthetic: (event) => synthetic.push(event),
    })

    handlers.onSynthetic({ text: "hidden", sessionID: current })
    handlers.onSynthetic({ text: "queued", sessionID: other })

    expect(synthetic).toEqual([
      { text: "hidden", sessionID: current },
      { text: "queued", sessionID: other },
    ])
    expect(visible).toEqual([])
  })
})
