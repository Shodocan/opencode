import { describe, expect, test } from "bun:test"
import { createPromptEventHandlers } from "../../src/component/prompt/events"

describe("prompt event handlers", () => {
  test("routes session-scoped prompt appends to the matching prompt", () => {
    const current = "ses_current"
    const other = "ses_other"
    const visible: Array<{ text: string; sessionID?: string; submit?: boolean }> = []
    const synthetic: Array<{ text: string; sessionID: string; visible?: boolean }> = []
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
    const current = "ses_current"
    const other = "ses_other"
    const visible: Array<{ text: string; sessionID?: string; submit?: boolean }> = []
    const synthetic: Array<{ text: string; sessionID: string; visible?: boolean }> = []
    const handlers = createPromptEventHandlers({
      sessionID: () => current,
      onAppend: (event) => visible.push(event),
      onSynthetic: (event) => synthetic.push(event),
    })

    handlers.onSynthetic({ text: "visible through hidden transport", sessionID: current, visible: true })
    handlers.onSynthetic({ text: "hidden", sessionID: other, visible: false })

    expect(synthetic).toEqual([
      { text: "visible through hidden transport", sessionID: current, visible: true },
      { text: "hidden", sessionID: other, visible: false },
    ])
    expect(visible).toEqual([])
  })
})
