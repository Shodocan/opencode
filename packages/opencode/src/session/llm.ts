import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, type ModelMessage, type Tool } from "ai"
import { LLMRequest, toDefinitions, type LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { ContextBudgetExceededError } from "./overflow"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNative } from "./llm/native-request"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { errorMessage } from "@/util/error"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

// Pure helper: construct a bounded warning payload for a tool call that could not
// be repaired. The same normalized error string feeds both the invalid-args
// model-facing text (constructed at the call site) and this structured payload.
export function formatRepairFailureWarningPayload(
  failedError: unknown,
  toolName: string,
  available: string[],
  sessionID: string,
) {
  const toolError = errorMessage(failedError)
  const boundedError = toolError.length > 200 ? toolError.slice(0, 197) + "..." : toolError
  const shown = available.slice(0, 15)
  return {
    "tool.name": toolName,
    "tool.error": boundedError,
    "tool.error_truncated": toolError.length > 200,
    "tool.available": shown,
    "tool.available_count": available.length,
    "tool.available_truncated": available.length > 15,
    "session.id": sessionID,
  }
}

// T06: the awaited final-pre-network lineage seam payload — the exact final
// route/runtime/projection/request-hash of the payload about to be (or not)
// dispatched.
export type LineageFinal = {
  readonly providerID: string
  readonly modelID: string
  readonly runtime: "native" | "ai-sdk"
  readonly requestHash: string
  readonly projection: unknown
}

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  /** T06: awaited before dispatch on both runtimes; failure fails the stream
   * before any native/streamText/HTTP/provider call. The sole pre-dispatch
   * lineage hook. */
  lineage?: (input: LineageFinal) => Effect.Effect<void>
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // T04 outgoing output: a defined outgoing cap is clamped down to the
      // route/runtime allowance (compaction: min(4_096, route output, runtime
      // cap) via the T02 budget projection allowance; normal requests keep
      // the full allowance because params and allowance share the same
      // formula). A plugin that strips the cap (e.g. the OpenAI/codex
      // chat.params hook) keeps it stripped — the clamp only lowers a defined
      // value, it never invents one. Both runtimes send this same value.
      const phase = input.agent.name === "compaction" ? "compaction" : "normal"
      const outgoingMaxOutputTokens =
        prepared.params.maxOutputTokens === undefined
          ? undefined
          : Math.min(prepared.params.maxOutputTokens, prepared.budgetProjection.outputAllowance)

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: outgoingMaxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
          cfg,
          phase,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          // T06 lineage seam (native): rebuild the exact final pre-network
          // value from the same inputs the runtime lowers (the runtime
          // admission has already run; the projection is of the post-
          // LLMRequest.update value the runtime hands to llmClient.stream).
          // A hook failure fails this effect before the native stream is
          // returned — zero native/streamText/HTTP/provider calls.
          if (input.lineage) {
            const nativeStatus = LLMNativeRuntime.status({ model: input.model, provider: item, auth: info })
            if (nativeStatus.type === "supported") {
              const nativeToolDefs = LLMNativeRuntime.nativeTools(prepared.tools, {
                messages: prepared.messages,
                abort: input.abort,
              })
              const nativeBase = LLMNative.request({
                model: input.model,
                apiKey: nativeStatus.apiKey,
                baseURL: nativeStatus.baseURL,
                // Defensive copy: ProviderTransform.message mutates in place;
                // the runtime applies its own single transform below.
                messages: ProviderTransform.message(structuredClone(prepared.messages), input.model, prepared.params.options ?? {}),
                toolChoice: input.toolChoice,
                temperature: prepared.params.temperature,
                topP: prepared.params.topP,
                topK: prepared.params.topK,
                maxOutputTokens: outgoingMaxOutputTokens,
                providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options ?? {}),
                headers: prepared.headers,
              })
              const nativeFinal = LLMRequest.update(nativeBase, {
                tools: [...nativeBase.tools, ...toDefinitions(nativeToolDefs)],
              })
              const projection = LLMNative.finalProjection(nativeFinal)
              const requestHash = LLMNative.requestHash({
                route: { providerID: input.model.providerID, modelID: input.model.id },
                runtime: "native",
                projection,
              })
              yield* input.lineage({
                providerID: input.model.providerID,
                modelID: input.model.id,
                runtime: "native",
                requestHash,
                projection,
              })
            }
          }
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })

      // T04: the sole named final transform for the AI SDK branch. This helper
      // is the only owner of ProviderTransform.message on this branch — the
      // legacy transformParams middleware is replaced by it — and it applies
      // the transform exactly once, on a defensive copy (the transform mutates
      // message objects in place). The single transformed result feeds both
      // the final pre-network admission gate and streamText immediately
      // before dispatch.
      const finalPrompt = ProviderTransform.message(
        structuredClone(prepared.messages),
        input.model,
        prepared.messageTransformOptions,
      )
      const aiSdkProviderOptions = ProviderTransform.providerOptions(input.model, prepared.params.options)

      // T04 final pre-network gate: the exact outgoing streamText params
      // (final transform output, tools, choice, serialization-affecting
      // options, output allowance) are the sole admission input. Media parts
      // are charged with the same T02-parity budget records as at prepare
      // time — raw base64 never enters the estimate. Rejection is a typed
      // failure before any streamText/doStream/HTTP/provider call.
      const finalPayload = {
        prompt: LLMNative.budgetMessages(finalPrompt),
        tools: prepared.budgetProjection.tools,
        toolChoice: input.toolChoice ?? null,
        temperature: prepared.params.temperature ?? null,
        topP: prepared.params.topP ?? null,
        topK: prepared.params.topK ?? null,
        maxOutputTokens: outgoingMaxOutputTokens,
        providerOptions: aiSdkProviderOptions ?? null,
      }

      // T06 lineage seam (AI SDK): the T04 final-transform single result is
      // the exact final pre-network payload. The hook is awaited before the
      // admission decision and dispatch; a hook failure fails this effect
      // before any streamText/HTTP/provider call.
      if (input.lineage) {
        const requestHash = LLMNative.requestHash({
          route: { providerID: input.model.providerID, modelID: input.model.id },
          runtime: "ai-sdk",
          projection: finalPayload,
        })
        yield* input.lineage({
          providerID: input.model.providerID,
          modelID: input.model.id,
          runtime: "ai-sdk",
          requestHash,
          projection: finalPayload,
        })
      }

      try {
        LLMNative.admit({
          model: input.model,
          cfg,
          projection: finalPayload,
          phase,
          runtime: "ai-sdk",
          maxOutputTokens: outgoingMaxOutputTokens,
        })
      } catch (cause) {
        if (cause instanceof ContextBudgetExceededError) yield* Effect.fail(cause)
        throw cause
      }

      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              bridge.fork(
                Effect.logWarning("tool call repaired: case mismatch", {
                  "tool.original": failed.toolCall.toolName,
                  "tool.repaired": lower,
                  "session.id": input.sessionID,
                }),
              )
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            // The AI SDK invokes repair for two failure modes: an unknown tool
            // name, or invalid arguments to a known tool. Distinguish them so the
            // model gets an accurate, self-correcting message either way instead
            // of a generic args-error that hides the real cause.
            const available = Object.keys(prepared.tools).filter((x) => x !== "invalid")
            const isUnknownTool = !(failed.toolCall.toolName in prepared.tools)
            // One normalized error string feeds both invalid-args model-facing text
            // and the structured warning payload — avoids unsafe `failed.error.message`
            // access for non-Error/nullish values and guarantees consistency.
            const toolError = errorMessage(failed.error)
            // Cap the available-tools hint so the tool input stored in state.input
            // doesn't overflow the TUI render grid with 60+ tool names. The full
            // list is logged above for diagnostics.
            const shown = available.slice(0, 15)
            const hint = available.length
              ? ` Available tools: ${shown.join(", ")}${available.length > shown.length ? `, ... (${available.length - shown.length} more)` : ""}.`
              : " No tools are available in this turn."
            const boundedError = toolError.length > 200 ? toolError.slice(0, 197) + "..." : toolError
            const error = isUnknownTool
              ? `Unknown tool: ${failed.toolCall.toolName}.${hint}`
              : `Tool "${failed.toolCall.toolName}" failed: ${boundedError}`
            bridge.fork(
              Effect.logWarning(
                "tool call could not be repaired",
                formatRepairFailureWarningPayload(failed.error, failed.toolCall.toolName, available, input.sessionID),
              ),
            )
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: aiSdkProviderOptions,
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: outgoingMaxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: finalPrompt,
          model: language,
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
  ],
})

export * as LLM from "./llm"
