import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { QuotaFallback } from "@opencode-ai/schema/quota"
import { Cause, Clock, Deferred, Effect, Exit, Layer, Context, Option, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { CompactionImpossibleError, ContextBudgetExceededError, isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { LLMEvent, Usage } from "@opencode-ai/llm"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  /**
   * The last `process` call stopped at the final pre-network budget
   * admission (ContextBudgetExceededError): nothing reached the provider.
   */
  readonly budgetRefused?: boolean
  /**
   * Set when the last `process` call kept a cut attempt's started tool calls
   * and ended so the loop resumes from history: the provider retry budget
   * the turn has spent so far, for the next step of the same turn.
   */
  readonly resume?: Resume
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

/**
 * Provider retry budget one turn has spent, carried across safe resumes: its
 * failed attempts and the time spent retrying them. `elapsed` is a duration,
 * not a start time, so the wait for started tools never counts against it.
 */
export type Resume = { readonly attempts: number; readonly elapsed: number }

/** A tool body invoked by the transport, with the value its execute returned. */
type ToolRun = { name: string; input: unknown; result: unknown }

/** Parts that existed before a provider attempt and tools it started. */
type Attempt = {
  before: Set<string>
  started: Map<string, ToolRun>
  stepFinished: boolean
  /**
   * Abort signal handed to tool bodies when a provider retry policy is set.
   * A cut stream closes the request without stopping its started tools, so
   * they can be awaited; it aborts when the attempt is settled or interrupted.
   */
  hold?: AbortController
  /**
   * Set once the attempt is being settled. A tool body the transport gets to
   * after that is refused instead of started, so the set of started calls the
   * settle step decides on is final.
   */
  closed: boolean
  /** Calls refused that way: they never ran. */
  refused: Set<string>
}

/**
 * Retry budget state of one `process` call: failed attempts of the turn, the
 * retry time earlier steps spent, the first failure of this call, and the
 * budget to carry when this call ends in a safe resume.
 */
type Chain = { attempts: number; elapsed: number; start: number | undefined; resume: Resume | undefined }

export const NOT_EXECUTED = "Not executed: the provider stream was cut before this tool call started"

// Bounded wait for tools of a failed attempt to record their result.
const TOOL_SETTLE_GRACE = "2 seconds"

const thenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function"

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
  /** Budget already spent by safe resumes earlier in this turn. */
  resume?: Resume
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  budgetRefused: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        budgetRefused: false,
        currentText: undefined,
        reasoningMap: {},
      }
      let aborted = false
      // Done once the turn has ended. Until then a tool that ran records its
      // outcome, also from its own fiber after an abort. From then on the last
      // writes of the turn say what the call looks like: an outcome still
      // waiting for the database is given up and a later one is not written,
      // so nothing lands after the turn has said how it ended.
      const ended = yield* Deferred.make<void>()
      let attempt: Attempt | undefined
      let chain: Chain = { attempts: 0, elapsed: 0, start: undefined, resume: undefined }

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      // T06 session boundary: the internal budget errors (final pre-network
      // admission and bounded planner failures) are internal-only; at the
      // session boundary they surface as the public ContextOverflowError so
      // the overflow repair path applies. The public shape/text is preserved
      // — internal names never reach message info.
      const boundaryError = (e: unknown, parsed: ReturnType<typeof parse>) =>
        e instanceof ContextBudgetExceededError || e instanceof CompactionImpossibleError
          ? new SessionV1.ContextOverflowError({ message: "Input exceeds context window of this model" }).toObject()
          : parsed

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      // A tool that ran: its outcome exists nowhere else, and losing it leaves the
      // call looking interrupted, to be run again. Its write waits for the
      // database far longer than any other, and the session says so meanwhile.
      // False when the turn ended first and the outcome was not written.
      const recordOutcome = <A, E, R>(write: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(ended)) return false
          return yield* write.pipe(
            Database.lockWithin("outcome", (notice) =>
              status.set(
                ctx.sessionID,
                notice.next === undefined
                  ? { type: "busy" }
                  : {
                      type: "retry",
                      attempt: notice.attempts,
                      message: "Database is busy: waiting to store a tool result",
                      next: notice.next,
                    },
              ),
            ),
            Effect.as(true),
            Effect.raceFirst(Deferred.await(ended).pipe(Effect.as(false))),
          )
        })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        const stored = yield* recordOutcome(
          session.updatePart({
            ...match.part,
            state: {
              status: "completed",
              input: match.part.state.input,
              output: output.output,
              metadata: output.metadata,
              title: output.title,
              time: { start: match.part.state.time.start, end: Date.now() },
              attachments: output.attachments,
            },
          }),
        )
        if (!stored) return
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        const rejected = error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError
        const failed = session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        // A call that was refused or never started has no outcome to keep.
        const stored = yield* rejected || errorMessage(error) === NOT_EXECUTED
          ? failed.pipe(Effect.as(true))
          : recordOutcome(failed)
        if (!stored) return false
        if (rejected) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            // Anthropic reports thinking blocks it removed before the model saw the
            // prompt. Prefix mismatches mean opencode changed history behind a signed
            // block; log them so the churn can be tracked down.
            const dropped = isRecord(value.providerMetadata?.anthropic)
              ? value.providerMetadata.anthropic.inputTransformations
              : undefined
            const transportRoute = value.transportRoute && {
              source: value.transportRoute.source,
              provider: value.transportRoute.provider,
              model: value.transportRoute.model,
              ...(value.transportRoute.effort === undefined ? {} : { effort: value.transportRoute.effort }),
              observation_id: value.transportRoute.observationID,
              ...(value.transportRoute.receiptVersion === 2 ? {
                receipt_version: value.transportRoute.receiptVersion,
                requested_model: value.transportRoute.requestedModel,
                requested_effort: value.transportRoute.requestedEffort,
                generation: value.transportRoute.generation,
                selection_reason: value.transportRoute.selectionReason,
              } : {}),
            }
            const inferenceCategory = value.category && {
              source: value.category.source,
              category: value.category.category,
              matrix_sha256: value.category.matrixSHA256,
            }
            const quotaFallback = value.quotaFallback
            if (Array.isArray(dropped) && dropped.length > 0) {
              yield* Effect.logWarning("thinking blocks dropped by provider", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                model: ctx.model.id,
                transformations: JSON.stringify(dropped),
              })
            }
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            const reportedUsage = value.usage
              ? Object.fromEntries(
                  Object.entries({
                    input_tokens: value.usage.inputTokens,
                    output_tokens: value.usage.outputTokens,
                    total_tokens: value.usage.totalTokens,
                    reasoning_tokens: value.usage.reasoningTokens,
                    cache_read_input_tokens: value.usage.cacheReadInputTokens,
                    cache_write_input_tokens: value.usage.cacheWriteInputTokens,
                  }).filter((entry) => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0),
                )
              : undefined
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
              // Optional accounting must never prevent a completed step from
              // sealing when a custom route cannot be represented safely.
              inference:
                Schema.is(SessionV1.InferenceIdentifier)(ctx.model.providerID) &&
                Schema.is(SessionV1.InferenceIdentifier)(ctx.model.id)
                  ? {
                      requested: {
                        provider_id: ctx.model.providerID,
                        model_id: ctx.model.id,
                        ...(Schema.is(SessionV1.InferenceIdentifier)(ctx.assistantMessage.variant)
                          ? { effort: ctx.assistantMessage.variant }
                          : {}),
                      },
                      response: {
                        ...(Schema.is(SessionV1.InferenceIdentifier)(value.responseModel)
                          ? { model_id: value.responseModel }
                          : {}),
                        source: "transport_response",
                        upstream_actual_identity: "unknown",
                      },
                      ...(ctx.model.providerID === "opencode-route" &&
                      Schema.is(SessionV1.InferenceTransportRoute)(transportRoute)
                        ? { transport_route: transportRoute }
                        : {}),
                      ...(inferenceCategory && Schema.is(SessionV1.InferenceCategory)(inferenceCategory)
                        ? { category: inferenceCategory }
                        : {}),
                      ...(quotaFallback && Schema.is(QuotaFallback)(quotaFallback)
                        ? { quota_fallback: quotaFallback }
                        : {}),
                      ...(reportedUsage && Object.keys(reportedUsage).length > 0
                        ? { usage: { source: "llm_normalized", ...reportedUsage } }
                        : {}),
                      cost: {
                        amount: usage.cost,
                        semantics: "configured_rate_estimate",
                        actual_bill: "unknown",
                      },
                    }
                  : undefined,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (attempt) attempt.stepFinished = true
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )
        // Calls still open are marked below: their outcomes no longer count.
        yield* Deferred.succeed(ended, undefined)

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const removeParts = Effect.fn("SessionProcessor.removeParts")(function* (parts: SessionV1.Part[]) {
        for (const part of parts) {
          if (part.type === "tool") yield* settleToolCall(part.callID)
          yield* session.removePart({ sessionID: part.sessionID, messageID: part.messageID, partID: part.id })
        }
      })

      // Runs after a failed attempt's stream scope closed, so its request is
      // already aborted. A retryable failure is replayed only when the attempt
      // left nothing durable; its partial output is removed first so history
      // never holds the same text or tool call twice. When a tool call had
      // started, the attempt is never replayed: its started calls are awaited
      // to their terminal state and kept, and the loop resumes from history
      // while the provider retry budget lasts.
      const settleAttempt = Effect.fn("SessionProcessor.settleAttempt")(function* (
        e: unknown,
        config: SessionRetry.Config | undefined,
        chain: Chain,
      ) {
        const current = attempt
        attempt = undefined
        if (!current) return yield* Effect.fail(e)
        // Without a provider retry policy the failed attempt is handled exactly as
        // before (no settling, nothing removed); the settle path is opt-in via
        // provider.<id>.options.retry.
        if (!config) return yield* Effect.fail(e)
        // The transport invokes a tool body detached from its stream, so one
        // can still arrive after the cut. From here on it is refused: only the
        // calls already in `current.started` ever ran.
        current.closed = true
        const error = boundaryError(e, parse(e))
        if (!SessionRetry.retryable(error, input.model.providerID, config)) {
          return yield* Effect.fail(e)
        }
        // One failed attempt of this turn, counted against the same budget as
        // a replay (the retry schedule continues from `input.resume`). The
        // retry time is fixed here, before started tools are awaited: however
        // long they run, their time is not spent retrying.
        chain.attempts++
        const now = yield* Clock.currentTimeMillis
        chain.start ??= now
        const spent = chain.elapsed + now - chain.start
        const retry = SessionRetry.decide({
          error,
          provider: input.model.providerID,
          attempt: chain.attempts,
          elapsed: spent,
          limit: yield* SessionRetry.RetryLimit,
          config,
        })
        // An exhausted budget stops started tools, as the closed request did
        // before, and settles them within the short grace below.
        if (!retry) {
          current.hold?.abort()
          yield* Effect.forEach(
            Object.values(ctx.toolcalls),
            (call) => Deferred.await(call.done).pipe(Effect.timeout(TOOL_SETTLE_GRACE), Effect.ignore),
            { concurrency: "unbounded" },
          )
        }
        const attemptParts = () =>
          MessageV2.parts(ctx.assistantMessage.id).pipe(
            Effect.provideService(Database.Service, database),
            Effect.map((parts) => parts.filter((part) => !current.before.has(part.id))),
          )
        // A tool body that ran while its stream died finishes after the
        // consumer stopped reading: record its result or failure from its
        // execute promise instead of losing it (or replaying the tool). While
        // the budget lasts the tool keeps running and is awaited to the end.
        const seen = new Set((yield* attemptParts()).flatMap((part) => (part.type === "tool" ? [part.callID] : [])))
        yield* Effect.forEach(
          current.started,
          ([callID, run]) =>
            Effect.gen(function* () {
              if (!seen.has(callID)) yield* ensureToolCall({ id: callID, name: run.name })
              const match = yield* readToolCall(callID)
              if (!match || (match.part.state.status !== "pending" && match.part.state.status !== "running")) return
              const result = run.result
              if (!thenable(result)) return
              const settled = Effect.promise(() =>
                Promise.resolve(result).then(
                  (value) => ({ ok: true as const, value }),
                  (cause: unknown) => ({ ok: false as const, cause }),
                ),
              )
              const outcome = retry
                ? Option.some(yield* settled)
                : yield* settled.pipe(Effect.timeoutOption(TOOL_SETTLE_GRACE))
              if (Option.isNone(outcome)) return
              const input = isRecord(run.input) ? run.input : { value: run.input }
              yield* updateToolCall(callID, (part) =>
                part.state.status === "pending"
                  ? { ...part, state: { status: "running", input, time: { start: Date.now() } } }
                  : part,
              )
              if (!outcome.value.ok) return yield* failToolCall(callID, outcome.value.cause)
              const value = outcome.value.value
              yield* handleEvent(LLMEvent.toolResult({ id: callID, name: run.name, result: { type: "json", value } }))
            }),
        )
        const parts = yield* attemptParts()
        // A refused call was announced by the stream but its body never ran.
        const started = (part: SessionV1.Part): part is SessionV1.ToolPart =>
          part.type === "tool" &&
          (current.started.has(part.callID) ||
            (part.state.status !== "pending" && !current.refused.has(part.callID)))
        const ran = parts.filter(started)

        if (ran.length === 0 && !current.stepFinished) {
          yield* removeParts(parts)
          ctx.toolcalls = {}
          ctx.currentText = undefined
          ctx.reasoningMap = {}
          return yield* Effect.fail(e)
        }

        // A call still pending or running here has no recorded outcome (its
        // body was never tracked, e.g. provider-executed): it may have run, so
        // it is never resumed over. The same error ends an exhausted budget,
        // unless the step had finished: that step is complete as it stands.
        const unsettled = ran.filter(
          (part) =>
            part.state.status === "pending" ||
            part.state.status === "running" ||
            (part.state.status === "error" && part.state.metadata?.interrupted === true),
        )
        if (unsettled.length > 0 || (ran.length > 0 && !retry && !current.stepFinished)) {
          const cause = isRecord(error.data) && typeof error.data.message === "string" ? error.data.message : errorMessage(e)
          return yield* Effect.fail(
            new ProviderError.RetryUnsafeError(
              (unsettled.length > 0 ? unsettled : ran).map((part) => part.tool),
              cause,
              e,
            ),
          )
        }

        // Every started tool recorded its outcome (or the step had finished):
        // keep that progress and let the loop continue from it. A call whose
        // arguments never finished streaming, or whose body was refused above,
        // never ran: record it as not executed so the model can issue it again.
        const end = Date.now()
        yield* Effect.forEach(
          parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && !started(part)),
          (part) =>
            Effect.gen(function* () {
              yield* session.updatePart({
                ...part,
                state: {
                  status: "error",
                  input: part.state.input,
                  error: NOT_EXECUTED,
                  metadata: { notExecuted: true },
                  time: { start: end, end },
                },
              })
              yield* settleToolCall(part.callID)
            }),
        )
        // The cut text or reasoning is kept as it streamed; cleanup() persists
        // it with the marker.
        if (ctx.currentText) ctx.currentText.metadata = { ...ctx.currentText.metadata, incomplete: true }
        for (const part of Object.values(ctx.reasoningMap)) part.metadata = { ...part.metadata, incomplete: true }
        if (!current.stepFinished) ctx.assistantMessage.finish = "tool-calls"
        yield* Effect.logWarning("provider attempt failed after durable progress; resuming without replay", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          tools: ran.map((part) => part.tool).join(","),
          attempt: chain.attempts,
          error: errorMessage(e),
        })
        if (ran.length === 0 || !retry) return
        chain.resume = { attempts: chain.attempts, elapsed: spent + retry.wait }
        yield* status.set(ctx.sessionID, {
          type: "retry",
          attempt: chain.attempts,
          message: retry.message,
          action: retry.action,
          next: Date.now() + retry.wait,
        })
        yield* Effect.sleep(retry.wait)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = boundaryError(e, parse(e))
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          ctx.budgetRefused = e instanceof ContextBudgetExceededError
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      // Record every tool body the transport invokes so a failed attempt is
      // never replayed over a side effect, even when its tool-call event was
      // lost with the stream; the execute result lets that attempt keep it.
      const track = (tools: LLM.StreamInput["tools"], current: Attempt): LLM.StreamInput["tools"] =>
        Object.fromEntries(
          Object.entries(tools).map(([name, item]) => {
            const execute = item.execute
            if (!execute) return [name, item]
            const tracked: typeof execute = (args, options) => {
              if (current.closed || current.hold?.signal.aborted) {
                current.refused.add(options.toolCallId)
                throw new Error(NOT_EXECUTED)
              }
              let result: unknown
              try {
                result = execute(args, current.hold ? { ...options, abortSignal: current.hold.signal } : options)
                return result as ReturnType<typeof execute>
              } finally {
                current.started.set(options.toolCallId, { name, input: args, result })
              }
            }
            return [name, { ...item, execute: tracked }]
          }),
        )

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.budgetRefused = false
        const cfg = yield* config.get()
        ctx.shouldBreak = cfg.experimental?.continue_loop_on_deny !== true
        const retryConfig: SessionRetry.Config | undefined = cfg.provider?.[input.model.providerID]?.options?.retry
        const carried = retryConfig ? input.resume : undefined
        chain = {
          attempts: carried?.attempts ?? 0,
          elapsed: carried?.elapsed ?? 0,
          start: undefined,
          resume: undefined,
        }
        let hold: AbortController | undefined

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            const existing = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            hold = retryConfig ? new AbortController() : undefined
            const current: Attempt = {
              before: new Set(existing.map((part) => part.id)),
              started: new Map(),
              stepFinished: false,
              hold,
              closed: false,
              refused: new Set(),
            }
            attempt = current
            yield* status.set(ctx.sessionID, { type: "busy" })
            // A workflow quota switch creates a fresh child, so an earlier
            // provider turn cannot be replayed safely. Read durable unfiltered
            // history; compaction and message plugins must not erase this fence.
            const history = streamInput.parentSessionID
              ? yield* session.messages({ sessionID: input.sessionID })
              : undefined
            const stream = llm.stream({
              ...streamInput,
              tools: track(streamInput.tools, current),
              quotaPriorActivity: history?.some((message) => message.info.role === "assistant" && (
                message.info.id !== input.assistantMessage.id || message.parts.some((part) =>
                  part.type !== "step-start" && part.type !== "step-finish" && part.type !== "snapshot",
                )
              )),
            })

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.catch((e) =>
              settleAttempt(e, retryConfig, chain).pipe(
                // Awaiting started tools can take long; a cancel there ends
                // the turn the same way as a cancel while streaming.
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    aborted = true
                    if (!ctx.assistantMessage.error) yield* halt(new DOMException("Aborted", "AbortError"))
                  }),
                ),
              ),
            ),
            // Tools of a finished, failed or interrupted attempt stop here,
            // never earlier than its settle step.
            Effect.ensuring(Effect.sync(() => hold?.abort())),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                config: retryConfig,
                carried,
                parse,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            // A turn that was aborted or failed ends quickly: its last writes
            // share one short wait for the database instead of a full one each.
            Effect.ensuring(
              Effect.suspend(() =>
                aborted || ctx.assistantMessage.error ? cleanup().pipe(Database.lockWithin("abort")) : cleanup(),
              ).pipe(
                // Also when those writes failed: the turn is over either way.
                Effect.ensuring(
                  Effect.suspend(() => {
                    ctx.toolcalls = {}
                    return Deferred.succeed(ended, undefined)
                  }),
                ),
              ),
            ),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        get budgetRefused() {
          return ctx.budgetRefused
        },
        get resume() {
          return chain.resume
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
