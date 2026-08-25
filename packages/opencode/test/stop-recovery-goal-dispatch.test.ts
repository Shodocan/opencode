import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { clearState, decide, MARKER } from "../src/session/stop-recovery"
import { SessionGoalShell } from "../src/session/goal-service"
import { SessionV1, MessageID } from "@opencode-ai/core/v1/session"
import { SessionID } from "@opencode-ai/schema/session-id"

// FORK FEATURE (13) autonomy-stack / L4 — Step 13 shell dispatch (E-5, E-9, D-11,
// C3, C3a, T-5, T-6). Mock services; the pure branch itself is covered in
// stop-recovery-goal.test.ts.

const SESSION_ID = SessionID.make("ses_goal_dispatch")
const USER_ID = MessageID.ascending()
const ASSISTANT_ID = MessageID.ascending()

afterEach(() => clearState(SESSION_ID))

const snapshot = (over: Record<string, unknown> = {}) => ({
  goalID: "gol_1",
  revision: 1,
  objective: "ship it",
  phase: "active" as const,
  maxRounds: 10,
  maxTokens: 100_000,
  roundsStarted: 0,
  tokensUsed: 0,
  ...over,
})

function mockGoalShell(projection: any) {
  const calls: any[] = []
  const impl = {
    read: () => Effect.succeed(projection),
    startRound: (id: string) => Effect.sync(() => void calls.push({ fn: "startRound", id })),
    block: (id: string, code: string, message: string) =>
      Effect.sync(() => void calls.push({ fn: "block", id, code, message })),
    disarm: () => Effect.void,
    resume: () => Effect.succeed(true),
  }
  return { calls, layer: Layer.succeed(SessionGoalShell.Service, impl as never) }
}

function services(config: any) {
  const published: any[] = []
  const updatedParts: any[] = []
  return {
    published,
    updatedParts,
    svc: {
      sessions: {
        updateMessage: (m: any) => Effect.sync(() => m),
        updatePart: (p: any) => Effect.sync(() => (updatedParts.push(p), p)),
      },
      agents: { get: (name: string) => Effect.succeed({ name, steps: 50 } as any) },
      permission: { list: () => Effect.succeed([] as any) },
      events: { publish: (def: any, data: any) => Effect.sync(() => (published.push({ type: def.type, data }), data)) },
      config: { get: () => Effect.succeed(config) },
      todo: { get: () => Effect.succeed([] as any) },
    } as any,
  }
}

const input = () => {
  const lastUser = {
    id: USER_ID,
    role: "user",
    sessionID: SESSION_ID,
    agent: "build",
    model: { providerID: "p", modelID: "m" },
    time: { created: 1 },
  } as unknown as SessionV1.User
  const lastAssistant = {
    id: ASSISTANT_ID,
    role: "assistant",
    sessionID: SESSION_ID,
    parentID: USER_ID,
    finish: "stop",
    time: { created: 2 },
  } as unknown as SessionV1.Assistant
  return {
    sessionID: SESSION_ID,
    msgs: [{ info: lastUser, parts: [{ type: "text", text: "do it" }] }] as any,
    lastUser,
    lastAssistant,
    lastAssistantMsg: { info: lastAssistant, parts: [{ type: "text", text: "done." }] } as any,
    step: 0,
    compactionPending: false,
  }
}

const GOAL_CFG = { goal: { enabled: true, maxRounds: 10, maxTokens: 100_000 } }

describe("E-9 — goal_round dispatch", () => {
  test("persists the round, injects a synthetic message, and re-enters the loop", async () => {
    const goal = mockGoalShell({ snapshot: snapshot(), activation: { armed: true } })
    const { svc, updatedParts } = services(GOAL_CFG)
    const result = await Effect.runPromise(
      decide(input(), svc).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>,
    )
    expect(result).toBe("injected")
    expect(goal.calls.map((c) => c.fn)).toContain("startRound")
    expect(updatedParts).toHaveLength(1)
    expect(updatedParts[0].synthetic).toBe(true)
  })

  test("T-6: the round reuses the stop_recovery_continue MARKER", async () => {
    // A NEW marker would silently bypass compaction's isSyntheticContinuation,
    // making every round a fresh compaction TURN and letting the overflow replay
    // picker slice away the user's original request. Goal rounds are
    // differentiated by the `goal` metadata sub-object instead.
    const goal = mockGoalShell({ snapshot: snapshot(), activation: { armed: true } })
    const { svc, updatedParts } = services(GOAL_CFG)
    await Effect.runPromise(decide(input(), svc).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>)
    expect(updatedParts[0].metadata[MARKER]).toBe(true)
    expect(updatedParts[0].metadata.goal.roundsStarted).toBe(1)
  })

  test("the injected message carries agent and model forward", async () => {
    const goal = mockGoalShell({ snapshot: snapshot(), activation: { armed: true } })
    const { svc } = services(GOAL_CFG)
    let captured: any
    svc.sessions.updateMessage = (m: any) => Effect.sync(() => ((captured = m), m))
    await Effect.runPromise(decide(input(), svc).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>)
    expect(captured.agent).toBe("build")
    expect(captured.model).toEqual({ providerID: "p", modelID: "m" })
  })
})

describe("E-11 / D-5 — goal_blocked dispatch", () => {
  test("budget exhaustion persists blocked with its own code and does NOT inject", async () => {
    const goal = mockGoalShell({ snapshot: snapshot({ roundsStarted: 10 }), activation: { armed: true } })
    const { svc, updatedParts } = services(GOAL_CFG)
    const result = await Effect.runPromise(
      decide(input(), svc).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>,
    )
    expect(result).toBe("end")
    expect(updatedParts).toHaveLength(0)
    const blocked = goal.calls.find((c) => c.fn === "block")
    expect(blocked.code).toBe("round_budget_exceeded")
    expect(blocked.message).toContain("10")
  })
})

describe("C3 / T-5 — halt is terminal and blocks the goal", () => {
  test("a halt turn blocks the active goal with code 'halted' and fires no round", async () => {
    const goal = mockGoalShell({ snapshot: snapshot(), activation: { armed: true } })
    const cfg = {
      ...GOAL_CFG,
      stopRecovery: { enabled: true, noToolNudge: { limit: 1, graceRetry: false } },
    }
    const { svc } = services(cfg)
    const withTodos = { ...svc, todo: { get: () => Effect.succeed([{ status: "pending" }] as any) } }
    // first turn -> nudge (count 1)
    await Effect.runPromise(decide(input(), withTodos as any).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>)
    // second -> halt
    const result = await Effect.runPromise(
      decide(input(), withTodos as any).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>,
    )
    expect(result).toBe("end")
    const blocked = goal.calls.find((c) => c.fn === "block")
    expect(blocked?.code).toBe("halted")
    expect(goal.calls.some((c) => c.fn === "startRound")).toBe(false)
  })
})

describe("E-14 — an abort-disarm fires no round (S-9)", () => {
  test("abort-disarmed goal: the turn does not re-arm it", async () => {
    const goal = mockGoalShell({ snapshot: snapshot(), activation: { armed: false, disarmReason: "abort" } })
    const { svc, updatedParts } = services(GOAL_CFG)
    const result = await Effect.runPromise(
      decide(input(), svc).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>,
    )
    expect(result).toBe("end")
    expect(updatedParts).toHaveLength(0)
    expect(goal.calls).toHaveLength(0)
  })

  test("F1 (a): a load-disarmed goal DOES re-arm on an evaluated turn", async () => {
    // The restart case: replay found phase==active, activation reset to
    // disarmed/"load", and one ordinary turn must start a round.
    const goal = mockGoalShell({ snapshot: snapshot(), activation: { armed: false, disarmReason: "load" } })
    const { svc } = services(GOAL_CFG)
    const result = await Effect.runPromise(
      decide(input(), svc).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>,
    )
    expect(result).toBe("injected")
    expect(goal.calls.some((c) => c.fn === "startRound")).toBe(true)
  })
})

describe("D-13 — the evaluator runs with stop-recovery OFF", () => {
  test("goal rounds fire when only goal.enabled is set", async () => {
    const goal = mockGoalShell({ snapshot: snapshot(), activation: { armed: true } })
    const { svc } = services({ goal: { enabled: true }, stopRecovery: { enabled: false } })
    const result = await Effect.runPromise(
      decide(input(), svc).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>,
    )
    expect(result).toBe("injected")
  })

  test("both features off => no-op, no goal read", async () => {
    const goal = mockGoalShell({ snapshot: snapshot(), activation: { armed: true } })
    const { svc } = services({})
    const result = await Effect.runPromise(
      decide(input(), svc).pipe(Effect.provide(goal.layer)) as Effect.Effect<any, never, never>,
    )
    expect(result).toBe("end")
    expect(goal.calls).toHaveLength(0)
  })
})
