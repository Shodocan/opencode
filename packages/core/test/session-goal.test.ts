import { describe, expect, test } from "bun:test"
import { SessionGoal } from "../src/session/goal"

// FORK FEATURE (13) autonomy-stack / L4 — pure fold tests (spec D-2, D-3, D-6, E-14, E-11).

const snap = (over: Partial<SessionGoal.Snapshot> = {}): SessionGoal.Snapshot => ({
  goalID: "gol_1",
  revision: 1,
  objective: "ship the autonomy stack",
  phase: "active",
  maxRounds: 10,
  maxTokens: 100_000,
  roundsStarted: 0,
  tokensUsed: 0,
  ...over,
})

describe("goal fold — snapshot-not-diff (D-2)", () => {
  test("one event is a total decode: no prior events required", () => {
    // The D-2 criterion: reconstruction from an ARBITRARY offset without
    // reading anything before it.
    const mid = snap({ revision: 7, roundsStarted: 6, tokensUsed: 42_000, phase: "paused" })
    expect(SessionGoal.fromEvent(mid)).toEqual(mid)
  })

  test("fold over a full history returns the last snapshot verbatim", () => {
    const history = [1, 2, 3].map((r) => snap({ revision: r, roundsStarted: r - 1 }))
    expect(SessionGoal.fold(history)).toEqual(history[2]!)
  })

  test("fold of an empty history is undefined, not a fabricated goal", () => {
    expect(SessionGoal.fold([])).toBeUndefined()
  })
})

describe("revision validation is loud (D-3)", () => {
  test("a gap is rejected", () => {
    const a = snap({ revision: 1 })
    expect(() => SessionGoal.apply(a, snap({ revision: 3 }))).toThrow(SessionGoal.GoalRevisionError)
  })

  test("a duplicate is rejected — silently applying it would corrupt round accounting", () => {
    const a = snap({ revision: 1 })
    expect(() => SessionGoal.apply(a, snap({ revision: 1 }))).toThrow(SessionGoal.GoalRevisionError)
  })

  test("out-of-order is rejected", () => {
    const a = snap({ revision: 5 })
    expect(() => SessionGoal.apply(a, snap({ revision: 4 }))).toThrow(SessionGoal.GoalRevisionError)
  })

  test("the first event must be revision 1", () => {
    expect(() => SessionGoal.apply(undefined, snap({ revision: 2 }))).toThrow(SessionGoal.GoalRevisionError)
    expect(SessionGoal.apply(undefined, snap({ revision: 1 })).revision).toBe(1)
  })

  test("the error names expected, received and goal", () => {
    try {
      SessionGoal.apply(snap({ revision: 1 }), snap({ revision: 9 }))
      throw new Error("should have thrown")
    } catch (e) {
      const err = e as SessionGoal.GoalRevisionError
      expect(err.expected).toBe(2)
      expect(err.received).toBe(9)
      expect(err.goalID).toBe("gol_1")
    }
  })
})

describe("activation is never persisted (D-6)", () => {
  test("a fresh process is disarmed with reason 'load' even for an active goal", () => {
    const replayed = SessionGoal.fold([snap({ phase: "active" })])
    expect(replayed!.phase).toBe("active")
    // ...and activation is NOT derived from it:
    const activation = SessionGoal.initialActivation()
    expect(activation.armed).toBe(false)
    expect(activation.disarmReason).toBe("load")
  })

  test("the snapshot type carries no activation field", () => {
    const keys = Object.keys(snap())
    expect(keys).not.toContain("armed")
    expect(keys).not.toContain("activation")
    expect(keys).not.toContain("disarmReason")
  })
})

describe("E-14 two-reason re-arm (the F1 blocker resolution)", () => {
  test("load-disarm re-arms on any evaluated turn", () => {
    const a = SessionGoal.disarm("load")
    expect(SessionGoal.rearm(a, "turn").armed).toBe(true)
  })

  test("abort-disarm is NOT cleared by an evaluated turn — this is what S-9 requires", () => {
    const a = SessionGoal.disarm("abort")
    expect(SessionGoal.rearm(a, "turn").armed).toBe(false)
    expect(SessionGoal.rearm(a, "turn").disarmReason).toBe("abort")
  })

  test("abort-disarm re-arms only via the explicit resume verb", () => {
    const a = SessionGoal.disarm("abort")
    expect(SessionGoal.rearm(a, "resume").armed).toBe(true)
  })

  test("crossing paths: restart+turn arms, abort+unrelated turn does not", () => {
    expect(SessionGoal.rearm(SessionGoal.initialActivation(), "turn").armed).toBe(true)
    expect(SessionGoal.rearm(SessionGoal.disarm("abort"), "turn").armed).toBe(false)
  })

  test("re-arming an already-armed activation is a no-op", () => {
    const armed = { armed: true } as const
    expect(SessionGoal.rearm(armed, "turn")).toBe(armed)
  })
})

describe("C2 dual budget (E-11)", () => {
  test("round cap trips with its own code and message", () => {
    const b = SessionGoal.budgetExceeded(snap({ roundsStarted: 10, maxRounds: 10 }))
    expect(b?.code).toBe("round_budget_exceeded")
    expect(b?.message).toContain("10")
  })

  test("token cap trips with its own code", () => {
    const b = SessionGoal.budgetExceeded(snap({ tokensUsed: 100_000, maxTokens: 100_000 }))
    expect(b?.code).toBe("token_budget_exceeded")
  })

  test("whichever trips first — rounds are checked before tokens", () => {
    const b = SessionGoal.budgetExceeded(snap({ roundsStarted: 10, maxRounds: 10, tokensUsed: 999_999 }))
    expect(b?.code).toBe("round_budget_exceeded")
  })

  test("a goal under both caps may still run", () => {
    expect(SessionGoal.budgetExceeded(snap({ roundsStarted: 3, tokensUsed: 10 }))).toBeUndefined()
  })

  test("budget codes are distinguishable from the C3 halt code (OQ7 depends on it)", () => {
    const budget = SessionGoal.budgetExceeded(snap({ roundsStarted: 10, maxRounds: 10 }))
    expect(budget?.code).not.toBe("halted")
    expect(budget?.code).not.toBe("model_reported")
  })
})

describe("terminal phases", () => {
  test("blocked and complete are terminal; active and paused are not", () => {
    expect(SessionGoal.isTerminal(snap({ phase: "blocked" }))).toBe(true)
    expect(SessionGoal.isTerminal(snap({ phase: "complete" }))).toBe(true)
    expect(SessionGoal.isTerminal(snap({ phase: "active" }))).toBe(false)
    expect(SessionGoal.isTerminal(snap({ phase: "paused" }))).toBe(false)
  })
})
