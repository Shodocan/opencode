import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { SessionGoalShell } from "../session/goal-service"
import { SessionGoal } from "@opencode-ai/core/session/goal"

// FORK FEATURE (13) autonomy-stack / L4 — the model-callable goal verbs (S-1).
// The roster is enumerated, not open-ended [F10]: create / complete /
// report-blocked / resume. Each has its own acceptance criterion (S-1a..S-1d).

export const Parameters = Schema.Struct({
  verb: Schema.Literals(["create", "complete", "report-blocked", "resume"]).annotate({
    description:
      "create: open a durable objective with a round/token budget. complete: declare it met. report-blocked: declare you cannot proceed. resume: re-arm after an abort.",
  }),
  objective: Schema.optional(Schema.String).annotate({
    description: "For `create`: what must be true for this goal to be complete.",
  }),
  maxRounds: Schema.optional(Schema.Number).annotate({
    description: "For `create`: maximum rounds before the goal stops itself (default from config).",
  }),
  maxTokens: Schema.optional(Schema.Number).annotate({
    description: "For `create`: cumulative token ceiling before the goal stops itself.",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "For `report-blocked`: why you cannot proceed.",
  }),
})

type Metadata = { verb: string; phase?: string; code?: string }

const DESCRIPTION = `Manage a durable objective for this session.

Use \`create\` when the user gives you a multi-step objective that will outlive a single reply. Once a goal
is active the harness re-enters the loop after each turn until you mark it complete or blocked, or until it
runs out of its round/token budget.

Use \`complete\` the moment the objective is actually met — do not keep working past it.
Use \`report-blocked\` when you genuinely cannot proceed; say why in \`message\`.
Use \`resume\` only to re-arm a goal that was interrupted by an abort.`

export const GoalTool = Tool.define<typeof Parameters, Metadata, SessionGoalShell.Service>(
  "goal",
  Effect.gen(function* () {
    const goal = yield* SessionGoalShell.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "goal", patterns: ["*"], always: ["*"], metadata: { verb: params.verb } })

          const current = yield* goal.read(ctx.sessionID)

          if (params.verb === "create") {
            if (!params.objective)
              return { title: "goal", output: "Error: `objective` is required for create.", metadata: { verb: params.verb } }
            yield* goal.create(ctx.sessionID, {
              objective: params.objective,
              maxRounds: params.maxRounds,
              maxTokens: params.maxTokens,
            })
            return {
              title: "goal created",
              output: `Goal active: ${params.objective}`,
              metadata: { verb: params.verb, phase: "active" },
            }
          }

          if (!current)
            return { title: "goal", output: "Error: no goal exists for this session.", metadata: { verb: params.verb } }

          if (params.verb === "complete") {
            yield* goal.complete(ctx.sessionID)
            return { title: "goal complete", output: "Goal marked complete.", metadata: { verb: params.verb, phase: "complete" } }
          }

          if (params.verb === "report-blocked") {
            // (P15): this verb writes model_reported and NEVER a budget or halt code.
            const message = params.message ?? "The model reported it cannot proceed."
            yield* goal.block(ctx.sessionID, "model_reported", message)
            return {
              title: "goal blocked",
              output: `Goal blocked: ${message}`,
              metadata: { verb: params.verb, phase: "blocked", code: "model_reported" },
            }
          }

          // resume — S-1d precondition (P7). Rejected on a blocked or complete
          // goal: it re-arms nothing, which is what enforces frozen C3. Raising
          // an exhausted cap is deliberately NOT this verb (spec OQ7).
          const rearmed = yield* goal.resume(ctx.sessionID)
          if (!rearmed)
            return {
              title: "goal",
              output: `Error: cannot resume a goal in phase "${current.snapshot.phase}". Only an active goal can be re-armed.`,
              metadata: { verb: params.verb, phase: current.snapshot.phase },
            }
          return { title: "goal resumed", output: "Goal re-armed.", metadata: { verb: params.verb, phase: "active" } }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

export type { SessionGoal }
