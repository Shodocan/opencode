import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Gates } from "../agent/gates"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

// FORK FEATURE (10) gates — metadata emitted by the task tool. `blocked`/`gate`/
// `agent` are present only on a gate-blocked dispatch (see Gates.renderBlocked);
// `background`/`jobId` only on background dispatches. Declared as a shared type so
// downstream callers and tests can branch on `metadata.blocked` uniformly.
// `sessionId` is the spawned child session id; on a blocked dispatch no session is
// created and it is set to `undefined` cast to the branded type (callers must check
// `blocked` before interpreting `sessionId`).
export interface TaskMetadata {
  parentSessionId: SessionID
  sessionId: SessionID
  model: { modelID: string | undefined; providerID: string | undefined; variant?: string }
  modelSource: "caller" | "caller-variant" | "agent" | "session" | "default"
  modelOverride?: {
    requested?: { providerID?: string; id?: string; variant?: string }
    applied: boolean
    warning?: string
  }
  background?: boolean
  jobId?: string
  blocked?: boolean
  gate?: string
  agent?: string
  [key: string]: unknown
}

export interface TaskSessionOriginV1 {
  version: 1
  parentSessionID: string
  tool: "task"
  callID: string
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
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  // FORK FEATURE (11) subagent-model-override — per-dispatch model override.
  // Public shape uses `id` (UC1); internal code maps to `modelID` at the boundary.
  model: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      providerID: Schema.String,
      variant: Schema.optional(Schema.String),
    }),
  ).annotate({
    description:
      "Override the model for this subagent (per-dispatch only). Shape: { id: string, providerID: string, variant?: string }. Does not change the subagent's configured model.",
  }),
  variant: Schema.optional(Schema.String).annotate({
    description: "Override only the variant/effort for this subagent. Binds to the resolved model.",
  }),
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

// FORK FEATURE (11) subagent-model-override — atomic model+variant resolver.
// Builds candidates in precedence order (caller → agent config → parent/session
// → provider default), validates each atomically (model exists + variant
// exists on that model), and falls back with a warning on invalid caller
// overrides. Never partially applies an invalid model+variant pair.
type ResolvedModel = {
  model: { modelID: string | undefined; providerID: string | undefined; variant?: string }
  modelSource: "caller" | "caller-variant" | "agent" | "session" | "default"
  modelOverride?: {
    requested?: { providerID?: string; id?: string; variant?: string }
    applied: boolean
    warning?: string
  }
}

function resolveTaskModel(input: {
  provider: Provider.Interface
  callerModel?: { id: string; providerID: string; variant?: string }
  callerVariant?: string
  agentConfig: Agent.Info
  parentModel?: { modelID: string | undefined; providerID: string | undefined }
  parentVariant?: string
}): Effect.Effect<ResolvedModel, Error> {
  return Effect.gen(function* () {
    const { provider, callerModel, callerVariant, agentConfig, parentModel, parentVariant } = input

    // UC3/UC6: agent opt-out blocks both model and variant overrides.
    if (agentConfig.disableModelOverride && (callerModel || callerVariant)) {
      return yield* Effect.fail(
        new Error(
          `Agent "${agentConfig.name}" has disableModelOverride enabled; model and variant overrides are blocked.`,
        ),
      )
    }

    // UC5: conflicting model.variant and top-level variant rejects.
    if (callerModel?.variant && callerVariant && callerModel.variant !== callerVariant) {
      return yield* Effect.fail(
        new Error(
          `Conflicting variant override: model.variant="${callerModel.variant}" vs variant="${callerVariant}". Provide one or the same value.`,
        ),
      )
    }

    const requestedVariant = callerModel?.variant ?? callerVariant
    const requestedOverride = callerModel
      ? { providerID: callerModel.providerID, id: callerModel.id, variant: requestedVariant }
      : callerVariant
        ? { variant: callerVariant }
        : undefined

    // Build candidates in precedence order.
    type Candidate = {
      model: { modelID: string; providerID: string; variant?: string }
      source: "caller" | "caller-variant" | "agent" | "session" | "default"
      isCaller: boolean
    }
    const candidates: Candidate[] = []

    // 1. Caller model override (with or without variant).
    if (callerModel) {
      candidates.push({
        model: {
          modelID: callerModel.id,
          providerID: callerModel.providerID,
          variant: requestedVariant,
        },
        source: "caller",
        isCaller: true,
      })
    }

    // 2. Caller variant-only override (binds to next valid model's modelID).
    if (!callerModel && callerVariant) {
      // Variant-only: attach to agent config model or parent model.
      if (agentConfig.model) {
        candidates.push({
          model: { ...agentConfig.model, variant: callerVariant },
          source: "caller-variant",
          isCaller: true,
        })
      } else if (parentModel?.modelID && parentModel?.providerID) {
        candidates.push({
          model: { modelID: parentModel.modelID, providerID: parentModel.providerID, variant: callerVariant },
          source: "caller-variant",
          isCaller: true,
        })
      }
    }

    // 3. Agent config model (with its configured variant).
    if (agentConfig.model) {
      const agentVariant = agentConfig.variant && agentConfig.model.modelID === agentConfig.model?.modelID
        ? agentConfig.variant
        : undefined
      candidates.push({
        model: { ...agentConfig.model, variant: agentVariant },
        source: "agent",
        isCaller: false,
      })
    }

    // 4. Parent/session model (only when agent has no pinned model).
    if (!agentConfig.model && parentModel?.modelID && parentModel?.providerID) {
      candidates.push({
        model: { modelID: parentModel.modelID, providerID: parentModel.providerID, variant: parentVariant },
        source: "session",
        isCaller: false,
      })
    }

    // Try each candidate; fall back on invalid.
    let warning: string | undefined
    for (const candidate of candidates) {
      const exit = yield* provider
        .getModel(
          candidate.model.providerID as never,
          candidate.model.modelID as never,
        )
        .pipe(Effect.exit)

      if (Exit.isFailure(exit)) {
        if (candidate.isCaller) {
          warning = `Override ${candidate.model.providerID}/${candidate.model.modelID}${candidate.model.variant ? `#${candidate.model.variant}` : ""} is invalid; fell back to ${candidate.source === "caller" ? "agent default" : "next candidate"}.`
        }
        continue
      }

      const resolved = exit.value
      // Validate variant exists on the model when specified.
      if (candidate.model.variant && candidate.model.variant !== "default") {
        const variants = resolved.variants ?? {}
        if (!(candidate.model.variant in variants)) {
          if (candidate.isCaller) {
            warning = `Variant "${candidate.model.variant}" is not valid for ${candidate.model.providerID}/${candidate.model.modelID}; fell back.`
          }
          // Strip the invalid variant and retry this model without it.
          candidates.push({
            model: { modelID: candidate.model.modelID, providerID: candidate.model.providerID, variant: undefined },
            source: candidate.source,
            isCaller: false,
          })
          continue
        }
      }

      return {
        model: {
          modelID: candidate.model.modelID,
          providerID: candidate.model.providerID,
          ...(candidate.model.variant && candidate.model.variant !== "default" ? { variant: candidate.model.variant } : {}),
        },
        modelSource: candidate.source,
        ...(requestedOverride || warning
          ? {
              modelOverride: {
                requested: requestedOverride,
                applied: candidate.isCaller,
                ...(warning ? { warning } : {}),
              },
            }
          : {}),
      }
    }

    // All candidates failed — no valid fallback.
    return yield* Effect.fail(
      new Error(
        `No valid model could be resolved for agent "${agentConfig.name}". Last candidate: ${callerModel ? callerModel.providerID + "/" + callerModel.id : "agent/session default"}.`,
      ),
    )
  })
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
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

      // Enforce the parent agent's `subagents` allow-list, if set.
      const parentAgent = yield* agent.get(ctx.agent)
      if (parentAgent?.subagents && !parentAgent.subagents.includes(params.subagent_type)) {
        return yield* Effect.fail(
          new Error(
            `Agent "${ctx.agent}" is not allowed to dispatch subagent type "${params.subagent_type}". Allowed: ${parentAgent.subagents.join(", ")}`,
          ),
        )
      }

      // Resolve a resumable child session, if a task_id was passed. Only a
      // session whose parent is THIS dispatching session is a legitimate
      // resume — anything else (no parent match, or not found) is treated as
      // a fresh dispatch so gates still evaluate (F2: a driver LLM cannot
      // "resume" its way past a gate by naming an unrelated SessionID).
      const requestedResume = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const session = requestedResume && requestedResume.parentID === ctx.sessionID ? requestedResume : undefined
      const parent = yield* sessions.get(ctx.sessionID)

      // FORK FEATURE (10) gates — workflow-agnostic dispatch enforcement.
      // Evaluated at dispatch time (after the subagents allow-list, before the
      // child session is created). Skipped ONLY on a legitimate resume (a
      // child session that belongs to this dispatching parent). A blocked
      // dispatch returns a structured BLOCKED result as the tool output (NOT a
      // hard session error) so the parent LLM can self-repair. No-op when
      // neither parent nor child carries `gates` (zero behavior change).
      if (!session) {
        // F1: evaluateGates catches its own fs errors internally and returns a
        // recoverable BLOCKED result (never throws) — the error contract the
        // harness depends on requires BLOCKED, never a hard crash the parent
        // can't self-repair from.
        const blocked = yield* Gates.evaluateGates({
          parent: { id: parent.id, directory: parent.directory },
          parentGates: parentAgent?.gates as Gates.Gates | undefined,
          childName: next.name,
          childGates: next.gates as Gates.Gates | undefined,
          prompt: params.prompt,
          priorChildren: yield* sessions.children(parent.id),
        })
        if (blocked) {
          // Return the BLOCKED result as the tool output (NOT a hard error) so
          // the parent LLM can self-repair. The metadata mirrors the success
          // path's base shape (sessionId/model are placeholders — no session is
          // created on a blocked dispatch) so the shared TaskMetadata type stays
          // uniform for downstream callers and tests. The blocked payload rides
          // in `output`; `blocked`/`gate`/`agent` mark the result as blocked.
          const blockedMetadata: TaskMetadata = {
            parentSessionId: ctx.sessionID,
            // No session is created on a blocked dispatch; cast to the branded
            // type to satisfy the shared TaskMetadata shape. Callers must check
            // `blocked` before interpreting `sessionId`.
            sessionId: undefined as unknown as SessionID,
            model: next.model ?? { modelID: undefined, providerID: undefined },
            modelSource: "agent",
            blocked: true,
            gate: blocked.gate,
            agent: blocked.agent,
          }
          return {
            title: params.description,
            metadata: blockedMetadata,
            output: Gates.renderBlocked(blocked),
          }
        }
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
        (yield* sessions.create({
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
          ...(ctx.callID !== undefined
            ? { metadata: { "opencode.task.origin": { version: 1, parentSessionID: ctx.sessionID, tool: "task", callID: ctx.callID } satisfies TaskSessionOriginV1 } }
            : {}),
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const parentVariant = msg.info.variant

      // FORK FEATURE (11) subagent-model-override — resolve the model+variant
      // atomically with precedence: caller override → agent config → parent
      // session → provider default. The variant must never survive
      // independently after its model candidate is rejected.
      const resolved = yield* resolveTaskModel({
        provider,
        callerModel: params.model,
        callerVariant: params.variant,
        agentConfig: next,
        parentModel: next.model ? undefined : { modelID: msg.info.modelID, providerID: msg.info.providerID },
        parentVariant: next.model ? undefined : msg.info.variant,
      })

      const model = resolved.model
      const metadata: TaskMetadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        modelSource: resolved.modelSource,
        ...(resolved.modelOverride ? { modelOverride: resolved.modelOverride } : {}),
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        // FORK FEATURE (12) volatile-injection — a sub-agent must retrieve its
        // own context; never inherit a parent's volatile retrievals. Strip any
        // volatile part from the parent-supplied prompt before it enters the
        // child session. (resolvePromptParts builds fresh parts from the
        // parent's authored prompt text, so volatile is normally absent — this
        // is a defensive guard against future paths that forward DB parts.)
        const stripped = parts.filter((p) => !(p as { volatile?: boolean }).volatile)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID as never,
            providerID: model.providerID as never,
          },
          variant: model.variant,
          agent: next.name,
          parts: stripped,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant: parentVariant,
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
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
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

      const info = yield* background.start({
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
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
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
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
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
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
