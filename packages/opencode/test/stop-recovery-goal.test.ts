import { describe, expect, test } from "bun:test"
import { StopRecovery } from "../src/session/stop-recovery"
import { SessionGoal } from "@opencode-ai/core/session/goal"

// FORK FEATURE (13) autonomy-stack / L4 — evaluateGoal (spec E-2..E-4, E-6..E-8,
// E-11..E-14, C3, C3a, D-16). Pure-table tests only: anything that observes a
// DISPATCHED round through runLoop belongs to Step 13 (P5).

const GOAL_ON = { enabled: true, maxRounds: 10, maxTokens: 100_000 }

const cfg = (over: Partial<StopRecovery.Config> = {}): StopRecovery.Config => ({
  enabled: true,
  goal: GOAL_ON,
  lengthContinue: { enabled: true, max: 3 },
  noToolNudge: { enabled: true, limit: 3, graceRetry: true },
  emptyAfterThinking: { enabled: true },
  ...over,
})

const snap = (over: Partial<SessionGoal.Snapshot> = {}): SessionGoal.Snapshot => ({
  goalID: "gol_1",
  revision: 1,
  objective: "ship it",
  phase: "active",
  maxRounds: 10,
  maxTokens: 100_000,
  roundsStarted: 0,
  tokensUsed: 0,
  ...over,
})

const facts = (over: Partial<StopRecovery.TurnFacts> = {}): StopRecovery.TurnFacts => ({
  turnKey: "t1",
  finish: "stop",
  hasError: false,
  hasToolCalls: false,
  hasProviderExecutedTools: false,
  textEmpty: false,
  reasoningPresent: false,
  pendingTodos: false, // no todo => stop-recovery has nothing to say => policy exit
  step: 0,
  maxSteps: 100,
  isJsonSchemaTurn: false,
  agentDisabled: false,
  doomLoopPending: false,
  compactionPending: false,
  goal: { snapshot: snap(), activation: { armed: true } },
  ...over,
})

const st = () => StopRecovery.initialState("t1")

describe("E-13 — a round is proposed for an active, armed goal", () => {
  test("returns goal_round carrying the round it starts", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts())
    expect(d?.action).toBe("goal_round")
    if (d?.action === "goal_round") expect(d.roundsStarted).toBe(1)
  })

  test("roundsStarted is snapshot + 1, not a counter in State", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap({ roundsStarted: 6 }), activation: { armed: true } } }))
    if (d?.action === "goal_round") expect(d.roundsStarted).toBe(7)
  })

  test("[F5] isOverflow is carried so the round can prefer a fresh context", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts({ isOverflow: true }))
    if (d?.action === "goal_round") expect(d.overflow).toBe(true)
  })
})

describe("E-8 / T-2 — goal decisions never touch StopRecovery.State", () => {
  test("lengthContinues and noProgressCount are unchanged by a goal round", () => {
    const state = st()
    StopRecovery.evaluateGoal(cfg(), state, facts())
    expect(state).toEqual(StopRecovery.initialState("t1"))
  })

  test("...and unchanged when the goal is blocked by budget", () => {
    const state = st()
    StopRecovery.evaluateGoal(cfg(), state, facts({ goal: { snapshot: snap({ roundsStarted: 10 }), activation: { armed: true } } }))
    expect(state.lengthContinues).toBe(0)
    expect(state.noProgressCount).toBe(0)
    expect(state.graceUsed).toBe(false)
  })
})

describe("T-3 — upgrade-only: the goal branch never rewrites a stop-recovery decision", () => {
  test("a turn stop-recovery acts on never reaches the goal branch", () => {
    // pendingTodos true + stop finish => no_tool family => a real decision.
    const composed = StopRecovery.evaluate(cfg(), undefined, facts({ pendingTodos: true }))
    expect(["nudge", "nudge_grace"]).toContain(composed.decision.action)
  })

  test("halt wins over a goal round (frozen C3)", () => {
    const c = cfg({ noToolNudge: { enabled: true, limit: 1, graceRetry: false } })
    const state = st()
    StopRecovery.evaluateStopRecovery(c, state, facts({ pendingTodos: true })) // -> nudge, count 1
    const composed = StopRecovery.evaluate(c, state, facts({ pendingTodos: true }))
    expect(composed.decision.action).toBe("halt")
  })
})

describe("E-11 — C2 dual budget with distinct codes", () => {
  test("round cap blocks with round_budget_exceeded", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap({ roundsStarted: 10 }), activation: { armed: true } } }))
    expect(d?.action).toBe("goal_blocked")
    if (d?.action === "goal_blocked") expect(d.code).toBe("round_budget_exceeded")
  })

  test("token cap blocks with token_budget_exceeded", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap({ tokensUsed: 100_000 }), activation: { armed: true } } }))
    if (d?.action === "goal_blocked") expect(d.code).toBe("token_budget_exceeded")
  })

  test("the budget is checked BEFORE starting a round — it caps rounds started", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap({ roundsStarted: 9 }), activation: { armed: true } } }))
    expect(d?.action).toBe("goal_round") // the 10th is allowed
    const d2 = StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap({ roundsStarted: 10 }), activation: { armed: true } } }))
    expect(d2?.action).toBe("goal_blocked") // the 11th is not
  })
})

describe("E-6 / T-4 (C3a) — a long goal reaches its budget, not the nudge limit", () => {
  test("10 stalled rounds all yield goal_round; the nudge counter never advances", () => {
    // The C3a hazard: noProgressCount accumulating across rounds would halt the
    // goal at ~3. Because evaluateGoal never touches it, that cannot happen here;
    // the shell's onProgress() reset at each round boundary (Step 13) closes the
    // remaining half for turns stop-recovery also acts on.
    const state = st()
    for (let round = 0; round < 10; round++) {
      const d = StopRecovery.evaluateGoal(cfg(), state, facts({ goal: { snapshot: snap({ roundsStarted: round }), activation: { armed: true } } }))
      expect(d?.action).toBe("goal_round")
    }
    expect(state.noProgressCount).toBe(0)
  })
})

describe("E-14 — two-reason activation ([F1] / (P1))", () => {
  test("a load-disarm is cleared by the turn: the round fires", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap(), activation: SessionGoal.disarm("load") } }))
    expect(d?.action).toBe("goal_round")
  })

  test("an abort-disarm is NOT cleared by a turn: no round (S-9)", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap(), activation: SessionGoal.disarm("abort") } }))
    expect(d).toBeUndefined()
  })
})

describe("E-2 / phase and signal gating", () => {
  for (const phase of ["paused", "blocked", "complete"] as const) {
    test(`phase ${phase} fires no round`, () => {
      expect(
        StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap({ phase }), activation: { armed: true } } })),
      ).toBeUndefined()
    })
  }

  test("a completion signalled this turn ends it — the model's own call is authority", () => {
    const d = StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: { snapshot: snap(), activation: { armed: true }, completionSignalled: true } }))
    expect(d).toBeUndefined()
  })

  test("no projection => inert", () => {
    expect(StopRecovery.evaluateGoal(cfg(), st(), facts({ goal: undefined }))).toBeUndefined()
  })

  test("hard gates bind the goal branch too (E-2)", () => {
    for (const over of [{ hasToolCalls: true }, { doomLoopPending: true }, { compactionPending: true }, { isJsonSchemaTurn: true }]) {
      expect(StopRecovery.evaluate(cfg(), undefined, facts(over)).decision.action).toBe("none")
    }
  })
})

describe("D-16 — per-feature enable is reciprocal", () => {
  test("stop-recovery disabled: goal rounds still fire", () => {
    const composed = StopRecovery.evaluate(cfg({ enabled: false }), undefined, facts())
    expect(composed.decision.action).toBe("goal_round")
  })

  test("goal disabled: stop-recovery still nudges", () => {
    const composed = StopRecovery.evaluate(cfg({ goal: undefined }), undefined, facts({ pendingTodos: true }))
    expect(["nudge", "nudge_grace"]).toContain(composed.decision.action)
  })

  test("per-agent goalDisabled kills goal rounds only", () => {
    expect(StopRecovery.evaluateGoal(cfg(), st(), facts({ goalDisabled: true }))).toBeUndefined()
    const composed = StopRecovery.evaluate(cfg(), undefined, facts({ goalDisabled: true, pendingTodos: true }))
    expect(["nudge", "nudge_grace"]).toContain(composed.decision.action)
  })

  test("per-agent agentDisabled kills stop-recovery only", () => {
    const composed = StopRecovery.evaluate(cfg(), undefined, facts({ agentDisabled: true }))
    expect(composed.decision.action).toBe("goal_round")
  })
})
