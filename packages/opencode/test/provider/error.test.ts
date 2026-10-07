import { describe, expect, test } from "bun:test"
import { ProviderError } from "@/provider/error"

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })

  test("maps LiteLLM mid-stream 5xx payloads to a retryable api error", () => {
    const message = "litellm.APIConnectionError: Response payload is not completed: <TransferEncodingError: 400>"
    expect(ProviderError.parseStreamError({ message, code: "500" })).toMatchObject({
      type: "api_error",
      statusCode: 500,
      isRetryable: true,
    })
    expect(ProviderError.parseStreamError({ message })).toMatchObject({ type: "api_error", statusCode: 500 })
  })

  test("ignores 4xx stream payloads and keeps overflow classification", () => {
    expect(ProviderError.parseStreamError({ message: "bad request", code: "400" })).toBeUndefined()
    expect(
      ProviderError.parseStreamError({ type: "error", error: { code: "context_length_exceeded", message: "x" } }),
    ).toMatchObject({ type: "context_overflow" })
  })
})
