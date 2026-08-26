import { Cause, Effect, Exit } from "effect"
import type { TaskOrigin } from "@opencode-ai/plugin"
import type { Plugin } from "@/plugin"

/**
 * tool.execute.finally — durable native-operation observation.
 *
 * `toolExecuteFinally` runs a tool body and fires exactly one
 * `tool.execute.finally` plugin trigger for the outcome (success, error, or
 * cancelled) before propagating the body's result unchanged. The finally
 * trigger is observation-only: a failing or defecting observer must never
 * change the tool outcome, and an aborted/aborting execution always reports
 * `cancelled` without an error payload.
 */

/** Hard cap on the error message carried in the finally payload. */
export const TOOL_EXECUTE_FINALLY_ERROR_MESSAGE_MAX = 500

export interface ToolExecuteFinallyInput {
  tool: string
  sessionID: string
  callID: string
  args: any
  /** Host-minted child-task provenance; echoed into the finally payload when present. */
  taskOrigin?: TaskOrigin
  /** Execution signal; an already-aborted signal forces the cancelled outcome. */
  signal?: AbortSignal
}

export interface ToolExecuteFinallyError {
  name: string
  message: string
}

export type ToolExecuteFinallyOutcome = "success" | "error" | "cancelled"

function truncate(message: string): string {
  return message.length > TOOL_EXECUTE_FINALLY_ERROR_MESSAGE_MAX
    ? message.slice(0, TOOL_EXECUTE_FINALLY_ERROR_MESSAGE_MAX)
    : message
}

function errorDetail(cause: Cause.Cause<unknown>): ToolExecuteFinallyError {
  const error = Cause.squash(cause)
  if (error instanceof Error) return { name: error.name, message: truncate(error.message) }
  return { name: "Error", message: truncate(String(error)) }
}

export function toolExecuteFinallyOutcome(
  input: ToolExecuteFinallyInput,
  exit: Exit.Exit<unknown, unknown>,
): ToolExecuteFinallyOutcome {
  if (Exit.isSuccess(exit)) return "success"
  if (Cause.hasInterruptsOnly(exit.cause)) return "cancelled"
  if (input.signal?.aborted) return "cancelled"
  const error = Cause.squash(exit.cause)
  if (error instanceof Error && error.name === "AbortError") return "cancelled"
  return "error"
}

export function toolExecuteFinally<A>(
  plugin: Plugin.Interface,
  input: ToolExecuteFinallyInput,
  // Any error channel is accepted; the static result channel is clean — the
  // outcome travels through captured Exit values (success / propagated cause /
  // interrupt) rather than a typed error channel.
  body: Effect.Effect<A, unknown, never>,
): Effect.Effect<A, never, never> {
  const base = {
    tool: input.tool,
    sessionID: input.sessionID,
    callID: input.callID,
    args: input.args,
    ...(input.taskOrigin ? { taskOrigin: input.taskOrigin } : {}),
  }
  // Observation only: swallow failures AND defects from the observers so a
  // broken finally handler can never alter the propagated outcome.
  const fire = (outcome: ToolExecuteFinallyOutcome, error?: ToolExecuteFinallyError) =>
    plugin
      .trigger("tool.execute.finally", { ...base, outcome, ...(error ? { error } : {}) }, {})
      .pipe(Effect.catchCause(() => Effect.void))

  // Effect.exit captures typed failures and defects but NOT interrupts, so
  // the cancelled outcome for an interrupted body is fired from a finalizer
  // (which runs on every exit path) and the settled flag keeps exactly one
  // finally per execution.
  let settled = false
  return Effect.gen(function* () {
    const exit = (yield* body.pipe(Effect.exit)) as Exit.Exit<A, unknown>
    settled = true
    const outcome = toolExecuteFinallyOutcome(input, exit)
    if (outcome === "error")
      yield* fire(outcome, errorDetail((exit as Exit.Failure<A, unknown>).cause))
    else
      yield* fire(outcome)
    return (exit._tag === "Success" ? exit.value : yield* Effect.failCause(exit.cause)) as A
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (settled) return
        yield* fire("cancelled")
      }),
    ),
  ) as Effect.Effect<A, never, never>
}
