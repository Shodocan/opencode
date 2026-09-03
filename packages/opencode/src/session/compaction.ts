import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { stripAllVolatile } from "./volatile"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { isMedia } from "@/util/media"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { NamedError } from "@opencode-ai/core/util/error"

import { Effect, Layer, Context, Exit, Cause } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { CompactionImpossibleError, ContextBudget, isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { createHash } from "node:crypto"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function isCompactionContinuation(message: SessionV1.WithParts) {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true)
  )
}

// FORK FEATURE (9) stop-recovery — sibling marker for recovery continuations.
// Excluded from compaction turn accounting and overflow replay selection, same
// as compaction_continue (spec §5.1/§6, B3).
function isStopRecoveryContinuation(message: SessionV1.WithParts) {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.stop_recovery_continue === true)
  )
}

// Shared predicate: any synthetic continuation marker (compaction or
// stop-recovery). Used at the turn-accounting and replay-selection seams.
function isSyntheticContinuation(message: SessionV1.WithParts) {
  return isCompactionContinuation(message) || isStopRecoveryContinuation(message)
}

// Exported for the B3 unit test (spec §5.1: stop_recovery_continue excluded
// from compaction turn accounting exactly like compaction_continue).
export const __test = { isCompactionContinuation, isStopRecoveryContinuation, isSyntheticContinuation }

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
     if (msg.parts.some((part) => part.type === "compaction")) continue
     if (isSyntheticContinuation(msg)) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (
            msg.info.role === "user" &&
            !msg.parts.some((p) => p.type === "compaction") &&
            !isSyntheticContinuation(msg)
          ) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay &&
          messages.some(
            (m) =>
              m.info.role === "user" && !m.parts.some((p) => p.type === "compaction") && !isSyntheticContinuation(m),
          )
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      // FORK: auto-compaction summarizes on the session's currently selected
      // route. The route recorded on the triggering user message can be stale
      // (pre-fix prompt_async wakeups persisted the default agent model), and
      // the session row carries the user's current selection. Explicit/manual
      // compactions keep the caller-provided route.
      const current = yield* session.get(input.sessionID).pipe(Effect.orDie)
      const sessionRoute =
        compactionPart?.auto === true && current.model
          ? {
              providerID: ProviderV2.ID.make(current.model.providerID),
              modelID: ModelV2.ID.make(current.model.id),
              ...(current.model.variant && current.model.variant !== "default"
                ? { variant: current.model.variant }
                : {}),
            }
          : undefined
      const sessionRouteModel = sessionRoute
        ? yield* provider
            .getModel(sessionRoute.providerID, sessionRoute.modelID)
            .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
        : undefined
      const modelRef: { providerID: ProviderV2.ID; modelID: ModelV2.ID; variant?: string } =
        agent.model ?? (sessionRouteModel ? sessionRoute : undefined) ?? userMessage.model
      const modelExit = yield* provider.getModel(modelRef.providerID, modelRef.modelID).pipe(Effect.exit)
      if (Exit.isFailure(modelExit)) {
        const err = Cause.squash(modelExit.cause)
        if (Provider.ModelNotFoundError.isInstance(err)) {
          const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
          yield* events.publish(Session.Event.Error, {
            sessionID: input.sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
            }).toObject(),
          })
        }
        return yield* Effect.die(err)
      }
      const model = modelExit.value
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const transformed = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: transformed })
      // FORK FEATURE (12) volatile-injection — never let ephemeral retrievals
      // launder into a permanent summary. Strip every volatile part regardless
      // of which turn it belongs to before feeding the summarizer.
      const msgs = stripAllVolatile(transformed)
      const tailIndex = selected.tail_start_id
        ? history.findIndex((message) => message.info.id === selected.tail_start_id)
        : -1
      const recent =
        tailIndex < 0
          ? ""
          : JSON.stringify(
              yield* MessageV2.toModelMessagesEffect(history.slice(tailIndex), model, {
                stripMedia: true,
                toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
              }),
            )
      const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
          }),
          ...compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: modelRef.variant ?? userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      // T05: intermediate summary state stays in memory; durable rows are
      // byte-equivalent to the entry until the finalization commit. The
      // processor's own finalizer persists the in-flight summary message on
      // interrupt; this outer finalizer (LIFO — it runs after the inner one)
      // removes that row so an aborted execution leaves nothing durable.
      const result = yield* processor.process({
        user: { ...userMessage, model: { ...modelRef, variant: modelRef.variant ?? userMessage.model.variant } },
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  nextPrompt,
                  ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        ],
        model,
      }).pipe(
        Effect.onInterrupt(
          Effect.fn("SessionCompaction.process.aborted")(function* () {
            yield* session.removeMessage({ sessionID: input.sessionID, messageID: msg.id })
          }),
        ),
      )

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (processor.message.error) return "stop"

      if (result === "continue") {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          const autoContinueModelExit = yield* provider
            .getModel(userMessage.model.providerID, userMessage.model.modelID)
            .pipe(Effect.exit)
          if (Exit.isFailure(autoContinueModelExit)) {
            const err = Cause.squash(autoContinueModelExit.cause)
            if (Provider.ModelNotFoundError.isInstance(err)) {
              const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
              yield* events.publish(Session.Event.Error, {
                sessionID: input.sessionID,
                error: new NamedError.Unknown({
                  message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
                }).toObject(),
              })
            }
            return yield* Effect.die(err)
          }
          yield* plugin.trigger(
            "experimental.compaction.autocontinue",
            {
              sessionID: input.sessionID,
              agent: userMessage.agent,
              model: autoContinueModelExit.value,
              provider: {
                source: info.source,
                info,
                options: info.options,
              },
              message: userMessage,
              overflow: input.overflow === true,
            },
            { enabled: true },
          )
          const continueMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: userMessage.agent,
            model: userMessage.model,
          })
          const text =
            (input.overflow
              ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
              : "") +
            "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: continueMsg.id,
            sessionID: input.sessionID,
            type: "text",
            // Internal marker for post-compaction followups so provider plugins
            // can distinguish them from manual post-compaction user prompts.
            // This is not a stable plugin contract and may change or disappear.
            metadata: { compaction_continue: true },
            synthetic: true,
            text,
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          })
        }
      }

      if (result === "continue") {
        const existing = (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
          (item) => item.info.id === msg.id,
        )
        // A minimal processor (test doubles) may not have persisted the
        // summary message row itself; persist the proven final assistant
        // state before the finalization event commits.
        if (!existing) yield* session.updateMessage(processor.message)
        const summary = summaryText(existing ?? { info: processor.message, parts: [] })

        // ─── T05: publish exactly one versioned CompactionFinalized full-state
        // event. Nothing earlier is durable; the dedicated core projector
        // writes the final checkpoint rows in the same event transaction.
        // State estimates are measured without the prompt, the same way the
        // planner measures history projections.
        const content = (existing?.parts ?? [])
          .filter((part): part is SessionV1.TextPart => part.type === "text")
          .map((part) => ({ type: "text" as const, id: part.id, text: part.text }))
        const toChat = (items: SessionV1.WithParts[]) => items.map(plannerProjectMessage).map(plannerChatMessage)
        const beforeEstimate = ContextBudget.estimate({ messages: toChat(history) })
        const budget = ContextBudget.evaluate({
          model,
          cfg,
          estimate: 0,
          phase: "compaction",
          outputTokens: PLANNER_SUMMARY_OUTPUT_TOKENS,
        }).budget
        const afterEstimate = ContextBudget.estimate({
          messages: [
            { role: "assistant", content: [{ type: "text", text: summary ?? "" }] },
            ...toChat(tailIndex < 0 ? [] : history.slice(tailIndex)),
          ],
        })
        yield* events.publish(SessionEvent.CompactionFinalized, {
          timestamp: DateTime.makeUnsafe(Date.now()),
          sessionID: input.sessionID,
          compaction: {
            message: {
              id: SessionMessage.ID.make(input.parentID),
              type: "user",
              text: parent.parts
                .filter((part): part is SessionV1.TextPart => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
              time: { created: DateTime.makeUnsafe(userMessage.time.created) },
            },
            marker: {
              id: SessionMessage.ID.make(MessageID.ascending()),
              type: "compaction",
              reason: input.auto ? "auto" : "manual",
              summary: summary ?? "",
              recent,
              time: { created: DateTime.makeUnsafe(Date.now()) },
            },
            assistant: {
              id: SessionMessage.ID.make(msg.id),
              type: "assistant",
              agent: "compaction",
              model: { id: model.id, providerID: model.providerID },
              content,
              finish: "stop",
              cost: processor.message.cost,
              tokens: {
                input: processor.message.tokens.input,
                output: processor.message.tokens.output,
                reasoning: processor.message.tokens.reasoning,
                cache: {
                  read: processor.message.tokens.cache.read,
                  write: processor.message.tokens.cache.write,
                },
              },
              time: { created: DateTime.makeUnsafe(msg.time.created), completed: DateTime.makeUnsafe(Date.now()) },
            },
            parts: content,
          },
          recent,
          usage: {
            cost: processor.message.cost,
            tokens: {
              input: processor.message.tokens.input,
              output: processor.message.tokens.output,
              reasoning: processor.message.tokens.reasoning,
              cache: {
                read: processor.message.tokens.cache.read,
                write: processor.message.tokens.cache.write,
              },
            },
          },
          before: { estimate: beforeEstimate, budget },
          after: { estimate: afterEstimate, budget },
        })

        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID; variant?: string }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"

// ─── T03 — Pure bounded compaction planner ───────────────────────────────────
//
// CompactionPlanner is a pure, NONPERSISTENT, synchronous planner for bounded
// compaction (QCB-003..006). It makes no durable writes, no provider calls,
// and never mutates the input transcript. It projects older history into at
// most MAX_CHUNK_COUNT budget-checked chunks, keeps the latest user turn
// intact outside every chunk, and admits every proposed request through
// ContextBudget.evaluate with the 4,096 compaction output allowance — always
// counting the conservative worst-case prior rolling summary reserve
// (SUMMARY_RESERVE_CHARS = 4,096 * 4), so a chunk that only fits with an
// empty prior summary is never planned.
//
//   - Media parts become deterministic `[Attached <mime>: <filename>]` text
//     placeholders inside chunk projections; the latest turn keeps media
//     verbatim.
//   - Historical tool output is capped at TOOL_OUTPUT_MAX_CHARS inside chunk
//     projections; durable rows are never altered.
//   - Chunk boundaries fall only on complete user-turn boundaries; a tool
//     call is never separated from its turn/results. Only an individually
//     oversized text part (longer than one chunk can carry) is split; the
//     pieces carry role/order metadata under a `split` key and concatenate
//     losslessly back to the original text.
//   - Pre-call failures are evaluated before any chunk planning:
//     `fixed-overhead`, then `latest-turn-too-large`. A fifth required chunk
//     fails terminally with `chunk-limit`.
//   - Boundaries, requests, and hashes are deterministic: identical input
//     yields identical chunks, estimates, and requestHash values.

export type CompactionPlannerSplitMeta = {
  readonly role: string
  readonly index: number
  readonly total: number
}

export type CompactionPlannerSplitTextPart = SessionV1.TextPart & {
  readonly split: CompactionPlannerSplitMeta
}

export type CompactionPlannerPart = SessionV1.Part | CompactionPlannerSplitTextPart

export type CompactionPlannerWithParts = {
  readonly info: SessionV1.Info
  readonly parts: CompactionPlannerPart[]
}

export type CompactionPlannerChatContent = {
  readonly type: string
  readonly [key: string]: unknown
}

export type CompactionPlannerChatMessage = {
  readonly role: "user" | "assistant"
  readonly content: readonly CompactionPlannerChatContent[]
}

export type CompactionPlannerRequest = {
  readonly phase: "compaction"
  readonly summaryOutputTokens: number
  readonly summaryReserveChars: number
  readonly chunkIndex: number
  readonly messages: readonly CompactionPlannerChatMessage[]
}

export type CompactionPlannerChunk = {
  readonly index: number
  readonly messages: readonly CompactionPlannerWithParts[]
}

export type CompactionPlannerProposal = {
  readonly chunk: CompactionPlannerChunk
  readonly request: CompactionPlannerRequest
  readonly requestEstimate: number
  readonly requestHash: string
  readonly admitted: boolean
}

export type CompactionPlannerPlan = {
  readonly chunks: readonly CompactionPlannerChunk[]
  readonly latestTurn: readonly SessionV1.WithParts[]
  readonly proposals: readonly CompactionPlannerProposal[]
}

export type CompactionPlannerInput = {
  readonly messages: readonly SessionV1.WithParts[]
  readonly model: Provider.Model
  readonly cfg: ConfigV1.Info
  readonly requestHash?: string
}

const PLANNER_PHASE = "compaction"
const PLANNER_SUMMARY_OUTPUT_TOKENS = 4_096
// Pinned serialized prior-summary reserve: 4,096 summary tokens * 4 chars/token.
const PLANNER_SUMMARY_RESERVE_CHARS = PLANNER_SUMMARY_OUTPUT_TOKENS * 4
const PLANNER_MAX_CHUNK_COUNT = 4
// Short deterministic marker standing in for the worst-case prior rolling
// summary inside the request projection; the full reserve is accounted for in
// the estimate (never materialized here).
const PLANNER_RESERVE_MARKER = `[prior-rolling-summary:reserve up to ${PLANNER_SUMMARY_RESERVE_CHARS} chars]`
// Conservative envelope for one projected message (role/content/part skeleton
// plus split metadata) in chars; a piece at the piece limit still fits a
// chunk alone with this allowance.
const PLANNER_CHAT_ENVELOPE_CHARS = 1_024

function plannerSha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function plannerIsSplitPart(part: CompactionPlannerPart): part is CompactionPlannerSplitTextPart {
  return part.type === "text" && "split" in part
}

// Complete user-turn boundaries: every user message opens a turn; a turn runs
// to the next user message or the end of the transcript.
function plannerTurns(messages: readonly SessionV1.WithParts[]): Array<{ readonly start: number; readonly end: number }> {
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) if (messages[i].info.role === "user") starts.push(i)
  const turns: Array<{ readonly start: number; readonly end: number }> = []
  for (let i = 0; i < starts.length; i++)
    turns.push({ start: starts[i], end: i + 1 < starts.length ? starts[i + 1] : messages.length })
  return turns
}

// Chunk projection of a part: deterministic media placeholders and the
// historical tool output cap. Pure — durable parts are never mutated.
function plannerProjectPart(part: SessionV1.Part): CompactionPlannerPart[] {
  if (part.type === "file" && (isMedia(part.mime) || part.url.startsWith("data:"))) {
    return [
      {
        id: part.id,
        sessionID: part.sessionID,
        messageID: part.messageID,
        type: "text",
        text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
      },
    ]
  }
  if (part.type === "tool" && part.state.status === "completed" && part.state.output.length > TOOL_OUTPUT_MAX_CHARS) {
    return [{ ...part, state: { ...part.state, output: part.state.output.slice(0, TOOL_OUTPUT_MAX_CHARS) } }]
  }
  return [part]
}

function plannerProjectMessage(message: SessionV1.WithParts): CompactionPlannerWithParts {
  const parts: CompactionPlannerPart[] = []
  for (const part of message.parts) {
    if (part.type === "compaction") continue // control marker, not model-visible content
    parts.push(...plannerProjectPart(part))
  }
  return { info: { ...message.info }, parts }
}

// Data-only chat projection of one projected message: only fields that affect
// the serialized model-visible payload (no functions, no raw binary).
function plannerChatMessage(message: CompactionPlannerWithParts): CompactionPlannerChatMessage {
  const content: CompactionPlannerChatContent[] = message.parts.map((part): CompactionPlannerChatContent => {
    switch (part.type) {
      case "text":
        return plannerIsSplitPart(part)
          ? { type: "text", text: part.text, split: { index: part.split.index, role: part.split.role, total: part.split.total } }
          : { type: "text", text: part.text }
      case "reasoning":
        return { type: "reasoning", text: part.text }
      case "file":
        return {
          type: "file",
          mime: part.mime,
          filename: part.filename ?? "file",
          url: part.url.startsWith("data:") ? undefined : part.url,
        }
      case "tool":
        return {
          type: "tool",
          tool: part.tool,
          callID: part.callID,
          status: part.state.status,
          output: part.state.status === "completed" ? part.state.output : undefined,
          error: part.state.status === "error" ? part.state.error : undefined,
        }
      default:
        return { type: part.type }
    }
  })
  return { role: message.info.role, content }
}

function plannerRequest(
  chunkChat: readonly CompactionPlannerChatMessage[],
  latestChat: readonly CompactionPlannerChatMessage[],
  promptText: string,
  chunkIndex: number,
): CompactionPlannerRequest {
  return {
    phase: PLANNER_PHASE,
    summaryOutputTokens: PLANNER_SUMMARY_OUTPUT_TOKENS,
    summaryReserveChars: PLANNER_SUMMARY_RESERVE_CHARS,
    chunkIndex,
    messages: [
      ...chunkChat,
      ...latestChat,
      { role: "user", content: [{ type: "text", text: promptText + "\n" + PLANNER_RESERVE_MARKER }] },
    ],
  }
}

// Splits one turn that cannot fit a chunk alone. Only individually oversized
// text parts are split; each piece rides its own single-part slot message
// (deterministic `#split` ids) so pieces can pack into separate budget-checked
// chunks. Non-oversized parts keep their own slot. Order and role are
// preserved.
function plannerSplitTurn(
  turn: CompactionPlannerWithParts[],
  pieceLimit: number,
  verify: (unit: readonly CompactionPlannerWithParts[]) => void,
): CompactionPlannerWithParts[][] {
  const units: CompactionPlannerWithParts[][] = []
  for (const message of turn) {
    if (!message.parts.some((part) => part.type === "text" && part.text.length > pieceLimit)) {
      units.push([message])
      continue
    }
    let slotIndex = 0
    const slotInfo = (index: number): SessionV1.Info =>
      index === 0 ? { ...message.info } : { ...message.info, id: MessageID.make(message.info.id + "#split" + String(index)) }
    const pushSlot = (parts: CompactionPlannerPart[]): void => {
      const slot: CompactionPlannerWithParts = { info: slotInfo(slotIndex), parts }
      slotIndex += 1
      verify([slot])
      units.push([slot])
    }
    for (const part of message.parts) {
      if (part.type === "text" && part.text.length > pieceLimit) {
        const count = Math.max(1, Math.ceil(part.text.length / pieceLimit))
        for (let piece = 0; piece < count; piece++) {
          const info = slotInfo(slotIndex)
          pushSlot([
            {
              ...part,
              id: piece === 0 ? part.id : PartID.make(part.id + "#split" + String(piece)),
              messageID: info.id,
              text: part.text.slice(piece * pieceLimit, Math.min(part.text.length, (piece + 1) * pieceLimit)),
              split: { role: message.info.role, index: piece, total: count },
            },
          ])
        }
      } else {
        const info = slotInfo(slotIndex)
        pushSlot([{ ...part, messageID: info.id }])
      }
    }
  }
  return units
}

function plannerSplitOversized(input: {
  message: SessionV1.WithParts
  partIndex: number
  limitChars: number
}): { leading: Record<string, unknown>; trailing: Record<string, unknown> } | undefined {
  const part = input.message.parts[input.partIndex]
  if (part === undefined || part.type !== "text") return undefined
  if (part.text.length <= input.limitChars) return undefined
  const role = input.message.info.role
  return {
    leading: { type: "text", text: part.text.slice(0, input.limitChars), split: { role, index: 0, total: 2 } },
    trailing: { type: "text", text: part.text.slice(input.limitChars), split: { role, index: 1, total: 2 } },
  }
}

function plannerPlan(input: CompactionPlannerInput): CompactionPlannerPlan {
  const { messages, model, cfg } = input
  const seed = input.requestHash ?? ""
  const route = { providerID: model.providerID, modelID: model.id }

  // Compaction-phase route budget with the 4,096 summary output allowance (QCB-003).
  const evaluation = ContextBudget.evaluate({
    model,
    cfg,
    estimate: 0,
    phase: PLANNER_PHASE,
    outputTokens: PLANNER_SUMMARY_OUTPUT_TOKENS,
  })
  const budget = evaluation.budget
  const reserveTokens = Math.ceil(PLANNER_SUMMARY_RESERVE_CHARS / 4)

  const fail = (
    reason: "fixed-overhead" | "latest-turn-too-large" | "chunk-limit",
    detail: { estimate?: number; chunkCount: number },
  ): never => {
    throw new CompactionImpossibleError({
      reason,
      phase: PLANNER_PHASE,
      route,
      estimate: detail.estimate,
      budget,
      contextLimit: model.limit.context,
      inputLimit: model.limit.input,
      outputAllowance: evaluation.outputAllowance,
      chunkCount: detail.chunkCount,
      requestHash: input.requestHash,
    })
  }

  // The latest user turn (user through the end of the transcript) rides intact
  // and outside every chunk. Tail settings are maxima, never requirements: the
  // planner never keeps more turns verbatim than the tail maximum allows.
  const groups = plannerTurns(messages)
  const last = groups.length > 0 ? groups[groups.length - 1] : undefined
  const latestTurn: SessionV1.WithParts[] = last === undefined ? [] : messages.slice(last.start, last.end)
  const oldGroups = groups.length > 0 ? groups.slice(0, -1) : [{ start: 0, end: messages.length }]

  const latestChat = latestTurn.map(plannerChatMessage)
  // Fixed transformed compaction overhead: the deterministic compaction prompt
  // (no prior summary) plus its message wrapper, measured by the same
  // projection that measures everything else.
  const promptText = buildPrompt({ context: [] })
  const estimateRequest = (request: CompactionPlannerRequest): number => ContextBudget.estimate(request) + reserveTokens
  const requestFor = (chunkChat: readonly CompactionPlannerChatMessage[], chunkIndex: number): CompactionPlannerRequest =>
    plannerRequest(chunkChat, latestChat, promptText, chunkIndex)

  // Pre-call gates, evaluated before any chunk planning, counting the
  // worst-case prior rolling summary reserve. The fixed overhead is measured
  // without any history content: only the skeleton, prompt wrapper, and reserve.
  const overheadEstimate = estimateRequest(plannerRequest([], [], promptText, -1))
  if (overheadEstimate > budget) fail("fixed-overhead", { estimate: overheadEstimate, chunkCount: 0 })
  const latestRequest = requestFor(latestChat, -1)
  const latestEstimate = estimateRequest(latestRequest)
  if (latestEstimate > budget) fail("latest-turn-too-large", { estimate: latestEstimate, chunkCount: 0 })

  // Baseline of every proposed request (skeleton + latest tail + prompt +
  // reserve); the piece limit is the largest text that still fits a chunk
  // alone, worst case.
  const pieceLimitChars = Number.isFinite(budget)
    ? Math.floor(4 * (budget - latestEstimate)) - PLANNER_CHAT_ENVELOPE_CHARS
    : Number.MAX_SAFE_INTEGER
  if (pieceLimitChars < 1) fail("chunk-limit", { chunkCount: PLANNER_MAX_CHUNK_COUNT })

  const verifyUnit = (unit: readonly CompactionPlannerWithParts[]): void => {
    if (estimateRequest(requestFor(unit.map(plannerChatMessage), 0)) > budget)
      fail("chunk-limit", { chunkCount: PLANNER_MAX_CHUNK_COUNT })
  }

  const units: CompactionPlannerWithParts[][] = []
  for (const group of oldGroups) {
    const projected = messages.slice(group.start, group.end).map(plannerProjectMessage)
    if (projected.length === 0) continue
    if (estimateRequest(requestFor(projected.map(plannerChatMessage), 0)) <= budget) {
      units.push(projected)
      continue
    }
    // A single turn that does not fit even alone: split its oversized text
    // parts (the only splitting the bounded planner permits).
    units.push(...plannerSplitTurn(projected, pieceLimitChars, verifyUnit))
  }

  const chunks: CompactionPlannerWithParts[][] = []
  let current: CompactionPlannerWithParts[] = []
  const flush = (): void => {
    if (current.length > 0) chunks.push(current)
    current = []
  }
  for (const unit of units) {
    if (current.length === 0) {
      verifyUnit(unit)
      current = [...unit]
      continue
    }
    if (estimateRequest(requestFor([...current, ...unit].map(plannerChatMessage), chunks.length)) <= budget) {
      current.push(...unit)
      continue
    }
    flush()
    current = [...unit]
  }
  flush()
  if (chunks.length > PLANNER_MAX_CHUNK_COUNT) fail("chunk-limit", { chunkCount: chunks.length })

  const chunkList = chunks.map((item, index) => ({ index, messages: item }))
  const proposals = chunkList.map((chunk) => {
    const request = requestFor(chunk.messages.map(plannerChatMessage), chunk.index)
    const requestEstimate = estimateRequest(request)
    const requestHash = plannerSha256Hex(seed + "\n" + ContextBudget.canonicalSerialize(request))
    const admitted = ContextBudget.evaluate({
      model,
      cfg,
      estimate: requestEstimate,
      phase: PLANNER_PHASE,
      outputTokens: PLANNER_SUMMARY_OUTPUT_TOKENS,
      requestHash,
      chunkCount: chunks.length,
    }).admitted
    return { chunk, request, requestEstimate, requestHash, admitted }
  })
  return { chunks: chunkList, latestTurn, proposals }
}

export const CompactionPlanner = {
  SUMMARY_RESERVE_CHARS: PLANNER_SUMMARY_RESERVE_CHARS,
  SUMMARY_OUTPUT_TOKENS: PLANNER_SUMMARY_OUTPUT_TOKENS,
  MAX_CHUNK_COUNT: PLANNER_MAX_CHUNK_COUNT,
  TOOL_OUTPUT_MAX_CHARS,
  plan: plannerPlan,
  splitOversized: plannerSplitOversized,
}

// ─── T05 — Bounded rolling-summary execution ─────────────────────────────────
//
// CompactionExecutor runs a T03 plan against a caller-supplied summarizer:
// one call per chunk (1..4), each request = prior rolling summary + next
// chunk + the latest intact turn. Every request is re-admitted through
// ContextBudget before its call (the actual prior rolling text is
// materialized, not merely reserved), and the pinned 4,096-token rolling
// summary reserve bounds mid-execution growth: once the prior summary
// outgrows it, no later chunk can ever fit, so execution stops before the
// next call. The final projection must reduce (E_after < E_before) and fit
// (E_after <= B) before persist runs — exactly once, on completion. All
// intermediate state stays in memory; nothing is durable until persist.

export type CompactionExecutorRequest = {
  readonly previousSummary?: string
  readonly chunk: CompactionPlannerChunk
  readonly latestTurn: readonly SessionV1.WithParts[]
}

export type CompactionExecutorResult = {
  readonly status: "completed" | "mid-execution-over-budget" | "no-reduction" | "post-compaction-over-budget"
  readonly summary?: string
  readonly calls: number
  readonly admissions: readonly { readonly estimate: number; readonly budget: number; readonly admitted: boolean }[]
  readonly before: { readonly estimate: number; readonly budget: number }
  readonly after?: { readonly estimate: number; readonly budget: number }
  readonly persisted: boolean
}

export const CompactionExecutor = {
  run: Effect.fn("SessionCompaction.CompactionExecutor.run")(function* (input: {
    readonly plan: CompactionPlannerPlan
    readonly model: Provider.Model
    readonly cfg: ConfigV1.Info
    readonly previousSummary?: string
    readonly summarize: (request: CompactionExecutorRequest) => Effect.Effect<{ readonly text: string }>
    readonly persist?: (result: CompactionExecutorResult) => Effect.Effect<void>
    readonly signal?: AbortSignal
  }) {
    const { plan, model, cfg } = input
    if (input.signal?.aborted) return yield* Effect.fail(new Error("Compaction execution aborted"))

    const budget = ContextBudget.evaluate({
      model,
      cfg,
      estimate: 0,
      phase: PLANNER_PHASE,
      outputTokens: PLANNER_SUMMARY_OUTPUT_TOKENS,
    }).budget
    const latestChat = plan.latestTurn.map(plannerProjectMessage).map(plannerChatMessage)
    // Pre-compaction state estimate: every planned chunk plus the latest
    // intact turn, projected without the prompt.
    const beforeEstimate = ContextBudget.estimate({
      messages: [...plan.chunks.flatMap((chunk) => chunk.messages).map(plannerProjectMessage).map(plannerChatMessage), ...latestChat],
    })
    const before = { estimate: beforeEstimate, budget }

    let rolling = input.previousSummary
    let calls = 0
    const admissions: { estimate: number; budget: number; admitted: boolean }[] = []

    for (const chunk of plan.chunks) {
      // Pinned rolling reserve: once the prior summary outgrows the 4,096
      // summary-token allowance, stop before the next call — a later chunk
      // can never be admitted.
      if (calls > 0 && rolling !== undefined && Token.estimate(rolling) > PLANNER_SUMMARY_OUTPUT_TOKENS)
        return { status: "mid-execution-over-budget", calls, admissions, before, persisted: false }
      if (input.signal?.aborted) return yield* Effect.fail(new Error("Compaction execution aborted"))

      const request: CompactionExecutorRequest = {
        ...(rolling === undefined ? {} : { previousSummary: rolling }),
        chunk,
        latestTurn: plan.latestTurn,
      }
      // Fresh admission of the actual request projection: fixed overhead,
      // latest tail, and the materialized prior rolling summary plus the
      // worst-case reserve marker.
      const projection = {
        phase: PLANNER_PHASE,
        summaryOutputTokens: PLANNER_SUMMARY_OUTPUT_TOKENS,
        summaryReserveChars: PLANNER_SUMMARY_RESERVE_CHARS,
        chunkIndex: chunk.index,
        messages: [
          ...chunk.messages.map(plannerProjectMessage).map(plannerChatMessage),
          ...latestChat,
          {
            role: "user",
            content: [{ type: "text", text: buildPrompt({ previousSummary: rolling, context: [] }) + "\n" + PLANNER_RESERVE_MARKER }],
          },
        ],
      }
      const estimate = ContextBudget.estimate(projection)
      const admitted = ContextBudget.evaluate({
        model,
        cfg,
        estimate,
        phase: PLANNER_PHASE,
        outputTokens: PLANNER_SUMMARY_OUTPUT_TOKENS,
      }).admitted
      admissions.push({ estimate, budget, admitted })
      if (!admitted) return { status: "mid-execution-over-budget", calls, admissions, before, persisted: false }

      calls += 1
      rolling = (yield* input.summarize(request)).text
    }

    // Post-compaction state estimate: the anchored rolling summary replaces
    // every planned chunk; the latest turn remains intact, without the prompt.
    const summary = rolling ?? ""
    const afterEstimate = ContextBudget.estimate({
      messages: [{ role: "assistant", content: [{ type: "text", text: summary }] }, ...latestChat],
    })
    const after = { estimate: afterEstimate, budget }
    if (afterEstimate >= beforeEstimate)
      return { status: "no-reduction", summary, calls, admissions, before, after, persisted: false }
    if (afterEstimate > budget)
      return { status: "post-compaction-over-budget", summary, calls, admissions, before, after, persisted: false }

    const result: CompactionExecutorResult = { status: "completed", summary, calls, admissions, before, after, persisted: true }
    if (input.persist) yield* input.persist(result)
    return result
  }),
}
