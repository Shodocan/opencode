import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Context, DateTime } from "effect"
import { clearState, decide, StopRecovery } from "../src/session/stop-recovery"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV1, MessageID, PartID } from "@opencode-ai/core/v1/session"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"

// FORK FEATURE (9) stop-recovery — shell-level acceptance tests for `decide`.
// Uses mock services (no real loop) to verify injection, telemetry, halt, and
// the feature-off no-op. Covers spec §9 B1 (length continue), E1 (master-off),
// E9 (observed), C2 (halt), B7 (copied agent/model).

const SESSION_ID = SessionID.make("ses_test")
const USER_ID = MessageID.ascending()
const ASSISTANT_ID = MessageID.ascending()

afterEach(() => clearState(SESSION_ID))

function mockUser(): SessionV1.User {
  return {
    id: USER_ID,
    role: "user",
    sessionID: SESSION_ID,
    time: { created: 0 },
    agent: "primary",
    model: { providerID: "p" as never, modelID: "m" as never, variant: undefined },
  } as SessionV1.User
}

function mockAssistant(finish: string | undefined, opts: Partial<SessionV1.Assistant> = {}): SessionV1.Assistant {
  return {
    id: ASSISTANT_ID,
    role: "assistant",
    sessionID: SESSION_ID,
    parentID: USER_ID,
    agent: "primary",
    providerID: "p" as never,
    modelID: "m" as never,
    finish,
    time: { created: 0 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...opts,
  } as SessionV1.Assistant
}

interface MockOpts {
  config: { stopRecovery?: object }
  pendingTodos?: Array<{ status: string }>
  doomLoop?: boolean
  assistantParts?: SessionV1.Part[]
}

function makeServices(opts: MockOpts) {
  const published: any[] = []
  const updatedMessages: any[] = []
  const updatedParts: any[] = []

  const sessions = {
    updateMessage: (m: any) => Effect.sync(() => {
      updatedMessages.push(m)
      return m
    }),
    updatePart: (p: any) => Effect.sync(() => {
      updatedParts.push(p)
      return p
    }),
    get: () => Effect.die("not used"),
    messages: () => Effect.die("not used"),
  }
  const agents = {
    get: (name: string) => Effect.succeed({ name, steps: 50 } as any),
    list: () => Effect.succeed([] as any),
    defaultInfo: () => Effect.die("not used"),
    defaultAgent: () => Effect.die("not used"),
  }
  const permission = {
    list: () => Effect.succeed(
      opts.doomLoop ? [{ permission: "doom_loop", sessionID: SESSION_ID } as any] : ([] as any),
    ),
    ask: () => Effect.die("not used"),
    reply: () => Effect.die("not used"),
  }
  const events = {
    publish: (def: any, data: any) => Effect.sync(() => {
      published.push({ type: def.type, data })
      return data
    }),
  }
  const config = {
    get: () => Effect.succeed(opts.config as any),
  }
  const todo = {
    get: (_id: string) => Effect.succeed((opts.pendingTodos ?? []) as any),
  }

  return { sessions, agents, permission, events, config, todo, published, updatedMessages, updatedParts }
}

function mockInput(finish: string | undefined, assistantParts: SessionV1.Part[] = []) {
  const user = mockUser()
  const assistant = mockAssistant(finish)
  const assistantMsg: SessionV1.WithParts = {
    info: assistant,
    parts: assistantParts,
  } as SessionV1.WithParts
  return {
    sessionID: SESSION_ID,
    msgs: [{ info: user, parts: [] } as any, assistantMsg],
    lastUser: user,
    lastAssistant: assistant,
    lastAssistantMsg: assistantMsg,
    step: 0,
    compactionPending: false,
  }
}

describe("StopRecovery shell `decide` (FORK FEATURE 9, B/C/E)", () => {
  test("E1: master-off => no injection, no events, returns end", async () => {
    const svc = makeServices({ config: {} })
    const result = await Effect.runPromise(decide(mockInput("length"), svc as any))
    expect(result).toBe("end")
    expect(svc.published).toHaveLength(0)
    expect(svc.updatedMessages).toHaveLength(0)
  })

  test("B1: length finish => injects continue, returns injected, copies agent/model", async () => {
    const svc = makeServices({ config: { stopRecovery: { enabled: true } } })
    const result = await Effect.runPromise(decide(mockInput("length"), svc as any))
    expect(result).toBe("injected")
    expect(svc.updatedMessages).toHaveLength(1)
    const msg = svc.updatedMessages[0]
    expect(msg.role).toBe("user")
    expect(msg.agent).toBe("primary")
    expect(msg.model).toEqual({ providerID: "p", modelID: "m", variant: undefined })
    expect(svc.updatedParts).toHaveLength(1)
    const part = svc.updatedParts[0]
    expect(part.type).toBe("text")
    expect(part.synthetic).toBe(true)
    expect(part.metadata?.stop_recovery_continue).toBe(true)
    expect(part.metadata?.stop_recovery?.trigger).toBe("length")
    expect(svc.published).toHaveLength(1)
    expect(svc.published[0].type).toBe("session.next.stop_recovery")
    expect(svc.published[0].data.action).toBe("continue")
    expect(svc.published[0].data.trigger).toBe("length")
  })

  test("C1: stop + non-empty text + pending todos => nudge_grace injection", async () => {
    const textPart = { type: "text", text: "I'm done." } as any
    const svc = makeServices({
      config: { stopRecovery: { enabled: true } },
      pendingTodos: [{ status: "pending" }],
    })
    const result = await Effect.runPromise(decide(mockInput("stop", [textPart]), svc as any))
    expect(result).toBe("injected")
    expect(svc.published[0].data.action).toBe("nudge_grace")
    expect(svc.published[0].data.trigger).toBe("no_tool")
  })

  test("E9: unknown finish => observed event, no injection, returns end", async () => {
    const svc = makeServices({ config: { stopRecovery: { enabled: true } } })
    const result = await Effect.runPromise(decide(mockInput("unknown"), svc as any))
    expect(result).toBe("end")
    expect(svc.updatedMessages).toHaveLength(0)
    expect(svc.published).toHaveLength(1)
    expect(svc.published[0].data.action).toBe("observed")
    expect(svc.published[0].data.trigger).toBe("unknown_finish")
  })

  test("C3: stop + non-empty text + no pending todos => no injection", async () => {
    const textPart = { type: "text", text: "done." } as any
    const svc = makeServices({
      config: { stopRecovery: { enabled: true } },
      pendingTodos: [],
    })
    const result = await Effect.runPromise(decide(mockInput("stop", [textPart]), svc as any))
    expect(result).toBe("end")
    expect(svc.published).toHaveLength(0)
  })

  test("C9: doom_loop pending => no injection", async () => {
    const textPart = { type: "text", text: "done." } as any
    const svc = makeServices({
      config: { stopRecovery: { enabled: true } },
      pendingTodos: [{ status: "pending" }],
      doomLoop: true,
    })
    const result = await Effect.runPromise(decide(mockInput("stop", [textPart]), svc as any))
    expect(result).toBe("end")
    expect(svc.published).toHaveLength(0)
  })

  test("C2: halt at limit sets StopRecoveryError", async () => {
    const textPart = { type: "text", text: "done." } as any
    const svc = makeServices({
      config: { stopRecovery: { enabled: true, noToolNudge: { limit: 1, graceRetry: false } } },
      pendingTodos: [{ status: "pending" }],
    })
    // first nudge (limit 1, no grace) -> nudge attempt 1
    let r = await Effect.runPromise(decide(mockInput("stop", [textPart]), svc as any))
    expect(r).toBe("injected")
    // second -> halt
    svc.updatedMessages.length = 0
    svc.updatedParts.length = 0
    r = await Effect.runPromise(decide(mockInput("stop", [textPart]), svc as any))
    expect(r).toBe("end")
    expect(svc.updatedMessages).toHaveLength(1)
    expect(svc.updatedMessages[0].error?.name).toBe("StopRecoveryError")
    expect(svc.published.at(-1).data.action).toBe("halt")
  })

  test("B6: length + empty text + reasoning => empty_after_thinking nudge", async () => {
    const reasoningPart = { type: "reasoning", id: "prt_r", text: "thinking..." } as any
    const svc = makeServices({ config: { stopRecovery: { enabled: true } } })
    const input = mockInput("length", [reasoningPart])
    input.lastAssistant.tokens = { input: 0, output: 0, reasoning: 100, cache: { read: 0, write: 0 } } as any
    const result = await Effect.runPromise(decide(input, svc as any))
    expect(result).toBe("injected")
    expect(svc.published[0].data.trigger).toBe("empty_after_thinking")
    expect(svc.published[0].data.reasoning_only).toBe(true)
  })

  test("abort cleanup clears per-session counters before a later turn", async () => {
    const textPart = { type: "text", text: "done." } as any
    const svc = makeServices({
      config: { stopRecovery: { enabled: true } },
      pendingTodos: [{ status: "pending" }],
    })
    let result = await Effect.runPromise(decide(mockInput("stop", [textPart]), svc as any))
    expect(result).toBe("injected")
    expect(svc.published.at(-1).data.action).toBe("nudge_grace")

    result = await Effect.runPromise(decide(mockInput("stop", [textPart]), svc as any))
    expect(result).toBe("injected")
    expect(svc.published.at(-1).data.action).toBe("nudge")

    clearState(SESSION_ID)
    result = await Effect.runPromise(decide(mockInput("stop", [textPart]), svc as any))
    expect(result).toBe("injected")
    expect(svc.published.at(-1).data.action).toBe("nudge_grace")
  })
})