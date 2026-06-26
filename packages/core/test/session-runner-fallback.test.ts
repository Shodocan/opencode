import { describe, expect, test } from "bun:test"
import {
  LLMError,
  AuthenticationReason,
  ContentPolicyReason,
  InvalidRequestReason,
  NoRouteReason,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
} from "@opencode-ai/llm"
import { SessionRunnerFallback } from "../src/session/runner/fallback"
import type { ModelV2 } from "../src/model"
import type { AgentV2 } from "../src/agent"

// FORK FEATURE (6) fallback-model — unit tests for the pure decision logic.

const err = (reason: any) => new LLMError({ module: "test", method: "test", reason })
const ref = (providerID: string, id: string, variant?: string) =>
  ({ providerID, id, variant }) as unknown as ModelV2.Ref
const info = (chain: ModelV2.Ref[] | undefined) => ({ fallback: chain }) as unknown as AgentV2.Info

describe("shouldFallback", () => {
  test("true for retriable provider errors", () => {
    expect(SessionRunnerFallback.shouldFallback(err(new RateLimitReason({ message: "rl" })))).toBe(true)
    expect(
      SessionRunnerFallback.shouldFallback(err(new ProviderInternalReason({ message: "500", status: 500 }))),
    ).toBe(true)
  })

  test("true for context-overflow invalid-request", () => {
    expect(
      SessionRunnerFallback.shouldFallback(
        err(new InvalidRequestReason({ message: "too long", classification: "context-overflow" })),
      ),
    ).toBe(true)
  })

  test("true for quota exhaustion (provider unavailable -> try another model)", () => {
    expect(SessionRunnerFallback.shouldFallback(err(new QuotaExceededReason({ message: "q" })))).toBe(true)
  })

  test("false for fatal reasons", () => {
    expect(SessionRunnerFallback.shouldFallback(err(new AuthenticationReason({ message: "a", kind: "invalid" })))).toBe(
      false,
    )
    expect(SessionRunnerFallback.shouldFallback(err(new ContentPolicyReason({ message: "c" })))).toBe(false)
    expect(SessionRunnerFallback.shouldFallback(err(new TransportReason({ message: "t" })))).toBe(false)
    expect(
      SessionRunnerFallback.shouldFallback(err(new NoRouteReason({ route: "r" as any, provider: "p" as any, model: "m" as any }))),
    ).toBe(false)
    // non-overflow invalid-request is fatal
    expect(SessionRunnerFallback.shouldFallback(err(new InvalidRequestReason({ message: "bad param" })))).toBe(false)
  })

  test("false for non-LLMError values", () => {
    expect(SessionRunnerFallback.shouldFallback(new Error("plain"))).toBe(false)
    expect(SessionRunnerFallback.shouldFallback(undefined)).toBe(false)
  })
})

describe("keyOfRef", () => {
  test("variant-sensitive identity", () => {
    expect(SessionRunnerFallback.keyOfRef(ref("anthropic", "claude-sonnet-4-6"))).toBe("anthropic/claude-sonnet-4-6")
    expect(SessionRunnerFallback.keyOfRef(ref("anthropic", "claude-sonnet-4-6", "high"))).toBe(
      "anthropic/claude-sonnet-4-6#high",
    )
    expect(SessionRunnerFallback.keyOfRef(ref("anthropic", "claude-sonnet-4-6"))).not.toBe(
      SessionRunnerFallback.keyOfRef(ref("anthropic", "claude-sonnet-4-6", "high")),
    )
  })
})

describe("nextFallbackModel", () => {
  const retriable = err(new RateLimitReason({ message: "rl" }))
  const fatal = err(new AuthenticationReason({ message: "a", kind: "invalid" }))
  const chain = [ref("anthropic", "claude-sonnet-4-6"), ref("openai", "gpt-5.5")]

  test("returns first un-tried model on a retriable failure", () => {
    const next = SessionRunnerFallback.nextFallbackModel(info(chain), retriable, new Set())
    expect(next && SessionRunnerFallback.keyOfRef(next)).toBe("anthropic/claude-sonnet-4-6")
  })

  test("skips already-tried models", () => {
    const tried = new Set(["anthropic/claude-sonnet-4-6"])
    const next = SessionRunnerFallback.nextFallbackModel(info(chain), retriable, tried)
    expect(next && SessionRunnerFallback.keyOfRef(next)).toBe("openai/gpt-5.5")
  })

  test("declines when chain exhausted", () => {
    const tried = new Set(["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"])
    expect(SessionRunnerFallback.nextFallbackModel(info(chain), retriable, tried)).toBeUndefined()
  })

  test("declines on fatal failure", () => {
    expect(SessionRunnerFallback.nextFallbackModel(info(chain), fatal, new Set())).toBeUndefined()
  })

  test("declines with no chain / no agent info", () => {
    expect(SessionRunnerFallback.nextFallbackModel(info(undefined), retriable, new Set())).toBeUndefined()
    expect(SessionRunnerFallback.nextFallbackModel(info([]), retriable, new Set())).toBeUndefined()
    expect(SessionRunnerFallback.nextFallbackModel(undefined, retriable, new Set())).toBeUndefined()
  })

  test("declines when hop budget exhausted", () => {
    const big = [ref("p", "a"), ref("p", "b"), ref("p", "c"), ref("p", "d"), ref("p", "e"), ref("p", "f")]
    const tried = new Set(["x1", "x2", "x3", "x4", "x5"]) // size 5 > MAX_FALLBACKS (4)
    expect(SessionRunnerFallback.nextFallbackModel(info(big), retriable, tried)).toBeUndefined()
  })
})
