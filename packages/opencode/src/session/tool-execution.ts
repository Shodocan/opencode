import { Plugin } from "@/plugin"
import { Tool } from "@/tool/tool"
import { Cause, Effect, Exit } from "effect"

/** Attach only after admission succeeds; terminal journal failures stay visible. */
export function observeFailure(
  plugin: Plugin.Interface,
  input: { tool: string; sessionID: string; callID: string; args: unknown; taskOrigin?: Tool.TaskOrigin },
  metadata: () => Record<string, unknown>,
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void
        return plugin.trigger("tool.execute.error", input, {
          error: Cause.squash(exit.cause),
          interrupted: Exit.hasInterrupts(exit),
          metadata: metadata(),
        })
      }),
    )
}

export * as ToolExecution from "./tool-execution"
