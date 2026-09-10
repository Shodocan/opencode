import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { BackgroundJob } from "../../src/background/job"
import { ToolRegistry } from "../../src/tool/registry"
import { Parameters, type TaskPromptOps } from "../../src/tool/task"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

// Capture only the Task consumer boundary. SessionPrompt.ops, Runner and the
// BackgroundJob registry remain real; no provider is called by this subtask.
const captured: { ops?: TaskPromptOps } = {}
const registry = Layer.mock(ToolRegistry.Service, {
  named: () => Effect.succeed({
    task: { id: "task", description: "capture actual prompt ops", parameters: Parameters,
      execute: (_args, ctx) => Effect.gen(function* () {
        captured.ops = ctx.extra?.promptOps as TaskPromptOps
        return yield* Effect.never
      }),
    },
    read: undefined as never,
  }),
})
const it = testEffect(AppNodeBuilderV1.build(LayerNode.group([
  SessionPrompt.node, Session.node, SessionRunState.node, BackgroundJob.node, SessionProjector.node,
]), [[ToolRegistry.node, registry]]))
afterEach(async () => { delete captured.ops; await disposeAllInstances() })

it.instance("real SessionPrompt.ops cleanup excludes its own job while stopping child Runner and descendants", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const state = yield* SessionRunState.Service
  const jobs = yield* BackgroundJob.Service
  const parent = yield* sessions.create({ title: "prompt cleanup parent" })
  const model = { providerID: ProviderV2.ID.make("offline"), modelID: ModelV2.ID.make("test") }
  const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model, time: { created: 1 } })
  yield* sessions.updatePart({ id: PartID.ascending(), messageID: user.id, sessionID: parent.id,
    type: "subtask", prompt: "Capture cleanup boundary", description: "cleanup", agent: "general", model })
  const parentFiber = yield* prompt.loop({ sessionID: parent.id }).pipe(Effect.forkChild)
  const ops = yield* pollWithTimeout(Effect.sync(() => captured.ops), "actual SessionPrompt.ops never reached Task")
  const child = yield* sessions.create({ parentID: parent.id, title: "cleanup child" })
  const ready = yield* Deferred.make<void>()
  const interrupted = yield* Deferred.make<void>()
  const descendantStopped = yield* Deferred.make<void>()
  const onInterrupt: SessionV1.WithParts = { info: { ...user, sessionID: child.id }, parts: [] }
  const childFiber = yield* state.ensureRunning(child.id, Effect.succeed(onInterrupt),
    Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.succeed(interrupted, undefined))),
  ).pipe(Effect.forkChild)
  yield* awaitWithTimeout(Deferred.await(ready), "child Runner never started")
  const descendant = yield* jobs.start({ type: "task", metadata: { parentSessionId: child.id },
    run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(descendantStopped, undefined))) })
  const cleanup = yield* jobs.start({ id: child.id, type: "task", metadata: { sessionId: child.id, parentSessionId: parent.id },
    run: ops.cancel(child.id, { excludeJobID: child.id }).pipe(Effect.as("locally quiescent")) })
  const result = yield* jobs.wait({ id: cleanup.id, timeout: 2000 })
  expect(result.timedOut).toBe(false)
  expect(result.info?.status).toBe("completed")
  expect(result.info?.output).toBe("locally quiescent")
  yield* awaitWithTimeout(Deferred.await(interrupted), "child Runner survived cleanup")
  yield* awaitWithTimeout(Deferred.await(descendantStopped), "descendant survived cleanup")
  expect((yield* jobs.get(descendant.id))?.status).toBe("cancelled")
  yield* Fiber.await(childFiber)
  yield* prompt.cancel(parent.id)
  yield* Fiber.await(parentFiber)
}), { config: {
  model: "offline/test",
  provider: { offline: { npm: "@ai-sdk/openai-compatible", models: { test: {
    name: "offline test", limit: { context: 32000, output: 2000 },
  } }, options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "offline-fixture" } } },
} })
