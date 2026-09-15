import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { TaskTool, Parameters, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppLayer } from "../../src/effect/app-runtime"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const params = { description: "Route fixture", prompt: "Return fixture text", subagent_type: "general" }
const exact = { id: "review", providerID: "offline", variant: "max" }

test("task wire schema exposes an optional tuple with required route fields", () => {
  expect(ToolJsonSchema.fromSchema(Parameters)).toMatchObject({
    properties: { model: { type: "object", required: ["id", "providerID"] } },
  })
  expect(Schema.decodeUnknownSync(Parameters)({ ...params, model: exact })).toMatchObject({ model: exact })
  for (const model of [{}, { id: "review" }, { providerID: "offline" }, { ...exact, variant: 1 }]) {
    expect(() => Schema.decodeUnknownSync(Parameters)({ ...params, model })).toThrow()
  }
  expect(ToolJsonSchema.fromSchema(SessionPrompt.PromptInput).properties).not.toHaveProperty("taskModelExact")
})

for (const existing of [false, true]) {
  for (const mode of [
    "explicit",
    "absent",
    "default",
    "unknown-model",
    "unknown-provider",
    "unknown-variant",
    "blank-id",
    "blank-provider",
    "blank-variant",
  ] as const) {
    it.instance(
      `task model ${existing ? "continuation" : "new"} ${mode}`,
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "parent" })
          const child = existing ? yield* sessions.create({ parentID: parent.id, title: "existing" }) : undefined
          const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: parent.id,
            role: "user",
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: parent.id,
            role: "assistant",
            parentID: user.id,
            agent: "build",
            mode: "build",
            ...ref,
            variant: "xhigh",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now() },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          const seen: SessionPrompt.InternalPromptInput[] = []
          const ops: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.succeed([]),
            prompt: (input) =>
              Effect.sync(() => {
                seen.push(input)
                return { info: user, parts: [] }
              }),
          }
          const tool = yield* TaskTool
          const def = yield* tool.init()
          const model =
            mode === "default"
              ? undefined
              : {
                  id: mode === "unknown-model" ? "missing" : mode === "blank-id" ? " " : "review",
                  providerID: mode === "unknown-provider" ? "missing" : mode === "blank-provider" ? " " : "offline",
                  ...(mode === "absent"
                    ? {}
                    : { variant: mode === "unknown-variant" ? "missing" : mode === "blank-variant" ? " " : "max" }),
                }
          const input = { ...params, task_id: child?.id, model }
          const ctx = {
            sessionID: parent.id,
            messageID: assistant.id,
            callID: "route-fixture",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            extra: { promptOps: ops },
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }
          const result = yield* def.execute(input, ctx).pipe(Effect.exit)
          const invalid = mode.startsWith("unknown") || mode.startsWith("blank")
          expect(Exit.isSuccess(result)).toBe(!invalid)
          expect(seen).toHaveLength(invalid ? 0 : 1)
          expect(yield* sessions.children(parent.id)).toHaveLength(existing || !invalid ? 1 : 0)
          if (invalid) return
          if (child) expect(seen[0].sessionID).toBe(child.id)
          expect(seen[0].model).toEqual(
            mode === "default"
              ? ref
              : {
                  providerID: ProviderV2.ID.make("offline"),
                  modelID: ModelV2.ID.make("review"),
                },
          )
          expect(seen[0].variant).toBe(mode === "default" ? "xhigh" : mode === "explicit" ? "max" : undefined)
          // A later invocation without an override must use legacy routing, not the prior tuple.
          yield* def.execute(
            { ...params, task_id: seen[0].sessionID, command: "fixture" },
            { ...ctx, callID: "next-invocation" },
          )
          expect(seen[1].model).toEqual(ref)
          expect(seen[1].variant).toBe("xhigh")
        }),
      {
        config: {
          provider: {
            offline: {
              npm: "@ai-sdk/openai-compatible",
              models: {
                review: {
                  name: "review",
                  limit: { context: 32000, output: 2000 },
                  variants: { max: { reasoningEffort: "high" } },
                },
              },
            },
          },
        },
      },
    )
  }
}
