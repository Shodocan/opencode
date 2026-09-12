import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import {
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  LLMError,
  LLMEvent,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
} from "@opencode-ai/llm"
import type { QuotaPolicy } from "@opencode-ai/plugin"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { APICallError } from "ai"
import { Quota } from "../../src/session/llm/quota"
import { LLMAISDK } from "../../src/session/llm/ai-sdk"
import { MessageV2 } from "../../src/session/message-v2"

const policy = {
  schema_version: "2.1",
  matrix_sha256: "a".repeat(64),
  category: "review",
  rule: {
    source: { route: "opencode-route/gpt-6.0-astra", effort: "xhigh" },
    target: { route: "opencode-route/glm-5.3", effort: "max" },
    when: ["account_quota_exhausted"],
    max_fallbacks_per_turn: 1 as const,
  },
} satisfies QuotaPolicy

const quotaError = (body = '{"error":{"code":"insufficient_quota"}}') =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new QuotaExceededReason({
      message: "quota",
      http: http(429, { "x-request-id": "receipt" }, body),
    }),
  })

const http = (status: number, headers: Record<string, string>, body?: string) =>
  new HttpContext({
    request: new HttpRequestDetails({ method: "POST", url: "https://example.invalid", headers: {} }),
    response: new HttpResponseDetails({ status, headers }),
    ...(body === undefined ? {} : { body }),
  })

describe("native hard quota classification", () => {
  test("fails closed for an unrelated source or non-review MAX policy", () => {
    expect(Quota.authority({ binding: "standalone", policy }, "opencode-route/gpt-6.0-astra").policy).toBeDefined()
    expect(Quota.authority({ binding: "standalone", policy }, "opencode-route/glm-5.3").binding).toBe("unknown")
    expect(
      Quota.authority(
        { binding: "standalone", policy: { ...policy, category: "task_review" } },
        "opencode-route/gpt-6.0-astra",
      ).binding,
    ).toBe("unknown")
  })

  test("accepts one complete, typed account quota response", () => {
    const evidence = Quota.rejection(quotaError(), policy, 0)
    expect(evidence).toMatchObject({
      reason: "account_quota_exhausted",
      source: "provider_rejection",
      response_complete: true,
      turn_provider_requests: 1,
      emitted_output_or_action: false,
      status_code: 429,
    })
  })

  test("normalizes only a real AI SDK account-quota response before the common guard", () => {
    const sdk = new APICallError({
      message: "quota",
      url: "https://example.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "x-request-id": "sdk-receipt" },
      responseBody: '{"error":{"code":"insufficient_quota"}}',
    })
    expect(Quota.rejection(Quota.fromAISDKError(sdk), policy, 0)).toMatchObject({
      reason: "account_quota_exhausted",
      provider_request_id: "sdk-receipt",
    })
    expect(Quota.fromAISDKError(new APICallError({
      message: "rate limited", url: "https://example.invalid", requestBodyValues: {}, statusCode: 429,
      responseHeaders: {}, responseBody: '{"error":{"code":"rate_limited"}}',
    }))).toBeUndefined()
    expect(Quota.fromAISDKError(new APICallError({
      message: "quota", url: "https://example.invalid", requestBodyValues: {}, statusCode: 429,
      responseHeaders: {}, responseBody: `${'{"error":{"code":"insufficient_quota"},"padding":"'}${"x".repeat(65_537)}"}`,
    }))).toBeUndefined()
  })

  test("converts the AI SDK in-band error event before the common quota guard", async () => {
    const sdk = new APICallError({
      message: "quota", url: "https://example.invalid/v1/chat/completions", requestBodyValues: {}, statusCode: 429,
      responseHeaders: {}, responseBody: '{"error":{"code":"insufficient_quota"}}',
    })
    let fallback = 0
    const primary = () => Stream.fromEffect(LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), { type: "error", error: sdk } as never)).pipe(
      Stream.flatMap((events) => Stream.fromIterable(events)),
    )
    await Effect.runPromise(Stream.runDrain(Quota.guard({
      binding: "standalone", policy,
      primary,
      fallback: () => { fallback++; return Stream.empty },
    })))
    expect(fallback).toBe(1)
  })

  test("preserves host-owned quota evidence across the session boundary for Task terminal serialization", () => {
    const evidence = Quota.rejection(quotaError(), policy, 0)!
    const error = MessageV2.fromError(new Quota.HardQuotaError(evidence), { providerID: ProviderV2.ID.make("opencode-route") })
    expect(SessionV1.APIError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ name: "APIError", data: { hardQuota: evidence, statusCode: 429, isRetryable: false } })
    expect(MessageV2.fromError({ name: "APIError", data: { hardQuota: evidence } }, { providerID: ProviderV2.ID.make("opencode-route") }).name).toBe("UnknownError")
  })

  test("does not classify generic 429, transport, malformed, or caller-shaped errors", () => {
    const rateLimit = new LLMError({
      module: "test",
      method: "stream",
      reason: new RateLimitReason({
        message: "too many requests",
        http: http(429, {}),
      }),
    })
    const transport = new LLMError({
      module: "test",
      method: "stream",
      reason: new TransportReason({ message: "timeout" }),
    })
    expect(Quota.rejection(rateLimit, policy)).toBeUndefined()
    expect(Quota.rejection(transport, policy)).toBeUndefined()
    expect(Quota.rejection(quotaError("not json"), policy)).toBeUndefined()
    expect(Quota.rejection({ statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' }, policy)).toBeUndefined()
  })

  test("uses exactly one standalone fallback before output and never after output", async () => {
    let fallbacks = 0
    const beforeOutput = Quota.guard({
      binding: "standalone",
      policy,
      primary: () => Stream.fail(quotaError()),
      fallback: () => {
        fallbacks++
        return Stream.make(LLMEvent.finish({ reason: "stop" }))
      },
    })
    expect(Array.from(await Effect.runPromise(Stream.runCollect(beforeOutput)))).toHaveLength(1)
    expect(fallbacks).toBe(1)

    const afterOutput = Quota.guard({
      binding: "standalone",
      policy,
      primary: () => Stream.make(LLMEvent.textDelta({ id: "text", text: "already emitted" })).pipe(Stream.concat(Stream.fail(quotaError()))),
      fallback: () => {
        fallbacks++
        return Stream.empty
      },
    })
    await expect(Effect.runPromise(Stream.runDrain(afterOutput))).rejects.toBeDefined()
    expect(fallbacks).toBe(1)
  })
  test("rejects valid JSON without an account error without throwing", () => {
    for (const body of ["null", "[]", "42", '"quota"', "{}", '{"error":null}']) {
      expect(Quota.rejection(quotaError(body), policy)).toBeUndefined()
      expect(Quota.fromAISDKError(new APICallError({
        message: "quota", url: "https://example.invalid", requestBodyValues: {}, statusCode: 429,
        responseBody: body,
      }))).toBeUndefined()
    }
  })

  test("workflow quota fails with evidence and never invokes native fallback", async () => {
    let fallbacks = 0
    const error = await Effect.runPromise(Stream.runDrain(Quota.guard({
      binding: "workflow", policy,
      primary: () => Stream.fail(quotaError()),
      fallback: () => { fallbacks++; return Stream.empty },
    })).pipe(Effect.flip))
    expect(error).toBeInstanceOf(Quota.HardQuotaError)
    expect(error).toMatchObject({ evidence: { reason: "account_quota_exhausted" } })
    expect(fallbacks).toBe(0)
  })

  test("replaces initial bookkeeping and records the successful fallback", async () => {
    const events = await Effect.runPromise(Stream.runCollect(Quota.guard({
      binding: "standalone", policy,
      primary: () => Stream.make(LLMEvent.stepStart({ index: 0 })).pipe(Stream.concat(Stream.fail(quotaError()))),
      fallback: () => Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.stepFinish({ index: 0, reason: "stop" })),
    })))
    expect(Array.from(events)).toHaveLength(2)
    expect(Array.from(events)[1]).toMatchObject({ quotaFallback: {
      provider_id: "opencode-route", model_id: "glm-5.3", effort: "max",
      evidence: { reason: "account_quota_exhausted" },
    } })
  })

  test("failed fallback is terminal and cannot be mistaken for fresh quota", async () => {
    let fallbacks = 0
    const error = await Effect.runPromise(Stream.runDrain(Quota.guard({
      binding: "standalone", policy,
      primary: () => Stream.fail(quotaError()),
      fallback: () => { fallbacks++; return Stream.fail(quotaError()) },
    })).pipe(Effect.flip))
    expect(fallbacks).toBe(1)
    expect(error).toBeInstanceOf(Quota.FallbackFailedError)
    expect(Quota.rejection(error, policy)).toBeUndefined()
    expect(MessageV2.fromError(error, { providerID: ProviderV2.ID.make("opencode-route") })).toMatchObject({
      name: "APIError", data: { isRetryable: false, quotaFallbackFailed: true },
    })
  })

  test("never retries after tool activity or a second provider step", async () => {
    for (const event of [LLMEvent.toolCall({ id: "call", name: "write", input: {} }), LLMEvent.stepStart({ index: 1 })]) {
      let fallbacks = 0
      await expect(Effect.runPromise(Stream.runDrain(Quota.guard({
        binding: "standalone", policy,
        primary: () => Stream.make(LLMEvent.stepStart({ index: 0 }), event).pipe(Stream.concat(Stream.fail(quotaError()))),
        fallback: () => { fallbacks++; return Stream.empty },
      })))).rejects.toBeDefined()
      expect(fallbacks).toBe(0)
    }
  })

})
