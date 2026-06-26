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

// Stable identity of a model ref for the `tried` set. Variant-sensitive so the
// same model at a different reasoning effort counts as a distinct attempt.
export const keyOfRef = (ref: ModelV2.Ref): string =>
  `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`

// A failure is fallback-eligible when the provider error is retriable (RateLimit
// / ProviderInternal — see packages/llm/src/schema/errors.ts), OR it is a quota
// exhaustion (not same-model-retriable, but the canonical "this provider is
// unavailable → try another model" case), OR it is a context-overflow that
// survived the compaction-recovery branch. Truly fatal reasons (auth,
// content-policy, no-route, transport, non-overflow invalid-request, …) are NOT
// eligible — falling back would not help.
export const shouldFallback = (failure: unknown): boolean =>
  (failure instanceof LLMError && (failure.retryable || failure.reason._tag === "QuotaExceeded")) ||
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
