export * as SessionRunnerFallback from "./fallback"

import { LLMError, isContextOverflowFailure } from "@opencode-ai/llm"
import { ModelV2 } from "../../model"
import { AgentV2 } from "../../agent"

// FORK FEATURE (6) fallback-model — see FORK_CHANGES.md.
// Pure decision logic for the runner's model-fallback machinery. No Effect, no
// IO — kept here so the hot file runner/llm.ts touches only thin hook points.

// Cap on distinct fallback hops in a single turn (excludes the primary model).
export const MAX_FALLBACKS = 4
// Combined ceiling on ALL turn transitions (compaction + overflow-compaction +
// fallback) so the product of those recovery paths cannot retry-storm.
export const MAX_TURN_TRANSITIONS = 8
export const MINIMUM_ATTEMPTS_FOR_FALLBACK = 3

// Stable identity of a model ref for the `tried` set. Variant-sensitive so the
// same model at a different reasoning effort counts as a distinct attempt.
export const keyOfRef = (ref: ModelV2.Ref): string =>
  `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`

export const isTimeoutOnlyFailure = (failure: unknown): boolean =>
  failure instanceof LLMError && failure.reason._tag === "Transport" && failure.reason.kind === "Timeout"

export const isProviderOfflineFailure = (failure: unknown): boolean =>
  failure instanceof LLMError && failure.reason._tag === "Transport" && !isTimeoutOnlyFailure(failure)

export const hasMinimumAttemptsForFallback = (attempts: number): boolean => attempts >= MINIMUM_ATTEMPTS_FOR_FALLBACK

export const attemptsForFailure = (failure: unknown, runnerAttempts: number) => {
  const lowerLevel = failure instanceof LLMError && failure.retryable ? MINIMUM_ATTEMPTS_FOR_FALLBACK : 0
  const runnerLevel = lowerLevel > 0 ? 0 : runnerAttempts
  return {
    total: Math.max(lowerLevel, runnerLevel),
    lowerLevel,
    runnerLevel,
  }
}

export const reasonForFailure = (failure: unknown) => {
  if (isContextOverflowFailure(failure)) return { category: "context-overflow" as const, message: "context overflow" }
  if (!(failure instanceof LLMError)) return { category: "provider-internal" as const, message: "provider error" }
  switch (failure.reason._tag) {
    case "RateLimit":
      return { category: "rate-limit" as const, message: "rate limit" }
    case "QuotaExceeded":
      return { category: "quota-exceeded" as const, message: "quota exceeded" }
    case "ProviderInternal":
      return { category: "provider-internal" as const, message: "provider internal error" }
    case "Transport":
      return { category: "provider-offline" as const, message: "provider offline" }
    default:
      return { category: "provider-internal" as const, message: "provider error" }
  }
}

// A failure is fallback-eligible when the provider error is retriable (RateLimit
// / ProviderInternal — see packages/llm/src/schema/errors.ts), OR it is a quota
// exhaustion (not same-model-retriable, but the canonical "this provider is
// unavailable → try another model" case), OR it is a context-overflow that
// survived the compaction-recovery branch. Truly fatal reasons (auth,
// content-policy, no-route, transport, non-overflow invalid-request, …) are NOT
// eligible — falling back would not help.
export const shouldFallback = (failure: unknown): boolean =>
  (failure instanceof LLMError &&
    !isTimeoutOnlyFailure(failure) &&
    (failure.retryable || failure.reason._tag === "QuotaExceeded" || isProviderOfflineFailure(failure))) ||
  isContextOverflowFailure(failure)

// Pick the next un-tried model from the agent's fallback chain, or undefined to
// decline (no chain / not eligible / hop budget exhausted / all tried).
export const nextFallbackModel = (
  info: AgentV2.Info | undefined,
  failure: unknown,
  tried: ReadonlySet<string>,
): ModelV2.Ref | undefined => {
  const chain = info?.fallback
  if (!chain || chain.length === 0) return undefined
  if (!shouldFallback(failure)) return undefined
  if (tried.size > MAX_FALLBACKS) return undefined
  for (const ref of chain) {
    if (!tried.has(keyOfRef(ref))) return ref
  }
  return undefined
}
