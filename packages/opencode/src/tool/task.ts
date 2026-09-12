import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionRetry } from "@/session/retry"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { NotFoundError } from "@/storage/storage"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Plugin } from "@/plugin"
import { RequestExecutor } from "@opencode-ai/llm/route"

export interface TaskPromptOps {
  cancel(sessionID: SessionID, options?: { excludeJobID: string }): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.InternalPromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  model: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      providerID: Schema.String,
      variant: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Exact provider/model/variant override. Omitted variant does not inherit defaults." }),
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const plugin = yield* Plugin.Service
    const provider = yield* Provider.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (ctx.abort.aborted) return yield* Effect.interrupt
      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const cfg = yield* config.get()
      const explicit = params.model
      if (explicit) {
        if (
          !explicit.id.trim() ||
          !explicit.providerID.trim() ||
          (explicit.variant !== undefined && !explicit.variant.trim())
        ) {
          return yield* Effect.fail(new Error("Invalid explicit task model tuple"))
        }
        const supported = yield* provider.getModel(
          ProviderV2.ID.make(explicit.providerID),
          ModelV2.ID.make(explicit.id),
        )
        if (explicit.variant !== undefined && !Object.hasOwn(supported.variants ?? {}, explicit.variant)) {
          return yield* Effect.fail(new Error("Unsupported explicit task model variant"))
        }
      }
      // The runtime call ID identifies this invocation; never synthesize one.
      const taskCallID = ctx.callID?.trim()
      if (!taskCallID) return yield* Effect.fail(new Error("TaskTool requires a nonblank host callID"))
      const taskOrigin: Tool.TaskOrigin = {
        version: 1,
        parentSessionID: ctx.sessionID,
        taskCallID,
      }
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions
            .get(SessionID.make(params.task_id))
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        : undefined
      if (session && session.parentID !== ctx.sessionID) {
        return yield* Effect.fail(new Error("TaskTool task_id must name a direct child of the calling session"))
      }
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.createTaskChild({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
          metadata: {
            "opencode.task.origin": {
              version: 1,
              parentSessionID: ctx.sessionID,
              tool: id,
              callID: taskCallID,
            },
          },
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = explicit
        ? { modelID: ModelV2.ID.make(explicit.id), providerID: ProviderV2.ID.make(explicit.providerID) }
        : (next.model ?? {
            modelID: msg.info.modelID,
            providerID: msg.info.providerID,
          })
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
        taskExecution: { started: false, localQuiescence: true },
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const configured =
        !explicit && next.model && next.variant
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const selectedVariant = explicit
        ? explicit.variant
        : next.model
          ? next.variant && configured?.variants?.[next.variant]
            ? next.variant
            : undefined
          : variant
      const invocation = {
        sessionID: ctx.sessionID,
        callID: taskCallID,
        childSessionID: nextSession.id,
        model: {
          providerID: model.providerID,
          id: model.modelID,
          ...(selectedVariant !== undefined ? { variant: selectedVariant } : {}),
        },
        args: params,
      }
      const registration = yield* runState.registerTask(nextSession.id)
      // A provider stream closes its AbortSignal after a successful parent turn.
      // Once Task returns background ownership, only native task/session
      // cancellation may stop that work; startup and foreground still follow
      // the calling stream's lifetime.
      const lifetime = { background: false }
      const aborted = () => registration.signal.aborted || (!lifetime.background && ctx.abort.aborted)
      const admission = yield* plugin
        .trigger("task.execute.start", invocation, { managedRetry: false })
        .pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? registration.release : Effect.void)))

      const execution: {
        remoteOutcome: "completed" | "unknown"
        failure?: NonNullable<Session.TaskTerminal["executionFailure"]>
      } = { remoteOutcome: "unknown" }

      const terminal = (exit: Exit.Exit<string, unknown>) =>
        Effect.gen(function* () {
          // A prompt waits on a separately scoped session runner. Stop that runner
          // and its descendants, excluding this Task's own background container.
          yield* ops.cancel(nextSession.id, { excludeJobID: nextSession.id })
          const cause = Exit.isFailure(exit) ? exit.cause : undefined
          const cancelled = aborted() || (cause !== undefined && Cause.hasInterrupts(cause))
          if (cause && !cancelled && !execution.failure) {
            const error = Cause.squash(cause)
            execution.failure = {
              kind: "tool",
              error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            }
          }
          const outcome = {
            status: cancelled
              ? ("cancelled" as const)
              : Exit.isSuccess(exit)
                ? ("completed" as const)
                : ("failed" as const),
            localQuiescence: true as const,
            remoteOutcome: execution.remoteOutcome,
            ...(execution.failure ? { executionFailure: execution.failure } : {}),
          }
          metadata.taskExecution.localQuiescence = true
          yield* sessions.setTaskTerminal({
            version: 1,
            parentSessionID: ctx.sessionID,
            callID: taskCallID,
            childSessionID: nextSession.id,
            model: invocation.model,
            completedAt: Date.now(),
            ...outcome,
          })
          yield* ctx.metadata({ title: params.description, metadata: { ...metadata, ...outcome } })
          yield* plugin.trigger("task.execute.end", invocation, {
            ...outcome,
            ...(Exit.isSuccess(exit) ? { output: exit.value } : {}),
          })
        }).pipe(Effect.ensuring(registration.release))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        if (aborted()) return yield* Effect.interrupt
        metadata.taskExecution.started = true
        metadata.taskExecution.localQuiescence = false
        yield* ctx.metadata({ title: params.description, metadata })
        const parts = yield* ops.resolvePromptParts(params.prompt)
        if (aborted()) return yield* Effect.interrupt
        const prompt = ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: selectedVariant,
          taskModelExact: true,
          agent: next.name,
          taskOrigin,
          parts,
        })
        const result = yield* admission.managedRetry === true
          ? prompt.pipe(
              Effect.provideService(SessionRetry.RetryLimit, 0),
              Effect.provideService(RequestExecutor.RetryLimit, 0),
            )
          : prompt
        // Session cancellation can resolve prompt with its last message. That
        // local return does not prove the pending provider request completed.
        if (aborted()) return yield* Effect.interrupt
        execution.remoteOutcome = "completed"
        if (result.info.role === "assistant" && result.info.error) {
          const error = result.info.error
          if (error.name === "MessageAbortedError") {
            execution.remoteOutcome = "unknown"
            execution.failure = { kind: "tool", error }
            return yield* Effect.interrupt
          }
          const local = error.name === "UnknownError" || error.name === "StructuredOutputError"
          execution.failure = { kind: local ? "tool" : "provider", error }
          if (error.name === "APIError" && error.data.quotaReplaySuppressed)
            execution.failure = { kind: "provider", error, quotaReplaySuppressed: true }
          if (error.name === "APIError" && !error.data.quotaReplaySuppressed && error.data.hardQuota)
            execution.failure = { kind: "provider", error, hardQuota: error.data.hardQuota }
          if (error.name === "APIError") {
            const code = error.data.statusCode
            if (code === undefined || code < 100 || code > 599) execution.remoteOutcome = "unknown"
          } else {
            execution.remoteOutcome = "unknown"
          }
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          execution.failure = { kind: "tool", error: failed.state.error }
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      // An abort during the awaited binding still receives a durable receipt,
      // but never enters the scheduler or invokes a provider.
      if (aborted()) return yield* Effect.interrupt.pipe(Effect.onExit((exit) => terminal(exit)))

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID, quiescent: true }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask(), onExit: terminal })) {
        lifetime.background = true
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      // Mask acquisition and install cleanup before a started child can outlive
      // an interrupted caller. Background ownership transfers only on success.
      return yield* Effect.acquireUseRelease(
        background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          onPromote: Effect.all([
            ctx.metadata({
              title: params.description,
              metadata: { ...metadata, background: true, jobId: nextSession.id },
            }),
            notify(nextSession.id),
          ]),
          run: runTask().pipe(Effect.onExit(terminal)),
        }),
        (info) =>
          Effect.gen(function* () {
            function backgroundResult() {
              return {
                title: params.description,
                metadata: { ...metadata, background: true, jobId: info.id },
                output: renderOutput({
                  sessionID: nextSession.id,
                  state: "running",
                  summary: "Background task started",
                  text: BACKGROUND_STARTED,
                }),
              }
            }

            if (runInBackground) {
              yield* notify(info.id)
              return backgroundResult()
            }

            const runCancel = yield* EffectBridge.make()
            const onAbort = () => runCancel.fork(ops.cancel(nextSession.id))
            return yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                ctx.abort.addEventListener("abort", onAbort)
                if (ctx.abort.aborted) onAbort()
              }),
              () => Effect.gen(function* () {
                const result = yield* Effect.raceFirst(
                  background.wait({ id: nextSession.id, quiescent: true }).pipe(Effect.map((waited) => waited.info)),
                  background.waitForPromotion(nextSession.id),
                )
                if (result?.metadata?.background === true) return backgroundResult()
                if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
                if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
                return {
                  title: params.description,
                  metadata,
                  output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
                }
              }),
              () => Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort)),
            )
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.isSuccess(exit)) {
              lifetime.background = exit.value.metadata.background === true
              return
            }
            yield* Effect.all([
              ops.cancel(nextSession.id),
              background.cancel(nextSession.id, { quiescent: true }),
            ], { discard: true })
          }),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      prepare: (ctx: Tool.Context) =>
        ctx.metadata({
          metadata: { taskExecution: { started: false, localQuiescence: true } },
        }),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
