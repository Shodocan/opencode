/**
 * T01 acceptance tests — Route-Aware Context Budget and Compaction.
 *
 * Authoritative sources:
 *   - specs/qwen-context-budget.md (budget formula, late estimate, internal outcomes)
 *   - specs/qwen-context-budget-plan.md T01 (budget algebra, compatibility, canonical estimator)
 *   - specs/qwen-context-budget-choices.md (QCB-002..006)
 *
 * Scope (T01 test_touch_set — this file only):
 *   - `ContextBudget.evaluate` is the sole budget evaluator in src/session/overflow.ts.
 *   - Constants: G=16,384 (growth headroom), M=4,096 (safety margin), H=G+M=20,480,
 *     default reserve 20,000 (cfg.compaction.reserved is a floor, not a replacement).
 *   - Budget algebra: contextBudget = C>0 ? C-max(Rcfg,O+H) : Infinity;
 *     inputBudget = I>0 ? I-max(Rcfg,H) : Infinity; B = max(0, min(contextBudget, inputBudget));
 *     O = min(valid route output limit, requested runtime output). Admit E<=B, reject E>=B+1.
 *   - Absent/zero limits follow frozen absent/unknown (Infinity) semantics; present
 *     non-finite/negative limits fail closed with typed internal evidence.
 *   - Deterministic canonical serialization (sorted object keys, preserved array order,
 *     functions/undefined excluded) and ceiling chars/4 estimation.
 *   - Internal typed errors ContextBudgetExceededError / CompactionImpossibleError only;
 *     the public SessionV1.ContextOverflowError shape/text is unchanged.
 *   - Compatibility: `usable`/`isOverflow` adapters keep their frozen signatures and
 *     semantics; `compaction.auto: false` never disables the provider dispatch gate.
 *
 * Not in this touch set: compaction projection/chunking (T03/T05), LLM seam wiring and
 * golden projections (T02/T04), durable lineage (T06), provider overflow mapping.
 */

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import * as Overflow from "../../src/session/overflow"

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function createModel(opts: {
  context: number
  output: number
  input?: number
  providerID?: string
  modelID?: string
  npm?: string
}): Provider.Model {
  return {
    id: opts.modelID ?? "test-model",
    providerID: opts.providerID ?? "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

// Qwen-shaped route per the spec: 262,144 context, 32,000 output.
const qwen = () =>
  createModel({
    context: 262_144,
    output: 32_000,
    providerID: "qwen",
    modelID: "qwen-max",
    npm: "@ai-sdk/openai-compatible",
  })

function cfg(compaction?: ConfigV1.Info["compaction"]): ConfigV1.Info {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return { ...base, compaction }
}

function tokens(input: number, output = 0, read = 0, write = 0): SessionV1.Assistant["tokens"] {
  return { total: 0, input, output, reasoning: 0, cache: { read, write } }
}

// The evaluator surface under test. Namespace access keeps RED behavioral
// (asserting an absent export) instead of failing at module resolution.
type BudgetRoute = { providerID: string; modelID: string }

type BudgetEvaluation = {
  admitted: boolean
  budget: number
  contextBudget: number
  inputBudget: number
  outputAllowance: number
  estimate: number
}

type ContextBudgetNamespace = {
  readonly GROWTH_HEADROOM: number
  readonly SAFETY_MARGIN: number
  readonly HEADROOM: number
  readonly DEFAULT_RESERVED: number
  evaluate(input: {
    model: Provider.Model
    cfg: ConfigV1.Info
    estimate: number
    phase: string
    outputTokens?: number
    runtime?: string
    requestHash?: string
    chunkCount?: number
  }): BudgetEvaluation
  canonicalSerialize(value: unknown): string
  estimate(value: unknown): number
}

function budget(): ContextBudgetNamespace {
  const ns = (Overflow as unknown as { ContextBudget?: ContextBudgetNamespace }).ContextBudget
  expect(ns).toBeDefined()
  return ns!
}

type InternalErrorCtor = {
  new (data: Record<string, unknown>): Error
  isInstance(input: unknown): boolean
}

function internalError(name: "ContextBudgetExceededError" | "CompactionImpossibleError"): InternalErrorCtor {
  const ctor = (Overflow as unknown as Record<string, InternalErrorCtor | undefined>)[name]
  expect(ctor).toBeDefined()
  return ctor!
}

function errorData(caught: unknown): Record<string, unknown> {
  const data = (caught as { data?: Record<string, unknown> } | undefined)?.data
  expect(data).toBeObject()
  return data!
}

// Asserts invalid-limit input fails closed with the internal typed error.
function expectInvalidLimit(input: {
  model: Provider.Model
  cfg?: ConfigV1.Info
  estimate?: number
  phase?: string
  requestHash?: string
  runtime?: string
  chunkCount?: number
}): Record<string, unknown> {
  let caught: unknown
  try {
    budget().evaluate({
      model: input.model,
      cfg: input.cfg ?? cfg(),
      estimate: input.estimate ?? 1_000,
      phase: input.phase ?? "dispatch",
      requestHash: input.requestHash,
      runtime: input.runtime,
      chunkCount: input.chunkCount,
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeDefined()
  const CBX = internalError("ContextBudgetExceededError")
  expect(CBX.isInstance(caught)).toBe(true)
  return errorData(caught)
}

const INFINITY_ = Number.POSITIVE_INFINITY

// ─── Pinned constants ────────────────────────────────────────────────────────

describe("overflow.ContextBudget constants", () => {
  test("pins G=16,384, M=4,096, H=G+M=20,480, default reserve 20,000", () => {
    const CB = budget()
    expect(CB.GROWTH_HEADROOM).toBe(16_384)
    expect(CB.SAFETY_MARGIN).toBe(4_096)
    expect(CB.HEADROOM).toBe(20_480)
    expect(CB.DEFAULT_RESERVED).toBe(20_000)
  })
})

// ─── Qwen admission boundary ─────────────────────────────────────────────────

describe("overflow.ContextBudget.evaluate — Qwen 209,664 boundary", () => {
  test("admits a late estimate of exactly 209,664", () => {
    const result = budget().evaluate({ model: qwen(), cfg: cfg(), estimate: 209_664, phase: "dispatch" })
    expect(result.admitted).toBe(true)
  })

  test("rejects a late estimate of 209,665 (one token over)", () => {
    const result = budget().evaluate({ model: qwen(), cfg: cfg(), estimate: 209_665, phase: "dispatch" })
    expect(result.admitted).toBe(false)
  })

  test("budget is 209,664 with a 32,000 normal output allowance", () => {
    const result = budget().evaluate({ model: qwen(), cfg: cfg(), estimate: 209_664, phase: "dispatch" })
    expect(result.budget).toBe(209_664)
    expect(result.contextBudget).toBe(209_664)
    expect(result.inputBudget).toBe(INFINITY_)
    expect(result.outputAllowance).toBe(32_000)
  })

  test("keeps the 32,000 normal output allowance without an explicit runtime output", () => {
    const result = budget().evaluate({ model: qwen(), cfg: cfg(), estimate: 209_664, phase: "dispatch" })
    expect(result.outputAllowance).toBe(32_000)
    expect(result.admitted).toBe(true)
  })

  test("rejects growth that crosses the boundary despite low prior usage", () => {
    // QCB-001: prior-turn usage is telemetry, never the admission decision. The
    // evaluator takes only the late canonical estimate E — the request does not fit.
    const result = budget().evaluate({ model: qwen(), cfg: cfg(), estimate: 250_000, phase: "dispatch" })
    expect(result.admitted).toBe(false)
    expect(result.estimate).toBe(250_000)
  })
})

// ─── Budget algebra ──────────────────────────────────────────────────────────

describe("overflow.ContextBudget.evaluate — budget algebra", () => {
  test("contextBudget = C - max(Rcfg, O+H) for the Qwen route", () => {
    // max(20_000, 32_000 + 20_480) = 52_480; 262,144 - 52,480 = 209,664.
    const result = budget().evaluate({ model: qwen(), cfg: cfg(), estimate: 0, phase: "dispatch" })
    expect(result.contextBudget).toBe(209_664)
    expect(result.budget).toBe(209_664)
  })

  test("output allowance is min(route output limit, requested runtime output)", () => {
    // Route output limit is the smaller side: O = min(8,000, 32,000) = 8,000.
    const routeSmaller = budget().evaluate({
      model: createModel({ context: 262_144, output: 8_000 }),
      cfg: cfg(),
      estimate: 0,
      phase: "dispatch",
    })
    expect(routeSmaller.outputAllowance).toBe(8_000)
    expect(routeSmaller.contextBudget).toBe(262_144 - 28_480)
    expect(routeSmaller.budget).toBe(233_664)

    // Requested runtime output is the smaller side: O = min(32,000, 4,096) = 4,096.
    const requestedSmaller = budget().evaluate({
      model: qwen(),
      cfg: cfg(),
      estimate: 0,
      phase: "compaction",
      outputTokens: 4_096,
    })
    expect(requestedSmaller.outputAllowance).toBe(4_096)
    expect(requestedSmaller.contextBudget).toBe(262_144 - 24_576)
    expect(requestedSmaller.budget).toBe(237_568)
  })

  test("explicit input limit does not subtract output twice", () => {
    // inputBudget = I - max(Rcfg, H) = 200,000 - 20,480 = 179,520.
    // Output (32,000) is never subtracted again from the explicit input limit.
    const model = createModel({ context: 262_144, input: 200_000, output: 32_000 })
    const result = budget().evaluate({ model, cfg: cfg(), estimate: 179_520, phase: "dispatch" })
    expect(result.inputBudget).toBe(179_520)
    expect(result.contextBudget).toBe(209_664)
    expect(result.budget).toBe(179_520)
    expect(result.admitted).toBe(true)

    const over = budget().evaluate({ model, cfg: cfg(), estimate: 179_521, phase: "dispatch" })
    expect(over.admitted).toBe(false)
    expect(over.budget).toBe(179_520)
  })

  test("B = max(0, min(contextBudget, inputBudget)) when the input limit dominates", () => {
    const model = createModel({ context: 262_144, input: 100_000, output: 32_000 })
    const result = budget().evaluate({ model, cfg: cfg(), estimate: 0, phase: "dispatch" })
    expect(result.contextBudget).toBe(209_664)
    expect(result.inputBudget).toBe(79_520)
    expect(result.budget).toBe(79_520)
  })

  test("budget floors at zero when output plus headroom exceeds the context window", () => {
    // 30,000 - 52,480 = -22,480 → contextBudget stays negative in the result, B clamps to 0.
    const model = createModel({ context: 30_000, output: 32_000 })
    const result = budget().evaluate({ model, cfg: cfg(), estimate: 29_999, phase: "dispatch" })
    expect(result.contextBudget).toBe(-22_480)
    expect(result.budget).toBe(0)
    expect(result.admitted).toBe(false)
    expect(budget().evaluate({ model, cfg: cfg(), estimate: 0, phase: "dispatch" }).admitted).toBe(true)
  })
})

// ─── Configured reserve floor ────────────────────────────────────────────────

describe("overflow.ContextBudget.evaluate — configured reserve floor", () => {
  test("a reserve below the floor cannot weaken O + H or H", () => {
    // compaction.reserved: 12,000 < floor. O + H = 52,480 still rules the context budget
    // and H = 20,480 still rules the input budget.
    const plain = budget().evaluate({ model: qwen(), cfg: cfg({ reserved: 12_000 }), estimate: 209_664, phase: "dispatch" })
    expect(plain.budget).toBe(209_664)
    expect(plain.admitted).toBe(true)

    const withInput = budget().evaluate({
      model: createModel({ context: 262_144, input: 200_000, output: 32_000 }),
      cfg: cfg({ reserved: 12_000 }),
      estimate: 179_520,
      phase: "dispatch",
    })
    expect(withInput.inputBudget).toBe(179_520)
    expect(withInput.admitted).toBe(true)
  })

  test("a reserve of zero behaves like the frozen default floor", () => {
    const result = budget().evaluate({ model: qwen(), cfg: cfg({ reserved: 0 }), estimate: 209_664, phase: "dispatch" })
    expect(result.budget).toBe(209_664)
    expect(result.admitted).toBe(true)
  })

  test("a large reserve compacts earlier than the default", () => {
    // max(100_000, 52_480) = 100,000 → contextBudget = 162,144. An estimate that fits at
    // the default reserve (209,664) is rejected here: larger reserve compacts earlier.
    const model = qwen()
    const result = budget().evaluate({ model, cfg: cfg({ reserved: 100_000 }), estimate: 209_664, phase: "dispatch" })
    expect(result.contextBudget).toBe(162_144)
    expect(result.budget).toBe(162_144)
    expect(result.admitted).toBe(false)

    const fitting = budget().evaluate({ model, cfg: cfg({ reserved: 100_000 }), estimate: 162_144, phase: "dispatch" })
    expect(fitting.admitted).toBe(true)
  })

  test("a large reserve also floors the input budget", () => {
    const model = createModel({ context: 262_144, input: 200_000, output: 32_000 })
    const result = budget().evaluate({ model, cfg: cfg({ reserved: 100_000 }), estimate: 100_000, phase: "dispatch" })
    expect(result.inputBudget).toBe(100_000)
    expect(result.budget).toBe(100_000)
    expect(result.admitted).toBe(true)
  })
})

// ─── Absent / zero / infinite limits (frozen Infinity semantics) ─────────────

describe("overflow.ContextBudget.evaluate — absent, zero, and unknown limits", () => {
  test("missing context window yields an infinite context budget and admits any estimate", () => {
    const model = createModel({ context: 0, output: 32_000 })
    const result = budget().evaluate({ model, cfg: cfg(), estimate: 1_000_000, phase: "dispatch" })
    expect(result.contextBudget).toBe(INFINITY_)
    expect(result.inputBudget).toBe(INFINITY_)
    expect(result.budget).toBe(INFINITY_)
    expect(result.admitted).toBe(true)
  })

  test("zero context window follows frozen absent semantics", () => {
    const model = createModel({ context: 0, output: 32_000 })
    const result = budget().evaluate({ model, cfg: cfg(), estimate: 500_000, phase: "dispatch" })
    expect(result.budget).toBe(INFINITY_)
    expect(result.admitted).toBe(true)
  })

  test("zero explicit input limit is unknown, not a zero budget", () => {
    const model = createModel({ context: 262_144, input: 0, output: 32_000 })
    const result = budget().evaluate({ model, cfg: cfg(), estimate: 209_664, phase: "dispatch" })
    expect(result.inputBudget).toBe(INFINITY_)
    expect(result.budget).toBe(209_664)
    expect(result.admitted).toBe(true)
  })

  test("Infinity limits are allowed absent-decodes", () => {
    const noContext = budget().evaluate({
      model: createModel({ context: INFINITY_, output: 32_000 }),
      cfg: cfg(),
      estimate: 1_000,
      phase: "dispatch",
    })
    expect(noContext.contextBudget).toBe(INFINITY_)
    expect(noContext.admitted).toBe(true)

    const noInput = budget().evaluate({
      model: createModel({ context: 262_144, input: INFINITY_, output: 32_000 }),
      cfg: cfg(),
      estimate: 209_664,
      phase: "dispatch",
    })
    expect(noInput.inputBudget).toBe(INFINITY_)
    expect(noInput.budget).toBe(209_664)
  })

  test("an invalid zero route output limit falls back to the requested output allowance", () => {
    // Frozen maxOutputTokens semantics: 0 is unknown, not a zero allowance.
    const model = createModel({ context: 262_144, output: 0 })
    const result = budget().evaluate({ model, cfg: cfg(), estimate: 209_664, phase: "dispatch" })
    expect(result.outputAllowance).toBe(32_000)
    expect(result.budget).toBe(209_664)
    expect(result.admitted).toBe(true)
  })
})

// ─── Invalid limits fail closed ──────────────────────────────────────────────

describe("overflow.ContextBudget.evaluate — invalid limits fail closed", () => {
  test("negative context limit throws the internal typed error", () => {
    const model = createModel({ context: -1, output: 32_000 })
    const data = expectInvalidLimit({ model, estimate: 10, phase: "dispatch" })
    expect(data.contextLimit).toBe(-1)
  })

  test("NaN context limit throws the internal typed error", () => {
    const model = createModel({ context: Number.NaN, output: 32_000 })
    const data = expectInvalidLimit({ model, estimate: 10, phase: "dispatch" })
    expect(Number.isNaN(data.contextLimit as number)).toBe(true)
  })

  test("negative input limit throws the internal typed error", () => {
    const model = createModel({ context: 262_144, input: -5, output: 32_000 })
    const data = expectInvalidLimit({ model, estimate: 10, phase: "dispatch" })
    expect(data.inputLimit).toBe(-5)
  })

  test("NaN input limit throws the internal typed error", () => {
    const model = createModel({ context: 262_144, input: Number.NaN, output: 32_000 })
    const data = expectInvalidLimit({ model, estimate: 10, phase: "dispatch" })
    expect(Number.isNaN(data.inputLimit as number)).toBe(true)
  })

  test("negative requested runtime output throws the internal typed error", () => {
    const data = expectInvalidLimit({ model: qwen(), estimate: 10, phase: "dispatch", requestHash: "h" })
    void data
    let caught: unknown
    try {
      budget().evaluate({ model: qwen(), cfg: cfg(), estimate: 10, phase: "dispatch", outputTokens: -1 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(internalError("ContextBudgetExceededError").isInstance(caught)).toBe(true)
  })

  test("NaN requested runtime output throws the internal typed error", () => {
    let caught: unknown
    try {
      budget().evaluate({ model: qwen(), cfg: cfg(), estimate: 10, phase: "dispatch", outputTokens: Number.NaN })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(internalError("ContextBudgetExceededError").isInstance(caught)).toBe(true)
  })

  test("evidence carries route, phase, estimate, allowance, chunk count, runtime, and hash", () => {
    const model = createModel({ context: -1, output: 32_000, providerID: "qwen", modelID: "qwen-max" })
    const data = expectInvalidLimit({
      model,
      estimate: 123_456,
      phase: "dispatch",
      requestHash: "abc-123",
      runtime: "native",
      chunkCount: 0,
    })
    expect(data.route).toEqual({ providerID: "qwen", modelID: "qwen-max" })
    expect(data.phase).toBe("dispatch")
    expect(data.estimate).toBe(123_456)
    expect(data.outputAllowance).toBeNumber()
    expect(data.chunkCount).toBe(0)
    expect(data.requestHash).toBe("abc-123")
    expect(data.runtime).toBe("native")
    expect(typeof data.reason).toBe("string")
    expect((data.reason as string).length).toBeGreaterThan(0)
  })

  test("chunkCount defaults to zero and requestHash is omitted when not supplied", () => {
    const data = expectInvalidLimit({ model: createModel({ context: -1, output: 32_000 }), estimate: 1, phase: "dispatch" })
    expect(data.chunkCount).toBe(0)
    expect(data.requestHash).toBeUndefined()
  })
})

// ─── auto: false never disables the dispatch gate ────────────────────────────

describe("overflow.ContextBudget.evaluate — compaction.auto false", () => {
  test("the dispatch gate stays active with automatic compaction disabled", () => {
    const result = budget().evaluate({ model: qwen(), cfg: cfg({ auto: false }), estimate: 209_665, phase: "dispatch" })
    expect(result.admitted).toBe(false)
  })

  test("a fitting estimate is still admitted with automatic compaction disabled", () => {
    const result = budget().evaluate({ model: qwen(), cfg: cfg({ auto: false }), estimate: 209_664, phase: "dispatch" })
    expect(result.admitted).toBe(true)
  })
})

// ─── Canonical serialization ─────────────────────────────────────────────────

describe("overflow.ContextBudget.canonicalSerialize", () => {
  test("sorts object keys into a deterministic canonical form", () => {
    const CB = budget()
    expect(CB.canonicalSerialize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(CB.canonicalSerialize({ b: 1, a: 2 })).toBe(CB.canonicalSerialize({ a: 2, b: 1 }))
  })

  test("sorts nested object keys recursively", () => {
    const CB = budget()
    expect(CB.canonicalSerialize({ outer: { y: 2, x: 1 } })).toBe('{"outer":{"x":1,"y":2}}')
  })

  test("preserves array order while sorting keys inside array elements", () => {
    const CB = budget()
    expect(CB.canonicalSerialize({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}')
    expect(CB.canonicalSerialize({ list: [{ d: 1, c: 2 }] })).toBe('{"list":[{"c":2,"d":1}]}')
  })

  test("excludes executable functions", () => {
    const CB = budget()
    expect(CB.canonicalSerialize({ fn: () => "never serialized", keep: 1 })).toBe('{"keep":1}')
  })

  test("excludes undefined-valued properties but keeps null, booleans, and numbers", () => {
    const CB = budget()
    expect(CB.canonicalSerialize({ absent: undefined, keep: 1 })).toBe('{"keep":1}')
    expect(CB.canonicalSerialize({ flag: false, nil: null, zero: 0 })).toBe('{"flag":false,"nil":null,"zero":0}')
  })

  test("is deterministic across repeated calls", () => {
    const CB = budget()
    const value = { z: [1, { k: "v" }], a: { m: true }, mid: "stable" }
    expect(CB.canonicalSerialize(value)).toBe(CB.canonicalSerialize(value))
  })
})

// ─── Estimate: ceiling four-characters-per-token ─────────────────────────────

describe("overflow.ContextBudget.estimate", () => {
  test("uses ceiling division over four characters per token", () => {
    const CB = budget()
    expect(CB.estimate("")).toBe(0)
    expect(CB.estimate("a")).toBe(1)
    expect(CB.estimate("abcd")).toBe(1)
    expect(CB.estimate("abcde")).toBe(2)
    expect(CB.estimate("abcdefgh")).toBe(2)
    expect(CB.estimate("x".repeat(4_096))).toBe(1_024)
  })

  test("ceiling distinguishes itself from the legacy rounding estimator", () => {
    const CB = budget()
    // round(5/4) = 1 but ceil(5/4) = 2; the budget estimator must round up.
    expect(CB.estimate("abcde")).toBe(2)
  })

  test("estimates a payload via its canonical serialization", () => {
    const CB = budget()
    const value = { a: "x".repeat(7) }
    expect(CB.estimate(value)).toBe(CB.estimate(CB.canonicalSerialize(value)))
    expect(CB.estimate(value)).toBe(Math.ceil(CB.canonicalSerialize(value).length / 4))
  })
})

// ─── Internal typed errors ───────────────────────────────────────────────────

describe("internal typed budget errors", () => {
  test("ContextBudgetExceededError is internal and distinct from the public overflow error", () => {
    const CBE = internalError("ContextBudgetExceededError")
    const err = new CBE({ reason: "invalid-context-limit", phase: "dispatch", estimate: 1, budget: 0 })
    expect(CBE.isInstance(err)).toBe(true)
    expect(err.name).toBe("ContextBudgetExceededError")
    expect(SessionV1.ContextOverflowError.isInstance(err)).toBe(false)
  })

  test("CompactionImpossibleError accepts the five pinned terminal reasons", () => {
    const CIE = internalError("CompactionImpossibleError")
    const reasons = [
      "fixed-overhead",
      "latest-turn-too-large",
      "chunk-limit",
      "no-reduction",
      "post-compaction-over-budget",
    ]
    for (const reason of reasons) {
      const err = new CIE({ reason, phase: "compaction", chunkCount: 2 })
      expect(CIE.isInstance(err)).toBe(true)
      expect(err.name).toBe("CompactionImpossibleError")
      expect(errorData(err).reason).toBe(reason)
    }
  })

  test("the public ContextOverflowError shape and pinned text are unchanged", () => {
    const overflow = new SessionV1.ContextOverflowError({ message: "Input exceeds context window of this model" })
    expect(overflow.name).toBe("ContextOverflowError")
    expect(overflow.toObject()).toEqual({
      name: "ContextOverflowError",
      data: { message: "Input exceeds context window of this model" },
    })
  })
})

// ─── Compatibility: usable / isOverflow adapters ─────────────────────────────

describe("compatibility — usable adapter retains frozen semantics", () => {
  test("without an input limit: usable = context - route output", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    expect(Overflow.usable({ cfg: cfg(), model })).toBe(68_000)
  })

  test("with an input limit: usable = input - min(default reserve, route output)", () => {
    const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
    expect(Overflow.usable({ cfg: cfg(), model })).toBe(180_000)
  })

  test("configured compaction.reserved replaces the default reserve", () => {
    const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
    expect(Overflow.usable({ cfg: cfg({ reserved: 30_000 }), model })).toBe(170_000)
  })

  test("outputTokenMax shrinks the applied reserve", () => {
    const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
    expect(Overflow.usable({ cfg: cfg(), model, outputTokenMax: 4_096 })).toBe(195_904)
  })

  test("unknown context window yields zero usable tokens", () => {
    const model = createModel({ context: 0, output: 32_000 })
    expect(Overflow.usable({ cfg: cfg(), model })).toBe(0)
  })
})

describe("compatibility — isOverflow adapter retains frozen semantics", () => {
  test("flags overflow once the projected count reaches usable", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const count = tokens(75_000, 5_000)
    expect(Overflow.isOverflow({ cfg: cfg(), model, tokens: count })).toBe(true)
    expect(Overflow.isOverflow({ cfg: cfg(), model, tokens: tokens(65_000, 2_999) })).toBe(false)
  })

  test("token count includes cache reads to reach the boundary", () => {
    const model = createModel({ context: 200_000, output: 32_000 })
    expect(Overflow.isOverflow({ cfg: cfg(), model, tokens: tokens(160_000, 8_000) })).toBe(true)
    expect(Overflow.isOverflow({ cfg: cfg(), model, tokens: tokens(167_999, 0, 1) })).toBe(true)
    expect(Overflow.isOverflow({ cfg: cfg(), model, tokens: tokens(167_998, 0, 1) })).toBe(false)
  })

  test("unknown context window never overflows", () => {
    const model = createModel({ context: 0, output: 32_000 })
    expect(Overflow.isOverflow({ cfg: cfg(), model, tokens: tokens(10_000_000) })).toBe(false)
  })

  test("compaction.auto false disables the automatic compaction trigger only", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    expect(Overflow.isOverflow({ cfg: cfg({ auto: false }), model, tokens: tokens(90_000, 5_000) })).toBe(false)
  })
})