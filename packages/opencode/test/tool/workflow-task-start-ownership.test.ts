import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { BackgroundJob } from "../../src/background/job"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MessageID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppLayer } from "../../src/effect/app-runtime"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

for (const background of [false, true]) {
it.instance(`interruption after real child startup but before ${background ? "background handoff" : "foreground wait admission"} joins that child and records its terminal proof`, () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* BackgroundJob.Service
  const flags = yield* RuntimeFlags.Service
  const parent = yield* sessions.create({ title: "Task startup ownership" })
  const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model, time: { created: 1 } })
  const assistant = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "assistant", parentID: user.id,
    agent: "build", mode: "build", ...model, cost: 0, path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const started = yield* Deferred.make<SessionID>()
  const admitted = yield* Deferred.make<void>()
  const releaseAdmission = yield* Deferred.make<void>()
  const stopped = yield* Deferred.make<void>()
  const callbacks: unknown[] = []
  let waitCalls = 0
  const observed = BackgroundJob.Service.of({ ...jobs,
    // Pause only the return boundary after the real registry has started its
    // owned child. The parent has not reached its foreground wait guard yet.
    start: input => jobs.start(input).pipe(Effect.flatMap(info => Deferred.succeed(admitted, undefined).pipe(
      Effect.andThen(Deferred.await(releaseAdmission)), Effect.as(info)))),
    wait: input => { waitCalls++; return jobs.wait(input) },
  })
  const ops: TaskPromptOps = { cancel: () => Effect.void, resolvePromptParts: () => Effect.succeed([]),
    prompt: input => Deferred.succeed(started, input.sessionID).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.succeed(stopped, undefined))) }
  const hooks = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]), trigger: (name, _input, output) => Effect.sync(() => {
    if (name === "task.execute.end") callbacks.push(output)
    return output
  }) })
  const task = yield* Effect.gen(function* () {
    const tool = yield* TaskTool
    const definition = yield* tool.init()
    return yield* definition.execute({ description: "Early interrupted Task", prompt: "Read only.", subagent_type: "general", background },
      { sessionID: parent.id, messageID: assistant.id, callID: "startup-ownership-call", agent: "build", abort: new AbortController().signal,
        messages: [], extra: { promptOps: ops }, metadata: () => Effect.void, ask: () => Effect.void })
  }).pipe(Effect.provideService(BackgroundJob.Service, observed), Effect.provideService(Plugin.Service, hooks),
    Effect.provideService(RuntimeFlags.Service, { ...flags, experimentalBackgroundSubagents: true }), Effect.forkChild)
  const childID = yield* awaitWithTimeout(Deferred.await(started), "real child prompt never started")
  yield* awaitWithTimeout(Deferred.await(admitted), "real job admission never returned")
  expect(waitCalls).toBe(0)
  const interruption = yield* Fiber.interrupt(task).pipe(Effect.forkChild)
  yield* Effect.yieldNow
  yield* Deferred.succeed(releaseAdmission, undefined)
  yield* awaitWithTimeout(Fiber.await(interruption), "interrupted Task failed to finish ownership cleanup")
  const childStoppedBeforeFixtureCleanup = yield* Deferred.isDone(stopped)
  const receiptBeforeFixtureCleanup = (yield* sessions.get(childID)).metadata?.["opencode.task.terminal"]
  const callbacksBeforeFixtureCleanup = [...callbacks]
  // Stop any leaked ordinary fixture work before assertions. The captured
  // evidence above cannot be manufactured by this teardown.
  yield* jobs.cancel(childID)
  expect(childStoppedBeforeFixtureCleanup, "Task interruption must join work started before foreground ownership setup").toBe(true)
  expect(receiptBeforeFixtureCleanup).toMatchObject({ callID: "startup-ownership-call", status: "cancelled", localQuiescence: true, remoteOutcome: "unknown" })
  expect(callbacksBeforeFixtureCleanup).toHaveLength(1)
  expect(callbacksBeforeFixtureCleanup[0]).toMatchObject({ status: "cancelled", localQuiescence: true, remoteOutcome: "unknown" })
}))
}
