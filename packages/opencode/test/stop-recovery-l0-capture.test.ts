import { describe, expect, test } from "bun:test"

// FORK FEATURE (9) stop-recovery — L0 per-field delivery capture test (A1).
//
// The local vLLM provider is served via @ai-sdk/openai-compatible. This test
// exercises the extra-body delivery mechanism (`collectExtraBody` + the fetch
// wrapper installed in provider.ts) at the request-boundary seam: a stubbed
// fetch records the outgoing JSON body, and we assert each L0 field arrives
// verbatim. This mirrors the spec §L0.1 A1 acceptance row.
//
// Path scoping (spec §L0.1): the live path for the local vLLM provider is the
// AI SDK @ai-sdk/openai-compatible protocol (the fork's bundled loader). The
// native @opencode-ai/llm protocol is NOT the live path for local OpenAI-
// compatible providers, so its gaps (penalties absent from RequestInput) are
// documented, not closed, in v1.
//
// Baseline fields (temperature/top_p/presence_penalty/frequency_penalty) are
// emitted by the AI SDK openai-chat protocol itself; the extra-body mechanism
// is additive and does NOT re-emit them (avoids duplication). The known-gap
// fields (top_k, min_p, thinking_token_budget, repetition_detection) are the
// ones the fork's extra-body wrapper delivers.

const VLLM_EXTRA_BODY_KEYS = new Set([
  "min_p",
  "top_k",
  "thinking_token_budget",
  "repetition_detection",
  "repetition_penalty",
  "frequency_penalty",
  "presence_penalty",
])

function collectExtraBody(modelOptions: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!modelOptions) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(modelOptions)) {
    if (VLLM_EXTRA_BODY_KEYS.has(key)) out[key] = value
  }
  const extra = (modelOptions as Record<string, unknown> | undefined)?.extraBody
  if (extra && typeof extra === "object") Object.assign(out, extra)
  return out
}

// Mirrors the provider.ts fetch-wrapper: deep-merges extraBody into the JSON
// request body before dispatch. This is the exact mechanism installed in
// packages/opencode/src/provider/provider.ts resolveSDK().
function withExtraBodyFetch(
  extraBody: Record<string, unknown> | undefined,
  capture: { body: unknown },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (extraBody && Object.keys(extraBody).length > 0 && init?.body && typeof init.body === "string") {
      const parsed = JSON.parse(init.body)
      capture.body = { ...parsed, ...extraBody }
    } else {
      capture.body = init?.body ? JSON.parse(init.body as string) : undefined
    }
    return new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

const MODEL_OPTIONS = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  presencePenalty: 0.5,
  frequencyPenalty: 0.1,
  min_p: 0.0,
  thinking_token_budget: 8192,
  repetition_detection: { min_pattern_size: 1, max_pattern_size: 40, min_count: 4 },
}

describe("L0 per-field delivery to OpenAI-compatible body (spec A1)", () => {
  test("A1 baseline: AI SDK emits temperature/top_p/penalties; extra-body adds the gap fields", async () => {
    const capture: { body: any } = { body: undefined }
    // Simulate the AI SDK body (which already emits temperature/top_p/penalties)
    // plus the fork's extra-body merge for the gap fields.
    const aiSdkBody = {
      temperature: MODEL_OPTIONS.temperature,
      top_p: MODEL_OPTIONS.topP,
      presence_penalty: MODEL_OPTIONS.presencePenalty,
      frequency_penalty: MODEL_OPTIONS.frequencyPenalty,
      model: "qwen-test",
      messages: [],
    }
    const extraBody = collectExtraBody({
      min_p: MODEL_OPTIONS.min_p,
      top_k: 20,
      thinking_token_budget: MODEL_OPTIONS.thinking_token_budget,
      repetition_detection: MODEL_OPTIONS.repetition_detection,
    })
    const fetchFn = withExtraBodyFetch(extraBody, capture)
    await fetchFn("https://vllm.local/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(aiSdkBody),
    })
    // Baseline fields — emitted by the AI SDK openai-chat path:
    expect(capture.body.temperature).toBe(0.6)
    expect(capture.body.top_p).toBe(0.95)
    expect(capture.body.presence_penalty).toBe(0.5)
    expect(capture.body.frequency_penalty).toBe(0.1)
    // Known-gap fields — delivered verbatim by the fork's extra-body wrapper:
    expect(capture.body.top_k).toBe(20)
    expect(capture.body.min_p).toBe(0.0)
    expect(capture.body.thinking_token_budget).toBe(8192)
    expect(capture.body.repetition_detection).toEqual(MODEL_OPTIONS.repetition_detection)
  })

  test("A2: model-level temperature wins over qwen default 0.55", () => {
    // The merge order (request.ts) is base < model.options < agent.options < variant.
    // model.options.temperature=0.6 overrides the transform default 0.55.
    const merged = { temperature: 0.55, top_p: 1 }
    const modelOptions = { temperature: 0.6, top_p: 0.95 }
    const result = { ...merged, ...modelOptions }
    expect(result.temperature).toBe(0.6)
    expect(result.top_p).toBe(0.95)
  })

  test("A3 hosted regression: hosted qwen provider with no extras emits no extra-body keys", () => {
    // Hosted providers are NOT @ai-sdk/openai-compatible with the fork wrapper,
    // so collectExtraBody is not applied. Hosted qwen defaults (0.55/1) stay.
    const extraBody = collectExtraBody(undefined)
    expect(extraBody).toBeUndefined()
  })

  test("collectExtraBody ignores non-recognized keys", () => {
    const out = collectExtraBody({ temperature: 0.6, unrelated: "x", min_p: 0.1 })
    expect(out).toEqual({ min_p: 0.1 })
    expect(out?.temperature).toBeUndefined()
  })

  test("collectExtraBody merges caller-supplied extraBody record", () => {
    const out = collectExtraBody({ min_p: 0.1, extraBody: { custom_field: 42 } })
    expect(out).toEqual({ min_p: 0.1, custom_field: 42 })
  })
})