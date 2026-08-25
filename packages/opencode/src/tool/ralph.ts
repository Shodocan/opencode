import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import type { TaskPromptOps } from "./task"
import { MessageID } from "@opencode-ai/core/v1/session"
import { Session } from "../session/session"
import { SessionGoalShell } from "../session/goal-service"

// FORK FEATURE (13) autonomy-stack / L3 — the ralph loop.
//
// A TOOL, not a branch of evaluate(). The runLoop exit guard's only continuation
// mechanism injects a synthetic message into the SAME session -- which is exactly
// the accumulated context a fresh round must discard. And while this tool call is
// in flight the guard never evaluates (finish is "tool-calls"). The two
// mechanisms are disjoint by construction, not by convention.
//
// Exactly two things cross a round boundary, as in dsh:
//   1. the working tree, which is the declared source of truth;
//   2. one bounded structured round report.
// No scratch file, no journal. The report is HARD-FAILED rather than truncated
// when it overflows -- a silently truncated hand-off is worse than a stopped loop.

const MAX_REPORT_CHARS = 16384
const DEFAULT_MAX_ROUNDS = 8

export const Parameters = Schema.Struct({
  objective: Schema.String.annotate({
    description: "What must be true when the loop is done. Write a checkable end state, not an activity.",
  }),
  maxRounds: Schema.optional(Schema.Number).annotate({
    description: `Maximum rounds before the loop stops itself (default ${DEFAULT_MAX_ROUNDS}).`,
  }),
})

type Metadata = { rounds: number; status: string; objective: string }

const ReportSchema = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: {
      type: "string",
      enum: ["complete", "blocked", "continue"],
      description: "complete: the objective is met. blocked: you cannot proceed. continue: more work remains.",
    },
    summary: { type: "string", description: "What this round actually changed." },
    evidence: { type: "array", items: { type: "string" }, description: "Commands run or files changed, as proof." },
    nextSteps: { type: "array", items: { type: "string" }, description: "For `continue`: what the next round must do." },
    blocker: { type: "string", description: "For `blocked`: what is in the way." },
  },
} as const

type Report = {
  status: "complete" | "blocked" | "continue"
  summary: string
  evidence?: string[]
  nextSteps?: string[]
  blocker?: string
}

const roundPrompt = (objective: string, round: number, maxRounds: number, previous: Report | undefined) => {
  const handoff = previous
    ? `\n\nPREVIOUS ROUND (round ${round - 1}) reported:\n${JSON.stringify(previous, null, 2)}\n\nThe working tree is the source of truth -- RE-VERIFY it rather than trusting the summary above.`
    : "\n\nThis is the first round. Inspect the working tree before changing anything."
  return `You are one round of a repeat-until-done loop (round ${round} of at most ${maxRounds}).

OBJECTIVE: ${objective}${handoff}

Do the next concrete piece of work toward the objective, then settle by returning a structured report.
Set status "complete" ONLY if the objective is now actually true and you verified it. Set "blocked" if you
genuinely cannot proceed. Otherwise "continue", and say in nextSteps what the next round must do.

You have a FRESH context: nothing from earlier rounds is in your history except the report above.`
}

export const RalphTool = Tool.define<typeof Parameters, Metadata, Session.Service | SessionGoalShell.Service>(
  "ralph",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const goal = yield* SessionGoalShell.Service

    return {
      description:
        "Repeat-until-done loop. Runs the objective across multiple rounds, each in a FRESH child session so accumulated context cannot rot the work. Use for long mechanical grinds (mass refactor, test-suite repair) where the working tree carries the state.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "ralph", patterns: ["*"], always: ["*"], metadata: { objective: params.objective } })

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops)
            return {
              title: "ralph: unavailable",
              output: "The ralph tool requires promptOps in ctx.extra and is not available in this context.",
              metadata: { rounds: 0, status: "unavailable", objective: params.objective },
            }

          const maxRounds = Math.max(1, params.maxRounds ?? DEFAULT_MAX_ROUNDS)
          let previous: Report | undefined
          let round = 0

          while (round < maxRounds) {
            round++
            // A FRESH child session per round: this is the whole point of L3.
            const child = yield* sessions.create({
              parentID: ctx.sessionID,
              title: `ralph round ${round}: ${params.objective}`.slice(0, 120),
            })

            const text = roundPrompt(params.objective, round, maxRounds, previous)
            const result = yield* ops.prompt({
              messageID: MessageID.ascending(),
              sessionID: child.id,
              parts: [{ type: "text", text }] as never,
              format: { type: "json_schema", schema: ReportSchema } as never,
            })

            // E-15 / [F2]: fold the child's spend into the invoking goal, or a
            // ralph-driven goal spends almost entirely where the cap cannot see.
            const spent = yield* sessions
              .get(child.id)
              .pipe(Effect.map((s: any) => (s?.tokens ? s.tokens.input + s.tokens.output : 0)), Effect.orElseSucceed(() => 0))
            yield* goal.addTokens(ctx.sessionID, spent).pipe(Effect.orElseSucceed(() => undefined))

            const structured =
              result.info.role === "assistant" ? (result.info.structured as Report | undefined) : undefined
            if (!structured) {
              return {
                title: `ralph: round-failed at ${round}`,
                output: `Round ${round} settled without a structured report. Last good hand-off:\n${JSON.stringify(previous ?? null, null, 2)}`,
                metadata: { rounds: round, status: "round-failed", objective: params.objective },
              }
            }

            const serialized = JSON.stringify(structured)
            if (serialized.length > MAX_REPORT_CHARS) {
              // HARD FAIL, never truncate: a silently shortened hand-off makes the
              // next round act on a partial picture, which is worse than stopping.
              return {
                title: `ralph: report too large at round ${round}`,
                output: `Round ${round} report is ${serialized.length} chars, over the ${MAX_REPORT_CHARS} limit. Stopping rather than truncating the hand-off.`,
                metadata: { rounds: round, status: "round-failed", objective: params.objective },
              }
            }

            if (structured.status === "complete")
              return {
                title: `ralph: complete in ${round} round${round === 1 ? "" : "s"}`,
                output: structured.summary,
                metadata: { rounds: round, status: "complete", objective: params.objective },
              }

            if (structured.status === "blocked")
              return {
                title: `ralph: blocked at round ${round}`,
                output: structured.blocker ?? structured.summary,
                metadata: { rounds: round, status: "blocked", objective: params.objective },
              }

            previous = structured
          }

          return {
            title: `ralph: budget-limited after ${maxRounds} rounds`,
            output: `Stopped at the ${maxRounds}-round budget without reaching the objective. Last hand-off:\n${JSON.stringify(previous ?? null, null, 2)}`,
            metadata: { rounds: maxRounds, status: "budget-limited", objective: params.objective },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
