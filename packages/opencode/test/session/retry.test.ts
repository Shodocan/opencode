import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { NamedError } from "@opencode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Schedule, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const providerID = ProviderV2.ID.make("test")
const retryProvider = "test"
const it = testEffect(LayerNode.compile(LayerNode.group([SessionStatus.node, CrossSpawnSpawner.node])))

function apiError(headers?: Record<string, string>): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error, 0))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("adds jitter to exponential delays", () => {
    const error = apiError()
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
    expect(SessionRetry.delay(1, error, 1)).toBe(2500)
    expect(SessionRetry.delay(4, error, 1)).toBe(20000)
    expect(SessionRetry.delay(5, error, 1)).toBe(30000)
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.instance("policy updates retry status and increments attempts", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-retry-test")
      const error = apiError({ "retry-after-ms": "0" })
      const status = yield* SessionStatus.Service

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            status.set(sessionID, {
              type: "retry",
              attempt: info.attempt,
              message: info.message,
              next: info.next,
            }),
        }),
      )
      yield* step(error)
      yield* step(error)

      expect(yield* status.get(sessionID)).toMatchObject({
        type: "retry",
        attempt: 2,
        message: "boom",
      })
    }),
  )

  it.instance("policy stops after five retries", () =>
    Effect.gen(function* () {
      const attempts: number[] = []
      const error = apiError({ "retry-after-ms": "0" })
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            Effect.sync(() => {
              attempts.push(info.attempt)
            }),
        }),
      )

      yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_RETRIES + 1 }), () =>
        Effect.ignore(step(error)),
      )

      expect(attempts).toStrictEqual([1, 2, 3, 4, 5])
    }),
  )
})

describe("session.retry.retryable", () => {
  test("retries serialized too_many_requests messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("retries serialized overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Provider is overloaded" })
  })

  test("retries serialized rate_limit messages", () => {
    const message = JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } })
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test.each([
    "Internal server error",
    "internal error",
    "server-error",
    "Provider returned error",
    "provider-returned-error",
    "terminated",
    "fetch failed",
    "network error",
    "network-error",
    "network_error",
    "connection refused",
    "connect ECONNREFUSED",
    "request ETIMEDOUT",
    "failed to fetch",
    "EAI_AGAIN",
    "response timed out",
    "Please retry your request",
    "try your request again",
    "Please try again in a few minutes",
    "The model is currently at capacity due to high demand",
    "The service is temporarily at capacity",
    "upstream returned status 524",
  ])("retries matching API error text: %s", (message) => {
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("retries hyphenated service-unavailable errors", () => {
    expect(SessionRetry.retryable(wrap("service-unavailable"), retryProvider)).toEqual({
      message: "Provider is overloaded",
    })
  })

  test("matches retryable API response bodies", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Request failed",
        isRetryable: false,
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message: "upstream connection refused" } }),
      }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Request failed" })
  })

  const litellmCut = {
    message:
      "litellm.APIConnectionError: APIConnectionError: OpenAIException - Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>",
    code: "500",
  }

  test("retries a LiteLLM mid-stream 5xx error event", () => {
    const request = MessageV2.fromError(litellmCut, { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionV1.APIError.isInstance(request) && request.data.statusCode).toBe(500)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({ message: litellmCut.message })
  })

  test("retries a mid-stream error with a numeric 5xx code", () => {
    const request = MessageV2.fromError({ message: "upstream exploded", code: 503 }, { providerID })
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({ message: "upstream exploded" })
  })

  test("does not retry a mid-stream 4xx error event", () => {
    const request = MessageV2.fromError({ message: "bad request body", code: "400" }, { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(false)
    expect(SessionRetry.retryable(request, retryProvider)).toBeUndefined()
  })

  test("keeps stream context overflow non-retryable", () => {
    const request = MessageV2.fromError(
      { type: "error", error: { code: "context_length_exceeded", message: "too long" } },
      { providerID },
    )
    expect(SessionV1.ContextOverflowError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toBeUndefined()
  })

  test("retries transport timeout errors", () => {
    const request = MessageV2.fromError(new ProviderError.HeaderTimeoutError(10000), { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response headers timed out after 10000ms",
    })
  })

  test("retries websocket stream transport errors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("WebSocket closed before response.completed (code 1006: Connection ended)"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "WebSocket closed before response.completed (code 1006: Connection ended)",
    })
  })

  test("does not retry context overflow errors", () => {
    const error = new SessionV1.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed" })
  })

  test("maps free limits to Go upsell action", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Free usage exceeded",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage exceeded" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode")).toEqual({
      message: SessionRetry.GO_UPSELL_MESSAGE,
      action: {
        reason: "free_tier_limit",
        provider: "opencode",
        title: "Free limit reached",
        message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
        label: "subscribe",
        link: SessionRetry.GO_UPSELL_URL,
      },
    })
  })

  test("maps Go subscription limits to workspace PAYG upsell", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "19380",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
            limitName: "5 hour",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")).toEqual({
      message:
        "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      action: {
        reason: "account_rate_limit",
        provider: "opencode-go",
        title: "Go limit reached",
        message:
          "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance",
        label: "open settings",
        link: "https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      },
    })
  })

  test("maps Go subscription limits without limit metadata", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "900",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")?.action?.message).toBe(
      "Usage limit reached. It will reset in 15 minutes. To continue using this model now, enable usage from your available balance",
    )
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(SessionV1.APIError.isInstance(result)).toBe(true)
      if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server" })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("openai") })
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderV2.ID.make("openai") },
    )

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })
})

// V4-182: the NY2 router owns failures before the first byte; the runtime owns
// mid-stream cuts and router-exhausted 5xx responses under a configurable policy.
describe("session.retry configured provider policy", () => {
  const routeProvider = ProviderV2.ID.make("opencode-route")
  const config: SessionRetry.Config = {
    maxAttempts: 200,
    initialDelayMs: 1000,
    maxDelayMs: 60_000,
    maxElapsedMs: 30 * 60_000,
  }

  function callError(input: {
    status: number
    message: string
    body?: unknown
    headers?: Record<string, string>
    isRetryable?: boolean
  }) {
    return MessageV2.fromError(
      new APICallError({
        message: input.message,
        url: "http://10.100.0.11:4000/v1/chat/completions",
        requestBodyValues: {},
        statusCode: input.status,
        responseHeaders: { "content-type": "application/json", ...input.headers },
        responseBody: JSON.stringify(input.body ?? { error: { message: input.message } }),
        isRetryable: input.isRetryable ?? false,
      }),
      { providerID: routeProvider },
    )
  }

  const streamPayload = (message: string, code: string | null = "500") =>
    MessageV2.fromError({ message, type: null, param: null, code }, { providerID: routeProvider })

  const exhausted = () =>
    callError({
      status: 503,
      message: "Service Unavailable",
      body: { error: { type: "upstream_retry_exhausted", message: "router retry budget exhausted" } },
      headers: { "retry-after": "7", "x-ny2-attempts": "4" },
    })

  // Shapes recorded on runtime 1.18.28-harness.4.3.0.11 sessions (2026-10-07).
  const observed: Array<[string, () => ReturnType<typeof MessageV2.fromError>]> = [
    [
      "MidStreamFallbackError: APIConnectionError (connection closed)",
      () =>
        streamPayload(
          "litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: ChatgptException - Connection closed.",
        ),
    ],
    [
      "TransferEncodingError mid-stream",
      () =>
        streamPayload(
          "litellm.APIConnectionError: APIConnectionError: OpenAIException - Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>",
        ),
    ],
    [
      "MidStreamFallbackError overloaded without a code",
      () =>
        streamPayload(
          "litellm.MidStreamFallbackError: litellm.APIError: Our servers are currently overloaded. Please try again later.",
          null,
        ),
    ],
    [
      "MidStreamFallbackError overloaded as HTTP 500",
      () =>
        callError({
          status: 500,
          message:
            "litellm.MidStreamFallbackError: litellm.MidStreamFallbackError: litellm.APIError: Our servers are currently overloaded. Please try again later.",
        }),
    ],
    [
      "503 upstream_unavailable",
      () =>
        callError({
          status: 503,
          message: "Service Unavailable",
          body: { error: { type: "upstream_unavailable", pool: "skynet" } },
          headers: { "retry-after": "2", "x-ny2-pool": "skynet" },
        }),
    ],
    [
      "500 InternalServerError: OpenAIException - Connection error",
      () =>
        callError({
          status: 500,
          message: "litellm.InternalServerError: InternalServerError: OpenAIException - Connection error.",
        }),
    ],
    [
      "ServiceUnavailableError",
      () =>
        callError({
          status: 503,
          message: "litellm.ServiceUnavailableError: ServiceUnavailableError: OpenAIException - Service Unavailable",
        }),
    ],
    ["router upstream_retry_exhausted 503", exhausted],
  ]

  for (const [name, make] of observed) {
    test(`classifies ${name} as retryable`, () => {
      const error = make()
      expect(SessionV1.APIError.isInstance(error)).toBe(true)
      expect(SessionRetry.retryable(error, retryProvider)).toBeDefined()
      expect(SessionRetry.retryable(error, retryProvider, config)).toBeDefined()
      expect(SessionRetry.decide({ error, provider: retryProvider, attempt: 6, elapsed: 0, limit: 0, config })).toBeDefined()
    })
  }

  test("honors Retry-After on a router upstream_retry_exhausted 503", () => {
    const error = exhausted()
    expect(SessionRetry.decide({ error, provider: retryProvider, attempt: 1, elapsed: 0, limit: 5, config })?.wait).toBe(
      7000,
    )
    // Retry-After is bounded by maxDelayMs and by the remaining elapsed budget.
    expect(
      SessionRetry.decide({ error, provider: retryProvider, attempt: 1, elapsed: 0, limit: 5, config: { maxDelayMs: 5000 } })
        ?.wait,
    ).toBe(5000)
    expect(
      SessionRetry.decide({
        error,
        provider: retryProvider,
        attempt: 1,
        elapsed: config.maxElapsedMs! - 3000,
        limit: 5,
        config,
      })?.wait,
    ).toBe(3000)
  })

  for (const status of [400, 401, 402, 403, 404, 422]) {
    test(`never retries status ${status} under a configured policy`, () => {
      // Messages that the legacy heuristics would have treated as transient.
      const error = callError({ status, message: "internal server error: rate limit 503", isRetryable: true })
      expect(SessionRetry.retryable(error, retryProvider, config)).toBeUndefined()
      expect(SessionRetry.decide({ error, provider: retryProvider, attempt: 1, elapsed: 0, limit: 5, config })).toBeUndefined()
    })
  }

  test("does not retry context overflow or a retry-unsafe tool failure", () => {
    const overflow = callError({ status: 400, message: "context_length_exceeded", body: { error: { code: "context_length_exceeded" } } })
    expect(SessionRetry.retryable(overflow, retryProvider, config)).toBeUndefined()
    const unsafe = MessageV2.fromError(
      new ProviderError.RetryUnsafeError(["bash"], "litellm.APIConnectionError: connection error 500"),
      { providerID: routeProvider },
    )
    expect(SessionV1.APIError.isInstance(unsafe)).toBe(true)
    expect(SessionV1.APIError.isInstance(unsafe) && unsafe.data.metadata?.code).toBe("ProviderRetryUnsafeError")
    expect(SessionRetry.retryable(unsafe, retryProvider)).toBeUndefined()
    expect(SessionRetry.retryable(unsafe, retryProvider, config)).toBeUndefined()
  })

  test("honors maxAttempts, backoff, maxDelayMs and maxElapsedMs", () => {
    const error = apiError()
    const custom: SessionRetry.Config = { maxAttempts: 4, initialDelayMs: 100, backoffFactor: 3, maxDelayMs: 1000 }
    const waits = [1, 2, 3].map(
      (attempt) => SessionRetry.decide({ error, provider: retryProvider, attempt, elapsed: 0, limit: 5, config: custom, random: 0 })?.wait,
    )
    expect(waits).toStrictEqual([100, 300, 900])
    // Three retries make four attempts in total.
    expect(SessionRetry.decide({ error, provider: retryProvider, attempt: 4, elapsed: 0, limit: 5, config: custom })).toBeUndefined()
    // Backoff at the ceiling stays at or below maxDelayMs and keeps jitter.
    const capped = SessionRetry.delay(10, error, 1, custom)
    expect(capped).toBeLessThanOrEqual(1000)
    expect(capped).toBeGreaterThanOrEqual(750)
    expect(
      SessionRetry.decide({ error, provider: retryProvider, attempt: 1, elapsed: 5000, limit: 5, config: { maxElapsedMs: 5000 } }),
    ).toBeUndefined()
  })

  test("a configured policy without maxDelayMs caps waits at 30 seconds", () => {
    const error = apiError()
    for (const attempt of [5, 10, 50])
      expect(
        SessionRetry.decide({ error, provider: retryProvider, attempt, elapsed: 0, limit: 5, config: { maxAttempts: 200 } })!
          .wait,
      ).toBeLessThanOrEqual(30_000)
  })

  test("a zero Retry-After hint still waits initialDelayMs", () => {
    for (const headers of [{ "retry-after-ms": "0" }, { "retry-after": "0" }] as Record<string, string>[])
      expect(
        SessionRetry.decide({ error: apiError(headers), provider: retryProvider, attempt: 1, elapsed: 0, limit: 5, config })!
          .wait,
      ).toBe(config.initialDelayMs!)
  })

  test("an explicit 4xx stream code inside a gateway wrapper is not promoted to 500", () => {
    const error = streamPayload("litellm.MidStreamFallbackError: litellm.BadRequestError: invalid tool schema", "400")
    expect(SessionV1.APIError.isInstance(error)).toBe(false)
    expect(SessionRetry.retryable(error, retryProvider, config)).toBeUndefined()
  })

  test("retryableStatuses replaces the default status set", () => {
    const only503: SessionRetry.Config = { retryableStatuses: [503] }
    expect(SessionRetry.retryable(callError({ status: 502, message: "bad gateway" }), retryProvider, only503)).toBeUndefined()
    expect(SessionRetry.retryable(callError({ status: 503, message: "unavailable" }), retryProvider, only503)).toBeDefined()
  })

  test("keeps every default unchanged when no policy is configured", () => {
    const error = apiError()
    for (const attempt of [1, 2, 3, 4, 5, 6])
      expect(
        SessionRetry.decide({ error, provider: retryProvider, attempt, elapsed: 0, limit: SessionRetry.RETRY_MAX_RETRIES, random: 0 })
          ?.wait,
      ).toBe(attempt <= 5 ? SessionRetry.delay(attempt, error, 0) : undefined)
    // The legacy classifier still applies, including OpenAI's retryable 404.
    const openai404 = MessageV2.fromError(
      new APICallError({
        message: "boom",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 404,
        responseBody: '{"error":"boom"}',
        isRetryable: false,
      }),
      { providerID: ProviderV2.ID.make("openai") },
    )
    expect(SessionRetry.retryable(openai404, retryProvider)).toBeDefined()
  })

  test("a configured policy is the authority over a lowered RetryLimit", () => {
    const error = exhausted()
    // Workflow-managed tasks lower RetryLimit to 0: unchanged without a policy.
    expect(SessionRetry.decide({ error, provider: retryProvider, attempt: 1, elapsed: 0, limit: 0 })).toBeUndefined()
    expect(SessionRetry.decide({ error, provider: retryProvider, attempt: 1, elapsed: 0, limit: 0, config })).toBeDefined()
  })
})
