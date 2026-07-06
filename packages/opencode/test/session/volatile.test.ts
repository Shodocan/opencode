import { describe, expect, it } from "bun:test"
import { filterVolatile, stripAllVolatile, activeUserIdOf } from "@/session/volatile"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

type WithParts = SessionV1.WithParts

function user(id: string, parts: { volatile?: boolean; id?: string; messageID?: string }[]): WithParts {
  return {
    info: { id, role: "user" } as SessionV1.User,
    parts: parts.map((p, i) => ({
      id: p.id ?? `prt_${id}_${i}`,
      sessionID: "sess",
      messageID: p.messageID ?? id,
      type: "text" as const,
      text: `t${i}`,
      ...(p.volatile ? { volatile: true } : {}),
    })) as SessionV1.Part[],
  }
}

function assistant(id: string): WithParts {
  return { info: { id, role: "assistant" } as SessionV1.Assistant, parts: [] }
}

describe("volatile filter", () => {
  it("keeps volatile parts on the active user message and drops them from prior turns", () => {
    const activeId = "u2"
    const messages = [
      user("u1", [{ volatile: true }, {}]),
      assistant("a1"),
      user("u2", [{ volatile: true }, {}]),
    ]
    const filtered = filterVolatile(messages, activeId)
    // u1: volatile dropped
    expect(filtered[0].parts.some((p) => (p as { volatile?: boolean }).volatile)).toBe(false)
    // u2: volatile kept
    expect(filtered[2].parts.some((p) => (p as { volatile?: boolean }).volatile)).toBe(true)
  })

  it("is invariant to tool-loop step: the active turn's volatile survives every iteration", () => {
    const activeId = "u1"
    const messages = [user("u1", [{ volatile: true }, {}]), assistant("a1")]
    // Simulate tool-loop iterations by filtering repeatedly with the same active id.
    let filtered = messages
    for (let i = 0; i < 5; i++) filtered = filterVolatile(filtered, activeId)
    expect(filtered[0].parts.some((p) => (p as { volatile?: boolean }).volatile)).toBe(true)
  })

  it("drops volatile from assistant messages (volatile only belongs to user turns)", () => {
    const activeId = "u1"
    const a = assistant("a1")
    ;(a.parts as SessionV1.Part[]).push({
      id: "prt_a1_v",
      sessionID: "sess",
      messageID: "u1",
      type: "text",
      text: "should be stripped",
      volatile: true,
    } as SessionV1.Part)
    const messages = [user("u1", [{}]), a]
    const filtered = filterVolatile(messages, activeId)
    expect(filtered[1].parts.some((p) => (p as { volatile?: boolean }).volatile)).toBe(false)
  })
})

describe("stripAllVolatile", () => {
  it("strips every volatile part regardless of which turn it belongs to", () => {
    const messages = [
      user("u1", [{ volatile: true }, {}]),
      user("u2", [{ volatile: true }, {}]),
    ]
    const stripped = stripAllVolatile(messages)
    expect(stripped[0].parts.some((p) => (p as { volatile?: boolean }).volatile)).toBe(false)
    expect(stripped[1].parts.some((p) => (p as { volatile?: boolean }).volatile)).toBe(false)
  })

  it("does not mutate the input", () => {
    const messages = [user("u1", [{ volatile: true }])]
    stripAllVolatile(messages)
    expect(messages[0].parts.some((p) => (p as { volatile?: boolean }).volatile)).toBe(true)
  })
})

describe("activeUserIdOf", () => {
  it("returns the most recent user message id", () => {
    const messages = [user("u1", [{}]), assistant("a1"), user("u2", [{}])]
    expect(activeUserIdOf(messages)).toBe("u2")
  })

  it("returns undefined when there is no user message", () => {
    const messages = [assistant("a1")]
    expect(activeUserIdOf(messages)).toBeUndefined()
  })
})