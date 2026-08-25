import { describe, expect, test } from "bun:test"
import { StopRecovery } from "../src/session/stop-recovery"

// FORK FEATURE (9)+(13) — Step 11 refactor guard (spec E-1 as narrowed by [F3]).
// evaluate() is now hardGates() / evaluateStopRecovery() / evaluateGoal() composed.
// These rows pin the composition itself, so a later change to one part cannot
// silently alter the whole.

const ON: StopRecovery.Config = {
  enabled: true,
  lengthContinue: { enabled: true, max: 3 },
  noToolNudge: { enabled: true, limit: 3, graceRetry: true },
  emptyAfterThinking: { enabled: true },
}

const facts = (over: Partial<StopRecovery.TurnFacts> = {}): StopRecovery.TurnFacts => ({
  turnKey: "t1",
  finish: "stop",
  hasError: false,
  hasToolCalls: false,
  hasProviderExecutedTools: false,
  textEmpty: false,
  reasoningPresent: false,
  pendingTodos: true,
  step: 0,
  maxSteps: 100,
  isJsonSchemaTurn: false,
  agentDisabled: false,
  doomLoopPending: false,
  compactionPending: false,
  ...over,
})

describe("hardGates (E-2) — every gate blocks ALL branches", () => {
  const gated: Array<[string, Partial<StopRecovery.TurnFacts>]> = [
    ["agentDisabled", { agentDisabled: true }],
    ["isJsonSchemaTurn", { isJsonSchemaTurn: true }],
    ["compactionPending", { compactionPending: true }],
    ["doomLoopPending", { doomLoopPending: true }],
    ["hasToolCalls", { hasToolCalls: true }],
    ["hasError", { hasError: true }],
    ["content-filter finish", { finish: "content-filter" }],
    ["error finish", { finish: "error" }],
    ["at maxSteps", { step: 99, maxSteps: 100 }],
  ]
  for (const [name, over] of gated) {
    test(`${name} gates`, () => {
      expect(StopRecovery.hardGates(ON, facts(over))).toBe(true)
      expect(StopRecovery.evaluate(ON, undefined, facts(over)).decision.action).toBe("none")
    })
  }

  test("feature disabled gates", () => {
    expect(StopRecovery.hardGates({ ...ON, enabled: false }, facts())).toBe(true)
  })

  test("a normal turn is not gated", () => {
    expect(StopRecovery.hardGates(ON, facts())).toBe(false)
  })
})

describe("evaluateGoal is inert until Step 12", () => {
  const rows = [facts(), facts({ finish: "length" }), facts({ finish: undefined }), facts({ textEmpty: true, reasoningPresent: true })]
  for (const [i, f] of rows.entries()) {
    test(`row ${i} returns undefined`, () => {
      expect(StopRecovery.evaluateGoal(ON, StopRecovery.initialState(f.turnKey), f)).toBeUndefined()
    })
  }
})

describe("composition == the sum of its parts", () => {
  const rows: StopRecovery.TurnFacts[] = [
    facts(),
    facts({ finish: "length" }),
    facts({ finish: "length", textEmpty: true, reasoningPresent: true }),
    facts({ finish: undefined }),
    facts({ finish: "unknown" }),
    facts({ textEmpty: true, reasoningPresent: true }),
    facts({ pendingTodos: false }),
    facts({ hasProviderExecutedTools: true }),
    facts({ agentDisabled: true }),
    facts({ hasToolCalls: true }),
  ]

  for (const [i, f] of rows.entries()) {
    test(`row ${i}: evaluate() equals manual composition`, () => {
      // manual composition, mirroring evaluate()
      const manualState = StopRecovery.initialState(f.turnKey)
      let manual: StopRecovery.Decision = { action: "none" }
      if (!StopRecovery.hardGates(ON, f)) {
        manual =
          StopRecovery.evaluateStopRecovery(ON, manualState, f) ??
          StopRecovery.evaluateGoal(ON, manualState, f) ?? { action: "none" }
      }
      const composed = StopRecovery.evaluate(ON, undefined, f)
      expect(composed.decision).toEqual(manual)
      expect(composed.state).toEqual(manualState)
    })
  }
})

describe("the halt return is owned by stop-recovery, not the goal branch (C3)", () => {
  test("halt comes from evaluateStopRecovery and evaluateGoal never sees that turn", () => {
    // drive to the nudge limit
    const state = StopRecovery.initialState("t1")
    const cfg: StopRecovery.Config = { ...ON, noToolNudge: { enabled: true, limit: 1, graceRetry: false } }
    const first = StopRecovery.evaluateStopRecovery(cfg, state, facts())
    expect(first?.action).toBe("nudge")
    const second = StopRecovery.evaluateStopRecovery(cfg, state, facts())
    expect(second?.action).toBe("halt")
    // halt is a real decision, so evaluate() returns it and the goal branch is
    // never consulted -- structurally, not by convention.
    expect(StopRecovery.evaluate(cfg, state, facts()).decision.action).toBe("halt")
  })
})
