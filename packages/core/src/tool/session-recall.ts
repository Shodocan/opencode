export * as SessionRecallTool from "./session-recall"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { SessionRecall } from "../session/enharden/recall"
import { Tool } from "./tool"
import { Tools } from "./tools"

// FORK FEATURE (5) compaction-enhardening — the F3 recovery tool. CORE tool so
// the v2 runner's ToolRegistry materializes it (registered via Tools.Service and
// added to BuiltInTools.locationLayer — see FORK_CHANGES.md / fork-features-plan.md).

export const name = "session_recall"

export const Input = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Text to find in the summarized-away conversation history: a file path, error string, identifier, or prior tool output that compaction may have dropped.",
  }),
  tool: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional: restrict matches to messages involving this tool name.",
  }),
  limit: Schema.Number.pipe(Schema.optional).annotate({ description: "Max matches to return (default 5)." }),
  context_chars: Schema.Number.pipe(Schema.optional).annotate({
    description: "Chars of surrounding context per match (default 400).",
  }),
})

export const Output = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ seq: Schema.Number, type: Schema.String, snippet: Schema.String })),
  total: Schema.Number,
  truncated: Schema.Boolean,
})
type ModelOutput = typeof Output.Encoded

export const toModelOutput = (output: ModelOutput): string => {
  if (output.matches.length === 0) return "No matches in summarized history (session may not have been compacted yet)."
  const lines = output.matches.map((match) => `[seq ${match.seq} · ${match.type}]\n${match.snippet}`)
  const remaining = output.total - output.matches.length
  if (remaining > 0) lines.push(`… ${remaining} more match(es) — refine the query or raise limit.`)
  return lines.join("\n\n---\n\n")
}

/** session_recall leaf: searches pre-compaction history via the session DB. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const db = (yield* Database.Service).db

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Recover detail that compaction summarized away. Searches the pre-compaction conversation (old tool outputs, file contents, diffs, error strings) the summary may have dropped. Use when the summary references something whose specifics you now need. Best-effort: empty if the session was never compacted or the rows were reverted.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            SessionRecall.search(db, context.sessionID, {
              query: input.query,
              tool: input.tool,
              limit: input.limit ?? 5,
              contextChars: input.context_chars ?? 400,
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `session_recall failed for "${input.query}"` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
