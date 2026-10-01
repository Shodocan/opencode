import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Schema } from "effect"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}

// ─── Route-aware context budget ───────────────────────────────────────────────
//
// ContextBudget.evaluate is the sole budget evaluator for pre-dispatch admission
// (QCB-001/QCB-002): the decision uses only the late canonical estimate E of the
// route-normalized request. Prior-turn usage is telemetry and never admits a
// request by itself.
//
//   G = 16,384 projected in-turn growth headroom
//   M = 4,096 safety margin
//   H = G + M
//   Rcfg = max(compaction.reserved ?? 0, 20,000) — the reserve is a floor
//   O = min(valid route output limit, requested runtime output) via the frozen
//       ProviderTransform.maxOutputTokens semantics (0/absent route output is
//       unknown, not a zero allowance)
//   contextBudget = C > 0 ? C - max(Rcfg, O + H) : Infinity
//   inputBudget   = I > 0 ? I - max(Rcfg, H)     : Infinity
//   B = max(0, min(contextBudget, inputBudget))
//
// Admitted iff E <= B; compaction is required at E >= B + 1. `compaction.auto:
// false` only suppresses the automatic compaction trigger — the dispatch gate
// stays active. A present non-finite/negative limit fails closed with the
// internal typed errors below; the public SessionV1.ContextOverflowError
// shape/text is unchanged and is produced only at the session boundary.

const GROWTH_HEADROOM = 16_384
const SAFETY_MARGIN = 4_096
const HEADROOM = GROWTH_HEADROOM + SAFETY_MARGIN
const DEFAULT_RESERVED = 20_000
const INFINITY = Number.POSITIVE_INFINITY

const BudgetRoute = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
})

export const ContextBudgetExceededError = NamedError.create("ContextBudgetExceededError", {
  reason: Schema.String,
  phase: Schema.String,
  estimate: Schema.Number,
  budget: Schema.Number,
  route: Schema.optional(BudgetRoute),
  contextLimit: Schema.optional(Schema.Number),
  inputLimit: Schema.optional(Schema.Number),
  outputLimit: Schema.optional(Schema.Number),
  outputAllowance: Schema.optional(Schema.Number),
  chunkCount: Schema.optional(Schema.Number),
  requestHash: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
})

export const CompactionImpossibleError = NamedError.create("CompactionImpossibleError", {
  reason: Schema.Literals([
    "fixed-overhead",
    "latest-turn-too-large",
    "chunk-limit",
    "no-reduction",
    "post-compaction-over-budget",
  ]),
  phase: Schema.String,
  chunkCount: Schema.optional(Schema.Number),
  route: Schema.optional(BudgetRoute),
  estimate: Schema.optional(Schema.Number),
  budget: Schema.optional(Schema.Number),
  contextLimit: Schema.optional(Schema.Number),
  inputLimit: Schema.optional(Schema.Number),
  outputAllowance: Schema.optional(Schema.Number),
  requestHash: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
})

export type ContextBudgetInput = {
  model: Provider.Model
  cfg: ConfigV1.Info
  estimate: number
  phase: string
  outputTokens?: number
  runtime?: string
  requestHash?: string
  chunkCount?: number
}

export type ContextBudgetEvaluation = {
  admitted: boolean
  budget: number
  contextBudget: number
  inputBudget: number
  outputAllowance: number
  estimate: number
}

// Absent (undefined), zero, and +Infinity limits follow the frozen absent/
// unknown semantics. A present limit that is non-numeric, NaN, -Infinity, or
// negative is invalid and fails closed.
function isInvalidLimit(value: number | undefined): boolean {
  return value !== undefined && (typeof value !== "number" || Number.isNaN(value) || value < 0)
}

// Request identity is the SHA-256 digest of the selected route/runtime plus the
// canonical final projection. A present hash that is not a 64-character
// lowercase hex digest is invalid and fails closed before any admission math.
const REQUEST_HASH = /^[0-9a-f]{64}$/

// The `> 0` guard preserves the frozen absent/unknown semantics: undefined and
// zero limits yield an infinite (absent) budget rather than a zero budget.
// Invalid limits never reach here — they fail closed in `evaluate`.
function budgetFrom(limit: number | undefined, reserved: number, subtract: number): number {
  return typeof limit === "number" && limit > 0 ? limit - Math.max(reserved, subtract) : INFINITY
}

function invalidLimitError(
  input: ContextBudgetInput,
  reason: string,
  limits: { contextLimit?: number; inputLimit?: number; outputLimit?: number },
): never {
  const allowance = ProviderTransform.maxOutputTokens(input.model, input.outputTokens)
  throw new ContextBudgetExceededError({
    reason,
    phase: input.phase,
    estimate: input.estimate,
    budget: 0,
    route: { providerID: input.model.providerID, modelID: input.model.id },
    contextLimit: limits.contextLimit,
    inputLimit: limits.inputLimit,
    outputLimit: limits.outputLimit,
    outputAllowance: Number.isFinite(allowance) && allowance > 0 ? allowance : 0,
    chunkCount: input.chunkCount ?? 0,
    requestHash: input.requestHash,
    runtime: input.runtime,
  })
}

function evaluate(input: ContextBudgetInput): ContextBudgetEvaluation {
  const reserved = Math.max(input.cfg.compaction?.reserved ?? 0, DEFAULT_RESERVED)

  const contextLimit = input.model.limit.context
  if (isInvalidLimit(contextLimit)) return invalidLimitError(input, "invalid-context-limit", { contextLimit })

  const inputLimit = input.model.limit.input
  if (isInvalidLimit(inputLimit)) return invalidLimitError(input, "invalid-input-limit", { inputLimit })

  const outputLimit = input.model.limit.output
  if (isInvalidLimit(outputLimit)) return invalidLimitError(input, "invalid-output-limit", { outputLimit })

  if (isInvalidLimit(input.outputTokens)) return invalidLimitError(input, "invalid-requested-output", {})

  if (input.requestHash !== undefined && !REQUEST_HASH.test(input.requestHash))
    return invalidLimitError(input, "invalid-request-hash", {})

  const outputAllowance = ProviderTransform.maxOutputTokens(input.model, input.outputTokens)
  const contextBudget = budgetFrom(contextLimit, reserved, outputAllowance + HEADROOM)
  const inputBudget = budgetFrom(inputLimit, reserved, HEADROOM)
  const budget = Math.max(0, Math.min(contextBudget, inputBudget))

  return {
    admitted: input.estimate <= budget,
    budget,
    contextBudget,
    inputBudget,
    outputAllowance,
    estimate: input.estimate,
  }
}

// Deterministic canonical serialization: object keys sorted at every level,
// array order preserved, executable functions and undefined-valued properties
// excluded, null/booleans/numbers/strings kept.
function canonicalSerialize(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value)
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.filter((item) => typeof item !== "function" && item !== undefined).map(canonicalSerialize).join(",")}]`
      }
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => typeof item !== "function" && item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`)
        .join(",")}}`
    }
  }
  return JSON.stringify(String(value))
}

// Ceiling four-characters-per-token estimator over the canonical form; strings
// measure directly. The ceiling (not rounding) is the budget estimator.
function estimateTokens(value: unknown): number {
  const chars = typeof value === "string" ? value.length : canonicalSerialize(value).length
  return Math.ceil(chars / 4)
}

export const ContextBudget = {
  GROWTH_HEADROOM,
  SAFETY_MARGIN,
  HEADROOM,
  DEFAULT_RESERVED,
  evaluate,
  canonicalSerialize,
  estimate: estimateTokens,
}
