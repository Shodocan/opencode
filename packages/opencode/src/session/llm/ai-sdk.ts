import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue, type InferenceCategory } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"
import { ProviderError } from "@/provider/error"
import { createHash } from "node:crypto"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

type RouteBinding = { providerID: string; nonce: string; sessionID: string }
export function adapterState(route?: RouteBinding, category?: InferenceCategory) {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: undefined as number | undefined,
    route,
    category,
  }
}

function transportRoute(state: ReturnType<typeof adapterState>, headers: Record<string, string> | undefined) {
  if (state.route?.providerID !== "opencode-route" || !headers) return
  const matches = Object.entries(headers).filter(([name]) => name.toLowerCase() === "x-opencode-route-attestation")
  if (matches.length !== 1 || typeof matches[0]?.[1] !== "string") return
  const value = matches[0][1]
  if (value.length > 1024 || value.split(".").length !== 2) return
  const [encoded, proof] = value.split(".")
  if (!encoded || !/^[0-9a-f]{64}$/.test(proof ?? "") || encoded.includes("=")) return
  try {
    const raw = Buffer.from(encoded, "base64url")
    if (raw.toString("base64url") !== encoded) return
    const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    if (Buffer.from(JSON.stringify(parsed, Object.keys(parsed).sort())).toString("base64url") !== encoded) return
    const required = ["model", "nonce", "observation_id", "session_sha256", "target", "v"]
    const keys = Object.keys(parsed).sort()
    if (keys.join() !== required.join() && keys.join() !== [...required, "effort"].sort().join()) return
    if (parsed.v !== 1 || parsed.nonce !== state.route.nonce) return
    if (parsed.session_sha256 !== createHash("sha256").update(state.route.sessionID).digest("hex")) return
    if (typeof parsed.target !== "string" || !["is1", "yolo", "ollama", "opencode_go"].includes(parsed.target)) return
    if (typeof parsed.model !== "string" || !validIdentifier(parsed.model, 200)) return
    if (parsed.effort !== undefined && (typeof parsed.effort !== "string" || !validIdentifier(parsed.effort, 32))) return
    if (typeof parsed.observation_id !== "string" || !/^[0-9a-f]{32}$/.test(parsed.observation_id)) return
    return {
      source: "managed_gateway_attestation" as const,
      provider: parsed.target as "is1" | "yolo" | "ollama" | "opencode_go",
      model: parsed.model,
      ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
      observationID: parsed.observation_id,
    }
  } catch {
    return
  }
}

function validIdentifier(value: string, limit: number) {
  return value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @opencode-ai/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown) {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const response =
    raw.response && typeof raw.response === "object" ? (raw.response as Record<string, unknown>) : undefined
  const usage = raw.copilot_usage ?? response?.copilot_usage
  if (!usage || typeof usage !== "object") return
  const total = (usage as Record<string, unknown>).total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return
  return total
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const entries = Object.entries({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
    cacheWriteInputTokens: item.inputTokenDetails?.cacheWriteTokens,
  }).filter((entry) => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function responseModel(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))
    return
  return value
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      if (event.rawFinishReason === "network_error")
        return Effect.fail(new ProviderError.ResponseStreamError("Provider finish_reason: network_error"))
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata =
          state.copilotTotalNanoAiu === undefined
            ? original
            : {
                ...original,
                copilot: {
                  ...original?.copilot,
                  totalNanoAiu: state.copilotTotalNanoAiu,
                },
              }
        state.copilotTotalNanoAiu = undefined
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            responseModel: responseModel(event.response.modelId),
            transportRoute: transportRoute(state, event.response.headers),
            category: state.category,
            usage: usage(event.usage),
            providerMetadata: metadata,
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        const events = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
          }),
        ]
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState(state.route, state.category))
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: currentTextID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = undefined
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      return Effect.succeed([])

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = copilotTotalNanoAiu(event.rawValue) ?? state.copilotTotalNanoAiu
        return []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"
