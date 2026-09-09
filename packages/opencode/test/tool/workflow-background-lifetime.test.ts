import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { BackgroundJob } from "../../src/background/job"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppLayer } from "../../src/effect/app-runtime"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

// Independent expected RED: docs/workflow-background-lifetime-expected-red.md.
afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const args = { description: "Background lifetime fixture", prompt: "Read only", subagent_type: "general", background: true }
const seed = Effect.fn("BackgroundLifetime.seed")(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "background lifetime parent" })
  const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "user",
    agent: "build", model, time: { created: 1 } })
  const assistant = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "assistant",
    parentID: user.id, agent: "build", mode: "build", ...model, cost: 0,
    path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  return { parent, assistant }
})
function response(sessionID: SessionID): SessionV1.WithParts {
  const messageID = MessageID.ascending()
  return { info: { id: messageID, sessionID, role: "user", agent: "general", model, time: { created: 3 } },
    parts: [{ id: PartID.ascending(), messageID, sessionID, type: "text", text: "Background review completed." }] }
}

for (const action of ["normal stream closure", "explicit parent cancel", "explicit child cancel"] as const) {
  it.instance("background kickoff survives only normal parent stream lifetime: " + action, () => Effect.gen(function* () {
    const fixture = yield* seed()
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service
    const jobs = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const started = yield* Deferred.make<SessionID>()
    const release = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const notified = yield* Deferred.make<string>()
    const stream = new AbortController()
    const terminal: unknown[] = []
    const host = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]),
      trigger: (name, _input, output) => Effect.sync(() => { if (name === "task.execute.end") terminal.push(output); return output }) })
    const ops: TaskPromptOps = {
      cancel: runState.cancel,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: (input) => input.sessionID === fixture.parent.id
        ? Deferred.succeed(notified, input.parts.filter(part => part.type === "text").map(part => part.text).join("\n")).pipe(Effect.as(response(input.sessionID)))
        : runState.ensureRunning(input.sessionID, Effect.succeed(response(input.sessionID)), Effect.gen(function* () {
            yield* Deferred.succeed(started, input.sessionID)
            yield* Deferred.await(release)
            return response(input.sessionID)
          }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)))),
    }
    yield* Effect.gen(function* () {
      const tool = yield* TaskTool
      const definition = yield* tool.init()
      const kickoff = yield* definition.execute(args, { sessionID: fixture.parent.id, messageID: fixture.assistant.id,
        callID: "background-lifetime-call", agent: "build", abort: stream.signal, messages: [],
        extra: { promptOps: ops }, metadata: () => Effect.void, ask: () => Effect.void })
      expect(kickoff.metadata.background).toBe(true)
      const child = yield* awaitWithTimeout(Deferred.await(started), "background child never started")
      // This is the scoped provider stream closing after Task returned. It is
      // deliberately not a user cancellation; native explicit cancel is below.
      stream.abort()
      if (action === "normal stream closure") yield* Deferred.succeed(release, undefined)
      if (action === "explicit parent cancel") yield* awaitWithTimeout(runState.cancel(fixture.parent.id), "parent cancel stalled")
      if (action === "explicit child cancel") yield* awaitWithTimeout(runState.cancel(child), "child cancel stalled")
      const result = yield* awaitWithTimeout(jobs.wait({ id: child }), "background job never settled")
      yield* awaitWithTimeout(Deferred.await(stopped), "owned child runner remained live")
      const expected = action === "normal stream closure" ? "completed" : "cancelled"
      expect(result.info?.status).toBe(expected)
      const receipt = (yield* sessions.get(child)).metadata?.["opencode.task.terminal"]
      expect(receipt).toMatchObject({ callID: "background-lifetime-call", status: expected, localQuiescence: true })
      expect(terminal).toHaveLength(1)
      expect(terminal[0]).toMatchObject({ status: expected, localQuiescence: true })
      if (action === "normal stream closure") {
        expect(receipt).toMatchObject({ remoteOutcome: "completed" })
        expect(yield* awaitWithTimeout(Deferred.await(notified), "completed background task never notified parent")).toContain("Background task completed:")
      }
    }).pipe(Effect.provideService(Plugin.Service, host),
      Effect.provideService(RuntimeFlags.Service, { ...flags, experimentalBackgroundSubagents: true }))
  }))
}

it.instance("background abort during awaited startup still prevents every child prompt", () => Effect.gen(function* () {
  const fixture = yield* seed()
  const sessions = yield* Session.Service
  const runState = yield* SessionRunState.Service
  const flags = yield* RuntimeFlags.Service
  const starting = yield* Deferred.make<SessionID>()
  const release = yield* Deferred.make<void>()
  const stream = new AbortController()
  const prompts: SessionID[] = []
  const host = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]),
    trigger: (name, input, output) => Effect.gen(function* () {
      if (name === "task.execute.start") {
        yield* Deferred.succeed(starting, SessionID.make((input as { childSessionID: string }).childSessionID))
        yield* Deferred.await(release)
      }
      return output
    }) })
  const ops: TaskPromptOps = { cancel: runState.cancel, resolvePromptParts: () => Effect.succeed([]),
    prompt: (input) => Effect.sync(() => { prompts.push(input.sessionID); return response(input.sessionID) }) }
  const execution = yield* Effect.gen(function* () {
    const tool = yield* TaskTool
    const definition = yield* tool.init()
    return yield* definition.execute(args, { sessionID: fixture.parent.id, messageID: fixture.assistant.id,
      callID: "background-startup-abort", agent: "build", abort: stream.signal, messages: [],
      extra: { promptOps: ops }, metadata: () => Effect.void, ask: () => Effect.void })
  }).pipe(Effect.provideService(Plugin.Service, host),
    Effect.provideService(RuntimeFlags.Service, { ...flags, experimentalBackgroundSubagents: true }), Effect.forkChild)
  const child = yield* awaitWithTimeout(Deferred.await(starting), "background startup hook never reached")
  stream.abort()
  yield* Deferred.succeed(release, undefined)
  expect(Exit.isFailure(yield* awaitWithTimeout(Fiber.await(execution), "startup abort failed to settle"))).toBe(true)
  expect(prompts).toEqual([])
  expect((yield* sessions.get(child)).metadata?.["opencode.task.terminal"]).toMatchObject({
    callID: "background-startup-abort", status: "cancelled", localQuiescence: true, remoteOutcome: "unknown",
  })
}))
