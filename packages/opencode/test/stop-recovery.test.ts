import { describe, expect, test } from "bun:test"
import { StopRecovery } from "../src/session/stop-recovery"

// FORK FEATURE (9) stop-recovery — pure decision module table tests.
// Covers spec §5.0-§5.6 acceptance rows: gates, step eligibility, unknown
// finish (observed), length family, nudge family (grace/limit/halt), shared
// counters, turnKey reset, onProgress reset.

const ON: StopRecovery.Config = {
  enabled: true,
  lengthContinue: { enabled: true, max: 3 },
  noToolNudge: { enabled: true, limit: 3, graceRetry: true },
  emptyAfterThinking: { enabled: true },
}
const OFF: StopRecovery.Config = { ...ON, enabled: false }

function facts(partial: Partial<StopRecovery.TurnFacts>): StopRecovery.TurnFacts {
  return {
    turnKey: "t1",
    finish: "stop",
    hasError: false,
    hasToolCalls: false,
    hasProviderExecutedTools: false,
    textEmpty: false,
    reasoningPresent: false,
    pendingTodos: true,
    step: 0,
    maxSteps: Infinity,
    isJsonSchemaTurn: false,
    agentDisabled: false,
    doomLoopPending: false,
    compactionPending: false,
    ...partial,
  }
}

function eval1(config: StopRecovery.Config, state: StopRecovery.State | undefined, f: StopRecovery.TurnFacts) {
  return StopRecovery.evaluate(config, state, f)
}

describe("StopRecovery pure decision (FORK FEATURE 9)", () => {
  describe("gates -> none", () => {
    test("master disabled (E1)", () => {
      expect(eval1(OFF, undefined, facts({ finish: "length" })).decision).toEqual({ action: "none" })
      expect(eval1(OFF, undefined, facts({ finish: "stop" })).decision).toEqual({ action: "none" })
    })
    test("agent disabled (C8)", () => {
      expect(eval1(ON, undefined, facts({ agentDisabled: true, finish: "length" })).decision).toEqual({ action: "none" })
    })
    test("json_schema turn (E2)", () => {
      expect(eval1(ON, undefined, facts({ isJsonSchemaTurn: true, finish: "stop" })).decision).toEqual({ action: "none" })
    })
    test("compaction pending (E3)", () => {
      expect(eval1(ON, undefined, facts({ compactionPending: true, finish: "length" })).decision).toEqual({ action: "none" })
    })
    test("doom_loop pending (C9)", () => {
      expect(eval1(ON, undefined, facts({ doomLoopPending: true, finish: "stop" })).decision).toEqual({ action: "none" })
    })
    test("hasToolCalls (C7) -> none", () => {
      expect(eval1(ON, undefined, facts({ hasToolCalls: true, finish: "stop" })).decision).toEqual({ action: "none" })
    })
    test("hasError -> none", () => {
      expect(eval1(ON, undefined, facts({ hasError: true, finish: "stop" })).decision).toEqual({ action: "none" })
    })
    test("content-filter finish -> none", () => {
      expect(eval1(ON, undefined, facts({ finish: "content-filter" })).decision).toEqual({ action: "none" })
    })
    test("error finish -> none", () => {
      expect(eval1(ON, undefined, facts({ finish: "error" })).decision).toEqual({ action: "none" })
    })
  })

  describe("step eligibility (C5/E8)", () => {
    test("step+1 >= maxSteps -> none", () => {
      expect(eval1(ON, undefined, facts({ step: 4, maxSteps: 5, finish: "length" })).decision).toEqual({ action: "none" })
      expect(eval1(ON, undefined, facts({ step: 3, maxSteps: 4, finish: "stop" })).decision).toEqual({ action: "none" })
    })
    test("maxSteps Infinity eligible", () => {
      expect(eval1(ON, undefined, facts({ step: 100, maxSteps: Infinity, finish: "length" })).decision.action).toBe("continue")
    })
  })

  describe("unknown finish (E9)", () => {
    test("unknown -> observed, no state change", () => {
      const { decision, state } = eval1(ON, undefined, facts({ finish: "unknown" }))
      expect(decision).toEqual({ action: "observed", trigger: "unknown_finish" })
      expect(state.noProgressCount).toBe(0)
    })
    test("undefined finish -> observed", () => {
      expect(eval1(ON, undefined, facts({ finish: undefined })).decision).toEqual({ action: "observed", trigger: "unknown_finish" })
    })
    test("flag off -> no observed event (E1)", () => {
      expect(eval1(OFF, undefined, facts({ finish: "unknown" })).decision).toEqual({ action: "none" })
    })
  })

  describe("length family (B1/B5/E6)", () => {
    test("length -> continue attempt 1", () => {
      const { decision, state } = eval1(ON, undefined, facts({ finish: "length" }))
      expect(decision).toMatchObject({ action: "continue", trigger: "length", attempt: 1 })
      expect(state.lengthContinues).toBe(1)
    })
    test("chain continue->length->continue counts 2 (B5)", () => {
      let s: StopRecovery.State | undefined
      let r = eval1(ON, s, facts({ finish: "length" }))
      expect(r.decision).toMatchObject({ action: "continue", attempt: 1 })
      s = r.state
      r = eval1(ON, s, facts({ finish: "length" }))
      expect(r.decision).toMatchObject({ action: "continue", attempt: 2 })
      expect(r.state.lengthContinues).toBe(2)
    })
    test("cap exhausted -> none (turn ends normally, no halt for length)", () => {
      let s: StopRecovery.State | undefined
      for (let i = 0; i < 3; i++) s = eval1(ON, s, facts({ finish: "length" })).state
      const r = eval1(ON, s, facts({ finish: "length" }))
      expect(r.decision).toEqual({ action: "none" })
    })
    test("max:0 -> none (E6)", () => {
      const cfg: StopRecovery.Config = { ...ON, lengthContinue: { ...ON.lengthContinue, max: 0 } }
      expect(eval1(cfg, undefined, facts({ finish: "length" })).decision).toEqual({ action: "none" })
    })
    test("lengthContinue disabled -> none", () => {
      const cfg: StopRecovery.Config = { ...ON, lengthContinue: { ...ON.lengthContinue, enabled: false } }
      expect(eval1(cfg, undefined, facts({ finish: "length" })).decision).toEqual({ action: "none" })
    })
  })

  describe("reasoning-only length routing (B6)", () => {
    test("length + empty text + reasoning -> empty_after_thinking family, reasoning_only true", () => {
      const { decision, state } = eval1(ON, undefined, facts({ finish: "length", textEmpty: true, reasoningPresent: true }))
      expect(decision.action).toBe("nudge_grace")
      expect(decision).toMatchObject({ trigger: "empty_after_thinking", reasoningOnly: true, attempt: 0 })
      expect(state.lengthContinues).toBe(0)
    })
  })

  describe("nudge family (C1-C10)", () => {
    test("grace first: nudge_grace attempt 0, counter unchanged (C1)", () => {
      const { decision, state } = eval1(ON, undefined, facts({ finish: "stop" }))
      expect(decision).toMatchObject({ action: "nudge_grace", trigger: "no_tool", attempt: 0 })
      expect(state.noProgressCount).toBe(0)
      expect(state.graceUsed).toBe(true)
    })
    test("then nudge 1..limit then halt (C2)", () => {
      let s: StopRecovery.State | undefined
      let r = eval1(ON, s, facts({ finish: "stop" }))
      expect(r.decision.action).toBe("nudge_grace")
      s = r.state
      r = eval1(ON, s, facts({ finish: "stop" }))
      expect(r.decision).toMatchObject({ action: "nudge", attempt: 1 })
      s = r.state
      r = eval1(ON, s, facts({ finish: "stop" }))
      expect(r.decision).toMatchObject({ action: "nudge", attempt: 2 })
      s = r.state
      r = eval1(ON, s, facts({ finish: "stop" }))
      expect(r.decision).toMatchObject({ action: "nudge", attempt: 3 })
      s = r.state
      r = eval1(ON, s, facts({ finish: "stop" }))
      expect(r.decision).toMatchObject({ action: "halt", attempts: 3, limit: 3 })
    })
    test("graceRetry:false -> first is counted nudge (E5)", () => {
      const cfg: StopRecovery.Config = { ...ON, noToolNudge: { ...ON.noToolNudge, graceRetry: false } }
      const { decision, state } = eval1(cfg, undefined, facts({ finish: "stop" }))
      expect(decision).toMatchObject({ action: "nudge", attempt: 1 })
      expect(state.noProgressCount).toBe(1)
    })
    test("limit:0 -> never halts (C10)", () => {
      const cfg: StopRecovery.Config = { ...ON, noToolNudge: { ...ON.noToolNudge, limit: 0 } }
      let s: StopRecovery.State | undefined
      for (let i = 0; i < 10; i++) {
        const r = eval1(cfg, s, facts({ finish: "stop" }))
        expect(r.decision.action).not.toBe("halt")
        s = r.state
      }
    })
    test("no pending todos -> none (C3)", () => {
      expect(eval1(ON, undefined, facts({ finish: "stop", pendingTodos: false })).decision).toEqual({ action: "none" })
    })
    test("provider-executed tools present -> none (C7)", () => {
      expect(
        eval1(ON, undefined, facts({ finish: "stop", hasProviderExecutedTools: true })).decision,
      ).toEqual({ action: "none" })
    })
    test("empty text no reasoning -> none (not empty_after_thinking)", () => {
      expect(
        eval1(ON, undefined, facts({ finish: "stop", textEmpty: true, reasoningPresent: false })).decision,
      ).toEqual({ action: "none" })
    })
    test("empty-after-thinking fires regardless of todos (C6)", () => {
      const { decision } = eval1(
        ON,
        undefined,
        facts({ finish: "stop", textEmpty: true, reasoningPresent: true, pendingTodos: false }),
      )
      expect(decision.action).toBe("nudge_grace")
    })
  })

  describe("shared counter across families (E7)", () => {
    test("alternating no_tool and empty_after_thinking share noProgressCount", () => {
      let s: StopRecovery.State | undefined
      s = eval1(ON, s, facts({ finish: "stop", pendingTodos: true })).state // grace
      const r1 = eval1(ON, s, facts({ finish: "stop", pendingTodos: true }))
      expect(r1.state.noProgressCount).toBe(1) // nudge 1
      s = r1.state
      const r2 = eval1(ON, s, facts({ finish: "stop", textEmpty: true, reasoningPresent: true }))
      expect(r2.state.noProgressCount).toBe(2) // nudge 2, same counter
    })
  })

  // FORK FEATURE (9) + autonomy-stack Step 5 [F3]: these rows are scoped to the LEGACY recovery
  // families (length continue, no-tool nudge, empty-after-thinking) ONLY. They deliberately pin the
  // wipe-on-turnKey-change / wipe-on-clearState behaviour, which a durable goal round counter must NOT
  // share -- see spec §5.2 and research L2.2/L2.3 (turnKey rotates on compaction, which is L3's happy
  // path). Do not widen them to cover goal state.
  // TODO(autonomy-stack Step 12/13): add the mirror rows -- "goal round counter does NOT reset on
  // turnKey change" and "durable goal state survives clearState" -- once evaluateGoal() exists.
  describe("reset rules (§5.0) — legacy families only", () => {
    test("legacy families reset on turnKey change", () => {
      let s = eval1(ON, undefined, facts({ finish: "stop" })).state
      s = eval1(ON, s, facts({ finish: "stop" })).state
      expect(s.noProgressCount).toBe(1)
      // new turnKey -> fresh state, grace re-arms (this evaluation consumes it)
      const r = eval1(ON, s, facts({ turnKey: "t2", finish: "stop" }))
      expect(r.state.turnKey).toBe("t2")
      expect(r.state.noProgressCount).toBe(0) // grace does not increment
      expect(r.decision.action).toBe("nudge_grace") // fresh grace available again
      expect(r.state.graceUsed).toBe(true) // consumed by this decision
    })
    // NOTE: onProgress() is also the mechanism frozen choice C3a relies on -- the goal round boundary
    // calls it so "no progress" measures within a round rather than across the whole goal.
    test("onProgress resets legacy nudge counters but NOT lengthContinues", () => {
      let s = eval1(ON, undefined, facts({ finish: "length" })).state
      expect(s.lengthContinues).toBe(1)
      s = eval1(ON, s, facts({ finish: "stop" })).state
      expect(s.noProgressCount).toBe(0) // grace
      s = eval1(ON, s, facts({ finish: "stop" })).state
      expect(s.noProgressCount).toBe(1)
      s = StopRecovery.onProgress(s)
      expect(s.noProgressCount).toBe(0)
      expect(s.graceUsed).toBe(false)
      expect(s.lengthContinues).toBe(1) // lengthContinues NOT reset
    })
  })
})