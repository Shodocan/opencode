import { describe, expect, test } from "bun:test"
import { createPromptEventHandlers } from "../src/component/prompt/events"
import { createHiddenPromptQueue, type HiddenPromptItem } from "../src/component/prompt/hidden-prompt-queue"

describe("prompt event handlers", () => {
  test("routes session-scoped prompt appends to the matching prompt", () => {
    const current = "session-current"
    const other = "session-other"
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
    const current = "session-current"
    const other = "session-other"
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

describe("hidden prompt queue", () => {
  test("delivers items in FIFO order", async () => {
    const queue = createHiddenPromptQueue()
    const delivered: string[] = []
    const deliver = async (item: HiddenPromptItem) => {
      delivered.push(item.text)
    }

    queue.enqueue("s1", { text: "a" })
    queue.enqueue("s1", { text: "b" })
    queue.enqueue("s1", { text: "c" })
    await queue.drain("s1", deliver)

    expect(delivered).toEqual(["a", "b", "c"])
  })

  test("isolates queues and delivers a parked session later", async () => {
    const queue = createHiddenPromptQueue()
    const delivered: string[] = []
    const deliver = async (item: HiddenPromptItem) => {
      delivered.push(item.text)
    }

    queue.enqueue("s1", { text: "a" })
    queue.enqueue("s2", { text: "b" })
    queue.enqueue("s1", { text: "c" })
    await queue.drain("s1", deliver)

    expect(delivered).toEqual(["a", "c"])

    await queue.drain("s2", deliver)

    expect(delivered).toEqual(["a", "c", "b"])
  })

  test("picks up items enqueued during drain", async () => {
    const queue = createHiddenPromptQueue()
    const delivered: string[] = []
    const deliver = async (item: HiddenPromptItem) => {
      delivered.push(item.text)
      if (item.text === "a") {
        queue.enqueue("s1", { text: "b" })
      }
    }

    queue.enqueue("s1", { text: "a" })
    await queue.drain("s1", deliver)

    expect(delivered).toEqual(["a", "b"])
  })

  test("preserves visible and caller item shape", async () => {
    const queue = createHiddenPromptQueue()
    const delivered: HiddenPromptItem[] = []
    const deliver = async (item: HiddenPromptItem) => {
      delivered.push(item)
    }

    queue.enqueue("s1", { text: "visible", visible: true, caller: "mcp" })
    queue.enqueue("s1", { text: "hidden", visible: false })
    await queue.drain("s1", deliver)

    expect(delivered).toEqual([
      { text: "visible", visible: true, caller: "mcp" },
      { text: "hidden", visible: false },
    ])
  })
})
