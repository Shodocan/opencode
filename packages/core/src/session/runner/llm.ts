import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionRunnerFallback } from "./fallback" // FORK FEATURE (6) fallback-model
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }
      // FORK FEATURE (6) fallback-model: retry the turn on the next model in the
      // agent's fallback chain after a retriable failure. Carries the new model,
      // the cumulative tried-set, and the combined transition budget. See fallback.ts.
      | {
          readonly _tag: "ContinueWithFallbackModel"
          readonly step: number
          readonly model: ModelV2.Ref
          readonly tried: ReadonlySet<string>
          readonly transitions: number
          readonly takeover: FallbackTakeover
        }
      | {
          readonly _tag: "ContinueRetrySameModel"
          readonly step: number
          readonly model: ModelV2.Ref | undefined
          readonly tried: ReadonlySet<string> | undefined
          readonly transitions: number
          readonly attempts: number
        }

    type FallbackTakeover = {
      readonly from: ModelV2.Ref
      readonly reason: ReturnType<typeof SessionRunnerFallback.reasonForFailure>
      readonly attempts: ReturnType<typeof SessionRunnerFallback.attemptsForFailure>
    }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })
    // FORK FEATURE (6) fallback-model
    const continueWithFallbackModel = (
      step: number,
      model: ModelV2.Ref,
      tried: ReadonlySet<string>,
      transitions: number,
      takeover: FallbackTakeover,
    ) => new TurnTransitionError({ _tag: "ContinueWithFallbackModel", step, model, tried, transitions, takeover })
    const continueRetrySameModel = (
      step: number,
      model: ModelV2.Ref | undefined,
      tried: ReadonlySet<string> | undefined,
      transitions: number,
      attempts: number,
    ) => new TurnTransitionError({ _tag: "ContinueRetrySameModel", step, model, tried, transitions, attempts })

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
      // FORK FEATURE (6) fallback-model: ambient model override + cumulative tried-set
      // + combined transition budget, threaded through the turn-transition re-runs.
      modelOverride?: ModelV2.Ref,
      tried?: ReadonlySet<string>,
      transitions: number = 0,
      attempts: number = 1,
      takeover?: FallbackTakeover,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      // FORK FEATURE (6): resolve the fallback model when an override is active.
      const model = yield* models.resolve(modelOverride ? { ...session, model: modelOverride } : session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      // FORK FEATURE (6): report the active model's variant (override or session).
      const activeVariant = (modelOverride ?? session.model)?.variant
      const activeModelRef = {
        id: ModelV2.ID.make(model.id),
        providerID: ProviderV2.ID.make(model.provider),
        ...(activeVariant === undefined ? {} : { variant: activeVariant }),
      }
      const modelLog = (ref: ModelV2.Ref | undefined) => ({ provider: ref?.providerID, model: ref?.id })
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(activeVariant === undefined ? {} : { variant: activeVariant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      let takeoverPublished = false
      let takeoverCancelled = false
      const isFallbackCommitEvent = (event: LLMEvent) =>
        event.type === "text-start" ||
        event.type === "reasoning-start" ||
        event.type === "tool-input-start" ||
        event.type === "tool-call"
      const publishTakeover = Effect.fnUntraced(function* (event: LLMEvent) {
        if (!takeover || takeoverPublished || takeoverCancelled || !isFallbackCommitEvent(event)) return
        const active = yield* getSession(session.id)
        if (active.model && SessionRunnerFallback.keyOfRef(active.model) !== SessionRunnerFallback.keyOfRef(takeover.from)) {
          takeoverCancelled = true
          return
        }
        const activeModel = modelOverride ?? session.model ?? activeModelRef
        if (!activeModel) return
        takeoverPublished = true
        yield* Effect.logInfo("fallback takeover", {
          event_type: "fallback.takeover",
          session: session.id,
          fallback: {
            event: "fallback.takeover",
            from: modelLog(takeover.from),
            to: modelLog(activeModel),
            reason: takeover.reason.category,
            attempts: {
              total: takeover.attempts.total,
              lower_level: takeover.attempts.lowerLevel,
              runner_level: takeover.attempts.runnerLevel,
            },
          },
        })
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: session.id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: activeModel,
          source: "fallback",
          from: takeover.from,
          reason: takeover.reason,
          attempts: takeover.attempts,
        })
      })
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publishTakeover(event).pipe(Effect.andThen(publisher.publish(event, outputPaths))))
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          // FORK FEATURE (6) fallback-model (H7): before surfacing the failure, try the
          // next model in the agent's fallback chain. Skip on user-abort (composite
          // interrupt cause), once output has started, when a provider error was already
          // published mid-stream (e.g. non-overflow overload), or past the combined
          // transition budget. shouldFallback (inside nextFallbackModel) gates eligibility.
          // The TERMINAL stream error drives fallback eligibility; the captured
          // mid-stream overflow event is only the failure when the stream itself did
          // not fail (otherwise an overflow warning would mask a fatal terminal error,
          // since shouldFallback always accepts overflow).
          const fallbackFailure = failure ?? overflowFailure
          const interrupted = stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)
          if (
            fallbackFailure &&
            !interrupted &&
            !publisher.hasAssistantStarted() &&
            !publisher.hasProviderError() &&
            transitions < SessionRunnerFallback.MAX_TURN_TRANSITIONS
          ) {
            const currentRef = modelOverride ?? session.model ?? activeModelRef
            const triedNext = new Set<string>([
              ...(tried ?? []),
              ...(currentRef ? [SessionRunnerFallback.keyOfRef(currentRef)] : []),
            ])
            const nextModel = SessionRunnerFallback.nextFallbackModel(agent.info, fallbackFailure, triedNext)
            if (SessionRunnerFallback.isTimeoutOnlyFailure(fallbackFailure))
              yield* Effect.logInfo("fallback timeout blocked", {
                event_type: "fallback.timeout_blocked",
                session: session.id,
                fallback: {
                  event: "fallback.timeout_blocked",
                  from: modelLog(currentRef),
                  reason: "timeout",
                  eligible: false,
                  timeout_blocked: true,
                },
              })
            if (nextModel) {
              const failureAttempts = SessionRunnerFallback.attemptsForFailure(fallbackFailure, attempts)
              if (!SessionRunnerFallback.hasMinimumAttemptsForFallback(failureAttempts.total))
                yield* Effect.logInfo("fallback attempt failed", {
                  event_type: "fallback.attempt_failed",
                  session: session.id,
                  fallback: {
                    event: "fallback.attempt_failed",
                    from: modelLog(currentRef),
                    to: modelLog(nextModel),
                    reason: SessionRunnerFallback.reasonForFailure(fallbackFailure).category,
                    attempts: {
                      total: failureAttempts.total,
                      lower_level: failureAttempts.lowerLevel,
                      runner_level: failureAttempts.runnerLevel,
                    },
                    eligible: true,
                    timeout_blocked: false,
                  },
                })
              if (!SessionRunnerFallback.hasMinimumAttemptsForFallback(failureAttempts.total))
                return yield* Effect.die(
                  continueRetrySameModel(currentStep, modelOverride, tried, transitions + 1, attempts + 1),
                )
              if (currentRef)
                return yield* Effect.die(
                  continueWithFallbackModel(currentStep, nextModel, triedNext, transitions + 1, {
                    from: currentRef,
                    reason: SessionRunnerFallback.reasonForFailure(fallbackFailure),
                    attempts: failureAttempts,
                  }),
                )
            }
            if (!nextModel && agent.info?.fallback?.length && SessionRunnerFallback.shouldFallback(fallbackFailure))
              yield* Effect.logInfo("fallback exhausted", {
                event_type: "fallback.exhausted",
                session: session.id,
                fallback: {
                  event: "fallback.exhausted",
                  from: modelLog(currentRef),
                  reason: SessionRunnerFallback.reasonForFailure(fallbackFailure).category,
                  tried_chain: [...triedNext].join(","),
                  exhausted: true,
                },
              })
          }
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      // FORK FEATURE (6) fallback-model: ambient override + tried-set + budget.
      modelOverride?: ModelV2.Ref,
      tried?: ReadonlySet<string>,
      transitions?: number,
      attempts?: number,
      takeover?: FallbackTakeover,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (
      sessionID,
      promotion,
      step,
      modelOverride,
      tried,
      transitions = 0,
      attempts = 1,
      takeover,
    ) {
      return yield* runTurnAttempt(sessionID, promotion, step, undefined, modelOverride, tried, transitions, attempts, takeover).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            // FORK FEATURE (6): a fallback re-run routes back through runTurn so the
            // new model gets a fresh overflow-recovery budget.
            if (defect.transition._tag === "ContinueWithFallbackModel") {
              yield* Effect.yieldNow
              return yield* runTurn(
                sessionID,
                undefined,
                defect.transition.step,
                defect.transition.model,
                defect.transition.tried,
                defect.transition.transitions,
                1,
                defect.transition.takeover,
              )
            }
            if (defect.transition._tag === "ContinueRetrySameModel") {
              yield* Effect.yieldNow
              return yield* runTurn(
                sessionID,
                undefined,
                defect.transition.step,
                defect.transition.model,
                defect.transition.tried,
                defect.transition.transitions,
                defect.transition.attempts,
                takeover,
              )
            }
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            // Re-thread the ambient fallback override across compaction (anti-ping-pong).
            return yield* runAfterOverflowCompaction(
              sessionID,
              undefined,
              defect.transition.step,
              modelOverride,
              tried,
              transitions + 1,
              attempts,
              takeover,
            )
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (
      sessionID,
      promotion,
      step,
      modelOverride,
      tried,
      transitions = 0,
      attempts = 1,
      takeover,
    ) {
      return yield* runTurnAttempt(
        sessionID,
        promotion,
        step,
        compaction.compactAfterOverflow,
        modelOverride,
        tried,
        transitions,
        attempts,
        takeover,
      ).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            // FORK FEATURE (6): retry on the next fallback model (its transition
            // already carries the incremented tried-set + budget).
            if (defect.transition._tag === "ContinueWithFallbackModel")
              return yield* runTurn(
                sessionID,
                undefined,
                defect.transition.step,
                defect.transition.model,
                defect.transition.tried,
                defect.transition.transitions,
                1,
                defect.transition.takeover,
              )
            if (defect.transition._tag === "ContinueRetrySameModel")
              return yield* runTurn(
                sessionID,
                undefined,
                defect.transition.step,
                defect.transition.model,
                defect.transition.tried,
                defect.transition.transitions,
                defect.transition.attempts,
                takeover,
              )
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(
                sessionID,
                undefined,
                defect.transition.step,
                modelOverride,
                tried,
                transitions + 1,
                attempts,
                takeover,
              )
            return yield* runTurn(
              sessionID,
              undefined,
              defect.transition.step,
              modelOverride,
              tried,
              transitions + 1,
              attempts,
              takeover,
            )
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    })

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
  ],
})
