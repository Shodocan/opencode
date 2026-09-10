import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { BackgroundJob } from "../../src/background/job"
import { Plugin } from "../../src/plugin"
import { MessageID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppLayer } from "../../src/effect/app-runtime"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

it.instance("foreground Task interruption explicitly requests quiescent cancellation of its owned background job", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* BackgroundJob.Service
  const parent = yield* sessions.create({ title: "Task cancellation opt-in" })
  const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model, time: { created: 1 } })
  const assistant = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "assistant", parentID: user.id,
    agent: "build", mode: "build", ...model, cost: 0, path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const calls: { id: string; quiescent?: boolean }[] = []
  const waiting = yield* Deferred.make<void>()
  const observed = BackgroundJob.Service.of({ ...jobs, cancel: (id, options?: { quiescent?: boolean }) => {
    calls.push({ id, quiescent: options?.quiescent })
    return jobs.cancel(id, options)
  }, wait: input => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(jobs.wait(input))) })
  const started = yield* Deferred.make<void>()
  const stopped = yield* Deferred.make<void>()
  const ops: TaskPromptOps = { cancel: () => Effect.void, resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.succeed(stopped, undefined))) }
  const hooks = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]), trigger: (_name, _input, output) => Effect.succeed(output) })
  const task = yield* Effect.gen(function* () {
    const tool = yield* TaskTool
    const definition = yield* tool.init()
    return yield* definition.execute({ description: "Interrupted foreground fixture", prompt: "Read only.", subagent_type: "general" },
      { sessionID: parent.id, messageID: assistant.id, callID: "cancel-quiescence-call", agent: "build", abort: new AbortController().signal,
        messages: [], extra: { promptOps: ops }, metadata: () => Effect.void, ask: () => Effect.void })
  }).pipe(Effect.provideService(BackgroundJob.Service, observed), Effect.provideService(Plugin.Service, hooks), Effect.forkChild)
  yield* awaitWithTimeout(Deferred.await(started), "child prompt never started")
  yield* awaitWithTimeout(Deferred.await(waiting), "foreground wait never became active")
  yield* awaitWithTimeout(Fiber.interrupt(task), "foreground interruption did not settle")
  yield* awaitWithTimeout(Deferred.await(stopped), "owned child survived Task interruption")
  const children = yield* sessions.children(parent.id)
  expect(children).toHaveLength(1)
  expect(calls).toContainEqual({ id: children[0].id, quiescent: true })
  expect((yield* sessions.get(children[0].id)).metadata?.["opencode.task.terminal"])
    .toMatchObject({ status: "cancelled", localQuiescence: true, remoteOutcome: "unknown" })
}))
