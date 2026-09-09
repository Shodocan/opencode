import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { BackgroundJob } from "../../src/background/job"
import { Plugin } from "../../src/plugin"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppLayer } from "../../src/effect/app-runtime"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

// Independent expected RED: docs/workflow-terminal-accuracy-expected-red.md.
// Real Task, background registry, runner, and protected session metadata.
afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const seed = Effect.fn("TerminalAccuracy.seed")(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "terminal accuracy fixture" })
  const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model, time: { created: 1 } })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(), sessionID: parent.id, role: "assistant", parentID: user.id,
    agent: "build", mode: "build", ...model, cost: 0, path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return { parent, assistant }
})
const cases: Array<{
  label: string
  error?: SessionV1.Assistant["error"]
  toolFailure?: boolean
  kind?: "provider" | "tool"
  status: "completed" | "failed" | "cancelled"
  remoteOutcome: "completed" | "unknown"
}> = [
  { label: "success", status: "completed", remoteOutcome: "completed" },
  { label: "HTTP429 response", error: { name: "APIError", data: { message: "quota", statusCode: 429, isRetryable: true } }, kind: "provider", status: "failed", remoteOutcome: "completed" },
  { label: "APIError without HTTP response", error: { name: "APIError", data: { message: "socket closed", isRetryable: true } }, kind: "provider", status: "failed", remoteOutcome: "unknown" },
  { label: "APIError with non-HTTP zero status", error: { name: "APIError", data: { message: "connection refused", statusCode: 0, isRetryable: true } }, kind: "provider", status: "failed", remoteOutcome: "unknown" },
  { label: "local UnknownError", error: { name: "UnknownError", data: { message: "local runtime failure" } }, kind: "tool", status: "failed", remoteOutcome: "unknown" },
  { label: "returned MessageAbortedError", error: { name: "MessageAbortedError", data: { message: "child execution interrupted" } }, status: "cancelled", remoteOutcome: "unknown" },
  { label: "completed failing child tool", toolFailure: true, kind: "tool", status: "failed", remoteOutcome: "completed" },
]
for (const item of cases) {
  it.instance(`native terminal accurately describes ${item.label}`, () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const fixture = yield* seed()
    const callbacks: unknown[] = []
    const abort = new AbortController()
    const ops: TaskPromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: (input) => Effect.sync(() => {
        const id = MessageID.ascending()
        return { info: { ...fixture.assistant, id, sessionID: input.sessionID, ...(item.error ? { error: item.error } : {}) },
          parts: item.toolFailure ? [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID,
            type: "tool" as const, tool: "bash", callID: "failed-check", state: { status: "error" as const, input: {}, error: "assertion failed", time: { start: 1, end: 2 } } }]
            : [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text" as const, text: "native result" }] }
      }),
    }
    const host = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]),
      trigger: (name, _input, output) => Effect.sync(() => { if (name === "task.execute.end") callbacks.push(output); return output }),
    })
    const outcome = yield* Effect.gen(function* () {
      const tool = yield* TaskTool
      const definition = yield* tool.init()
      return yield* definition.execute({ description: "terminal evidence table", prompt: "Read only", subagent_type: "general" }, {
        sessionID: fixture.parent.id, messageID: fixture.assistant.id, callID: "accuracy-call", agent: "build",
        abort: abort.signal, messages: [], extra: { promptOps: ops }, metadata: () => Effect.void, ask: () => Effect.void,
      })
    }).pipe(Effect.provideService(Plugin.Service, host), Effect.exit)
    expect(abort.signal.aborted).toBe(false)
    expect(Exit.isSuccess(outcome)).toBe(item.status === "completed")
    const children = yield* sessions.children(fixture.parent.id)
    expect(children).toHaveLength(1)
    const receipt = (yield* sessions.get(children[0].id)).metadata?.["opencode.task.terminal"] as Session.TaskTerminal
    expect(receipt).toMatchObject({ version: 1, parentSessionID: fixture.parent.id, callID: "accuracy-call",
      childSessionID: children[0].id, status: item.status, localQuiescence: true, remoteOutcome: item.remoteOutcome })
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]).toMatchObject({ status: item.status, localQuiescence: true, remoteOutcome: item.remoteOutcome })
    if (item.kind) {
      expect(receipt.executionFailure?.kind).toBe(item.kind)
      expect(callbacks[0]).toMatchObject({ executionFailure: { kind: item.kind } })
    } else expect(receipt.executionFailure?.kind).not.toBe("provider")
  }))
}

it.instance("concurrent cancel and wait cannot acknowledge while owned scope cleanup is pending", () => Effect.gen(function* () {
  const jobs = yield* BackgroundJob.Service
  const running = yield* Deferred.make<void>()
  const cleanup = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const stopped = yield* Deferred.make<void>()
  const job = yield* jobs.start({ type: "cleanup-order", run: Deferred.succeed(running, undefined).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Deferred.succeed(stopped, undefined)))),
  ) })
  yield* awaitWithTimeout(Deferred.await(running), "owned work did not start")
  const first = yield* jobs.cancel(job.id).pipe(Effect.forkChild({ startImmediately: true }))
  yield* awaitWithTimeout(Deferred.await(cleanup), "cancellation did not enter owned cleanup")
  const second = yield* jobs.cancel(job.id).pipe(Effect.forkChild({ startImmediately: true }))
  const waiting = yield* jobs.wait({ id: job.id }).pipe(Effect.forkChild({ startImmediately: true }))
  const earlyCancel = second.pollUnsafe()
  const earlyWait = waiting.pollUnsafe()
  // Release before asserting so a failing regression still cleans its scope.
  yield* Deferred.succeed(release, undefined)
  yield* awaitWithTimeout(Deferred.await(stopped), "owned cleanup did not finish")
  expect(Exit.isSuccess(yield* awaitWithTimeout(Fiber.await(first), "first cancel stalled"))).toBe(true)
  expect(Exit.isSuccess(yield* awaitWithTimeout(Fiber.await(second), "second cancel stalled"))).toBe(true)
  expect(Exit.isSuccess(yield* awaitWithTimeout(Fiber.await(waiting), "wait stalled"))).toBe(true)
  expect(earlyCancel, "a second cancel must await the first cancellation's cleanup").toBeUndefined()
  expect(earlyWait, "wait must not turn published intent into terminal acknowledgement").toBeUndefined()
}))

it.instance("session cancellation cannot leave descendants spawned while its live runner is stopping", () => Effect.gen(function* () {
  const jobs = yield* BackgroundJob.Service
  const sessions = yield* Session.Service
  const runners = yield* SessionRunState.Service
  const parent = yield* sessions.create({ title: "late descendant parent" })
  const child = yield* sessions.create({ parentID: parent.id, title: "late descendant" })
  const ready = yield* Deferred.make<void>()
  const cleaning = yield* Deferred.make<void>()
  const spawned = yield* Deferred.make<void>()
  const stopped = yield* Deferred.make<void>()
  const response: SessionV1.WithParts = { info: { id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model, time: { created: 1 } }, parts: [] }
  const runner = yield* runners.ensureRunning(parent.id, Effect.succeed(response), Effect.gen(function* () {
    yield* Deferred.succeed(ready, undefined)
    yield* Deferred.await(cleaning)
    yield* jobs.start({ id: child.id, type: "late-descendant", metadata: { parentSessionId: parent.id, sessionId: child.id }, run: Effect.never })
    yield* Deferred.succeed(spawned, undefined)
    return yield* Effect.never
  }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)))).pipe(Effect.forkChild)
  yield* awaitWithTimeout(Deferred.await(ready), "live runner did not start")
  const older = yield* jobs.start({ type: "existing-descendant", metadata: { parentSessionId: parent.id },
    run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(
      Effect.andThen(Effect.race(Deferred.await(spawned), Deferred.await(stopped))),
    ))) })
  yield* awaitWithTimeout(runners.cancel(parent.id), "session cancellation deadlocked")
  yield* awaitWithTimeout(Fiber.await(runner), "live runner survived cancellation")
  const remaining = (yield* jobs.list()).filter((job) => job.metadata?.parentSessionId === parent.id && job.status === "running")
  // Always stop a leaked fixture before asserting the observed release bug.
  yield* Effect.forEach(remaining, (job) => jobs.cancel(job.id), { discard: true })
  expect((yield* jobs.get(older.id))?.status).toBe("cancelled")
  expect(remaining).toEqual([])
}))
