import { createHash } from "node:crypto"
import type { JsonSchema, LLMRequest, ProviderMetadata } from "@opencode-ai/llm"
import { LLM, Message, SystemPart, ToolCallPart, ToolDefinition, ToolResultPart } from "@opencode-ai/llm"
import {
  AmazonBedrock,
  Anthropic,
  Azure,
  Google,
  OpenAI,
  OpenAICompatible,
  OpenRouter,
} from "@opencode-ai/llm/providers"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import { ContextBudget, ContextBudgetExceededError } from "@/session/overflow"
import { BudgetProjectionError } from "./request"

type ToolInput = {
  readonly description?: string
  readonly inputSchema?: unknown
}

export type RequestInput = {
  readonly model: Provider.Model
  readonly apiKey?: string
  readonly baseURL?: string
  readonly system?: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools?: Record<string, ToolInput>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: LLMRequest["providerOptions"]
  readonly headers?: Record<string, string>
}

const providerMetadata = (value: unknown): ProviderMetadata | undefined => {
  if (!isRecord(value)) return undefined
  const result = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

// Stored AI SDK parts historically kept provider-owned continuation metadata in
// `providerOptions`; native parts now use `providerMetadata` directly.
const partProviderMetadata = (part: Record<string, unknown>) =>
  providerMetadata(part.providerMetadata) ?? providerMetadata(part.providerOptions)

const textPart = (part: Record<string, unknown>) => ({
  type: "text" as const,
  text: typeof part.text === "string" ? part.text : "",
  providerMetadata: partProviderMetadata(part),
})

const mediaPart = (part: Record<string, unknown>) => {
  if (typeof part.data !== "string" && !(part.data instanceof Uint8Array))
    throw new Error("Native LLM request adapter only supports file parts with string or Uint8Array data")
  return {
    type: "media" as const,
    mediaType: typeof part.mediaType === "string" ? part.mediaType : "application/octet-stream",
    data: part.data,
    filename: typeof part.filename === "string" ? part.filename : undefined,
  }
}

const toolResult = (part: Record<string, unknown>) => {
  const output = isRecord(part.output) ? part.output : { type: "json", value: part.output }
  const type = output.type === "text" ? "text" : output.type === "error-text" ? "error" : "json"
  return ToolResultPart.make({
    id: typeof part.toolCallId === "string" ? part.toolCallId : "",
    name: typeof part.toolName === "string" ? part.toolName : "",
    result: "value" in output ? output.value : output,
    resultType: type,
    providerExecuted: typeof part.providerExecuted === "boolean" ? part.providerExecuted : undefined,
    providerMetadata: partProviderMetadata(part),
  })
}

const contentPart = (part: unknown) => {
  if (!isRecord(part)) throw new Error("Native LLM request adapter only supports object content parts")
  if (part.type === "text") return textPart(part)
  if (part.type === "file") return mediaPart(part)
  if (part.type === "reasoning")
    return {
      type: "reasoning" as const,
      text: typeof part.text === "string" ? part.text : "",
      providerMetadata: partProviderMetadata(part),
    }
  if (part.type === "tool-call")
    return ToolCallPart.make({
      id: typeof part.toolCallId === "string" ? part.toolCallId : "",
      name: typeof part.toolName === "string" ? part.toolName : "",
      input: part.input,
      providerExecuted: typeof part.providerExecuted === "boolean" ? part.providerExecuted : undefined,
      providerMetadata: partProviderMetadata(part),
    })
  if (part.type === "tool-result") return toolResult(part)
  throw new Error(`Native LLM request adapter does not support ${String(part.type)} content parts`)
}

const content = (value: ModelMessage["content"]) =>
  typeof value === "string" ? [{ type: "text" as const, text: value }] : value.map(contentPart)

const messages = (input: readonly ModelMessage[]) => {
  const system = input.flatMap((message) => (message.role === "system" ? [SystemPart.make(message.content)] : []))
  const messages = input.flatMap((message) => {
    if (message.role === "system") return []
    return [
      Message.make({
        role: message.role,
        content: content(message.content),
        native: isRecord(message.providerOptions) ? { providerOptions: message.providerOptions } : undefined,
      }),
    ]
  })
  return { system, messages }
}

const schema = (value: unknown): JsonSchema => {
  if (!isRecord(value)) return { type: "object", properties: {} }
  if (isRecord(value.jsonSchema)) return value.jsonSchema
  return value
}

const tools = (input: Record<string, ToolInput> | undefined): ToolDefinition[] =>
  Object.entries(input ?? {}).map(([name, item]) =>
    ToolDefinition.make({
      name,
      description: item.description ?? "",
      inputSchema: schema(item.inputSchema),
    }),
  )

const generation = (input: RequestInput) => {
  const result = {
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxTokens: input.maxOutputTokens,
  }
  return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

const baseURL = (input: Provider.Model | RequestInput) =>
  "model" in input ? (input.baseURL ?? (input.model.api.url || undefined)) : input.api.url || undefined

const requireBaseURL = (model: Provider.Model, url: string | undefined) => {
  if (url) return url
  throw new Error(`Native LLM request adapter requires a base URL for ${model.providerID}/${model.id}`)
}

export const model = (input: Provider.Model | RequestInput, headers?: Record<string, string>) => {
  const model = "model" in input ? input.model : input
  const url = baseURL(input)
  const options = {
    ...("model" in input && input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(url ? { baseURL: url } : {}),
    headers: Object.keys({ ...model.headers, ...headers }).length === 0 ? undefined : { ...model.headers, ...headers },
    limits: {
      context: model.limit.context,
      output: model.limit.output,
    },
  }
  if (model.api.npm === "@ai-sdk/openai") return OpenAI.configure(options).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/azure")
    return Azure.configure({ ...options, baseURL: requireBaseURL(model, url) }).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/anthropic") return Anthropic.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/google") return Google.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/amazon-bedrock") return AmazonBedrock.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/openai-compatible")
    return OpenAICompatible.configure({
      ...options,
      provider: String(model.providerID),
      baseURL: requireBaseURL(model, url),
    }).model(model.api.id)
  if (model.api.npm === "@openrouter/ai-sdk-provider") return OpenRouter.configure(options).model(model.api.id)
  throw new Error(`Native LLM request adapter does not support provider package ${model.api.npm}`)
}

export const request = (input: RequestInput) => {
  const converted = messages(input.messages)
  // This is the only native adapter boundary that should construct canonical
  // @opencode-ai/llm request objects from opencode's session/AI SDK-shaped data.
  return LLM.request({
    model: model(input, input.headers),
    system: [...(input.system ?? []).map(SystemPart.make), ...converted.system],
    messages: converted.messages,
    tools: tools(input.tools),
    toolChoice: input.toolChoice,
    generation: generation(input),
    providerOptions: input.providerOptions,
  })
}

// ---------------------------------------------------------------------------
// T04 exact final-payload gate (shared by both lowering seams)
//
// The final pre-network ContextBudget admission decision. The native seam
// projects the exact post-LLMRequest.update value handed to llmClient.stream;
// the AI SDK seam projects the exact final streamText params produced by its
// sole named final transform. Projection, admission, and send reuse the same
// value: model-visible/provider-serialization fields only (messages, tools,
// choice, options, output allowance) — auth/transport-only data (model.route,
// http, apiKey, headers) and executable functions never enter the projection.
// Rejection throws the typed ContextBudgetExceededError; the caller must fail
// the stream with zero native/streamText/HTTP/provider/chargeable calls.
// `compaction.auto: false` is not consulted — it only suppresses automatic
// compaction and never bypasses admission.
// ---------------------------------------------------------------------------

export type FinalProjection = {
  readonly model: { readonly provider: string; readonly id: string }
  readonly system: readonly unknown[]
  readonly messages: readonly unknown[]
  readonly tools: readonly unknown[]
  readonly toolChoice: unknown
  readonly generation: unknown
  readonly providerOptions: unknown
}

// ── T02-parity media reduction for final-seam projections ───────────────────
//
// Raw binary/base64 media never enters the budget estimate. Media parts are
// charged as a canonical data record (type/name/source-kind, known encoded
// length, SHA-256 where derivable without dereference, deterministic
// envelope overhead) — the same treatment and record shape T02 applies in
// LLMRequestPrep.prepare, so a payload admitted at prepare time is not
// re-charged by its raw base64 at the seam. Remote URIs are charged as
// source-kind plus envelope overhead only. Media whose size cannot be derived
// fails closed.

const MEDIA_ENVELOPE_OVERHEAD = 16_384

const isMediaPart = (part: unknown): part is Record<string, unknown> => {
  if (!isRecord(part)) return false
  return part.type === "file" || (typeof part.mediaType === "string" && part.data != null)
}

const sha256Hex = (input: string | Uint8Array): string => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  return createHash("sha256").update(bytes).digest("hex")
}

const isUrlString = (value: string) =>
  value.startsWith("data:") || value.startsWith("http://") || value.startsWith("https://")

const budgetMedia = (part: Record<string, unknown>): Record<string, unknown> => {
  const mediaType = typeof part.mediaType === "string" ? part.mediaType : null
  const filename = typeof part.filename === "string" ? part.filename : null
  const data = part.data
  const uri = data instanceof URL ? data.href : typeof data === "string" && isUrlString(data) ? data : undefined
  if (uri !== undefined) {
    const scheme = new URL(uri).protocol.replace(/:$/, "")
    if (scheme === "data") {
      const payload = uri.slice(uri.indexOf(",") + 1)
      return {
        kind: "data",
        source: "data-uri",
        mediaType,
        filename,
        length: payload.length,
        sha256: sha256Hex(payload),
        envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
      }
    }
    if (scheme === "http" || scheme === "https") {
      return { kind: "uri", source: "uri", mediaType, filename, length: null, sha256: null, envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD }
    }
    throw new BudgetProjectionError(`cannot derive size of ${scheme}:// media ${mediaType ?? "media"}; failing closed`)
  }
  if (typeof data === "string") {
    return {
      kind: "data",
      source: "string",
      mediaType,
      filename,
      length: data.length,
      sha256: sha256Hex(data),
      envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
    }
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return { kind: "data", source: "blob", mediaType, filename, length: data.size, sha256: null, envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD }
  }
  if (data instanceof ArrayBuffer) {
    return {
      kind: "data",
      source: "bytes",
      mediaType,
      filename,
      length: data.byteLength,
      sha256: sha256Hex(new Uint8Array(data)),
      envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
    }
  }
  if (ArrayBuffer.isView(data)) {
    return {
      kind: "data",
      source: "bytes",
      mediaType,
      filename,
      length: data.byteLength,
      sha256: sha256Hex(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
      envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
    }
  }
  throw new BudgetProjectionError(`cannot derive size of media handle ${mediaType ?? "media"}; failing closed`)
}

/**
 * Replaces media parts with their T02-parity budget records; every other part
 * passes through untouched. Shared by both final-seam projections (native
 * canonical messages and the AI SDK final prompt).
 */
export const budgetMessages = (messages: readonly unknown[]): unknown[] =>
  messages.map((message) =>
    isRecord(message) && "content" in message ? { ...message, content: budgetContent(message.content) } : message,
  )

const budgetContent = (content: unknown): unknown =>
  Array.isArray(content) ? content.map((part) => (isMediaPart(part) ? budgetMedia(part) : part)) : content

/** Canonical data-only projection of the exact final native LLMRequest value. */
export const finalProjection = (request: LLMRequest): FinalProjection => ({
  model: { provider: request.model.provider, id: request.model.id },
  system: [...request.system],
  messages: budgetMessages(request.messages),
  tools: [...request.tools],
  toolChoice: request.toolChoice ?? null,
  generation: request.generation ?? null,
  providerOptions: request.providerOptions ?? null,
})

/** Request identity: SHA-256 of the route qualifier + runtime + canonical final projection. */
export const requestHash = (input: {
  readonly route: { readonly providerID: string; readonly modelID: string }
  readonly runtime: string
  readonly projection: unknown
}): string =>
  createHash("sha256")
    .update(ContextBudget.canonicalSerialize({ route: input.route, runtime: input.runtime, projection: input.projection }))
    .digest("hex")

export type FinalAdmissionInput = {
  readonly model: Provider.Model
  readonly cfg: ConfigV1.Info
  /** Exact branch-final payload projection (native: post-update value, AI SDK: final transform output). */
  readonly projection: unknown
  readonly phase: string
  readonly runtime: "native" | "ai-sdk"
  /** Requested outgoing output tokens (route/runtime-clamped). */
  readonly maxOutputTokens?: number
}

/**
 * T04 final pre-network admission gate. Admits iff the canonical estimate of
 * the exact final payload fits the route-qualified budget; throws the typed
 * ContextBudgetExceededError (also fail-closed on invalid limits/hash) when it
 * does not.
 */
export const admit = (input: FinalAdmissionInput) => {
  const route = { providerID: input.model.providerID, modelID: input.model.id }
  const hash = requestHash({ route, runtime: input.runtime, projection: input.projection })
  const evaluation = ContextBudget.evaluate({
    model: input.model,
    cfg: input.cfg,
    estimate: ContextBudget.estimate(input.projection),
    phase: input.phase,
    outputTokens: input.maxOutputTokens,
    runtime: input.runtime,
    requestHash: hash,
  })
  if (!evaluation.admitted) {
    throw new ContextBudgetExceededError({
      reason: "context-budget-exceeded",
      phase: input.phase,
      estimate: evaluation.estimate,
      budget: evaluation.budget,
      route,
      contextLimit: input.model.limit.context,
      inputLimit: input.model.limit.input,
      outputLimit: input.model.limit.output,
      outputAllowance: evaluation.outputAllowance,
      chunkCount: 0,
      requestHash: hash,
      runtime: input.runtime,
    })
  }
  return { evaluation, requestHash: hash }
}

export * as LLMNative from "./native-request"
