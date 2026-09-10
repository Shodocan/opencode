import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { TaskTool, Parameters, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { BackgroundJob } from "../../src/background/job"
import { Plugin } from "../../src/plugin"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppLayer } from "../../src/effect/app-runtime"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

// Expectations declared in docs/workflow-reliability-gap-expected-red.md.
// Real TaskTool wrapper, scheduler and session registry; only provider work and
// the external plugin hook are controlled at their published boundaries.
afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const params = { description: "Gap regression", prompt: "Read only", subagent_type: "general" }

const seed = Effect.fn("WorkflowGap.seed")(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "native gap parent" })
  const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model: ref, time: { created: 1 } })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(), sessionID: parent.id, role: "assistant", parentID: user.id,
    agent: "build", mode: "build", ...ref, variant: "xhigh", cost: 0,
    path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return { parent, assistant }
})

function response(sessionID: SessionID): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: { id, sessionID, role: "user", agent: "general", model: ref, time: { created: 3 } },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text: "done" }],
  }
}

it.instance("child cancellation while awaited native start is pending prevents every later prompt", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const runState = yield* SessionRunState.Service
  const fixture = yield* seed()
  const ready = yield* Deferred.make<SessionID>()
  const release = yield* Deferred.make<void>()
  const prompts: SessionID[] = []
  const terminals: unknown[] = []
  const abort = new AbortController()
  const host = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]),
    trigger: (name, input, output) => Effect.gen(function* () {
      if (name === "task.execute.start") {
        yield* Deferred.succeed(ready, SessionID.make((input as { childSessionID: string }).childSessionID))
        yield* Deferred.await(release)
      }
      if (name === "task.execute.end") terminals.push(output)
      return output
    }),
  })
  const ops: TaskPromptOps = {
    cancel: runState.cancel,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: (input) => Effect.sync(() => { prompts.push(input.sessionID); return response(input.sessionID) }),
  }
  const execution = yield* Effect.gen(function* () {
    const tool = yield* TaskTool
    const def = yield* tool.init()
    return yield* def.execute(params, {
      sessionID: fixture.parent.id, messageID: fixture.assistant.id, callID: "binding-window",
      agent: "build", abort: abort.signal, messages: [], extra: { promptOps: ops },
      metadata: () => Effect.void, ask: () => Effect.void,
    })
  }).pipe(Effect.provideService(Plugin.Service, host), Effect.forkChild)
  const child = yield* awaitWithTimeout(Deferred.await(ready), "native start never reached")
  yield* runState.cancel(child)
  expect(abort.signal.aborted).toBe(false)
  yield* Deferred.succeed(release, undefined)
  const exit = yield* awaitWithTimeout(Fiber.await(execution), "cancelled binding never settled")
  expect(prompts).toEqual([])
  expect(Exit.isFailure(exit)).toBe(true)
  expect(terminals).toEqual([expect.objectContaining({ status: "cancelled", localQuiescence: true })])
  expect((yield* sessions.get(child)).metadata?.["opencode.task.terminal"]).toMatchObject({
    callID: "binding-window", status: "cancelled", localQuiescence: true, remoteOutcome: "unknown",
  })
}))

it.instance("queued Task continuation cancelled before its turn emits exactly one terminal callback", () => Effect.gen(function* () {
  const jobs = yield* BackgroundJob.Service
  const runState = yield* SessionRunState.Service
  const fixture = yield* seed()
  const ready = yield* Deferred.make<SessionID>()
  const prompts: string[] = []
  const terminals: Array<{ callID: string; output: unknown }> = []
  const host = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]),
    trigger: (name, input, output) => Effect.sync(() => {
      if (name === "task.execute.end") terminals.push({ callID: (input as { callID: string }).callID, output })
      return output
    }),
  })
  const ops: TaskPromptOps = {
    cancel: runState.cancel,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: (input) => Effect.gen(function* () {
      prompts.push(input.taskOrigin?.taskCallID ?? "missing")
      yield* Deferred.succeed(ready, input.sessionID)
      return yield* Effect.never
    }),
  }
  yield* Effect.gen(function* () {
    const tool = yield* TaskTool
    const def = yield* tool.init()
    const ctx = { sessionID: fixture.parent.id, messageID: fixture.assistant.id, agent: "build",
      abort: new AbortController().signal, messages: [], extra: { promptOps: ops },
      metadata: () => Effect.void, ask: () => Effect.void }
    const first = yield* def.execute(params, { ...ctx, callID: "queue-first" }).pipe(Effect.forkChild)
    const child = yield* awaitWithTimeout(Deferred.await(ready), "first Task did not start")
    const queued = yield* def.execute({ ...params, task_id: child }, { ...ctx, callID: "queue-second" })
    expect(queued.metadata.background).toBe(true)
    expect(prompts).toEqual(["queue-first"])
    yield* awaitWithTimeout(jobs.cancel(child), "queued cancellation finalizers deadlocked")
    expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
    expect(prompts).toEqual(["queue-first"])
    expect(terminals.map((entry) => entry.callID).sort()).toEqual(["queue-first", "queue-second"])
    for (const terminal of terminals) expect(terminal.output).toMatchObject({ status: "cancelled", localQuiescence: true })
  }).pipe(Effect.provideService(Plugin.Service, host))
}))

it.instance("malformed Task schema records provable no-launch metadata before wrapper rejection", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const fixture = yield* seed()
  const metadata: Array<Record<string, unknown>> = []
  const prompts: SessionID[] = []
  const ops: TaskPromptOps = { cancel: () => Effect.void, resolvePromptParts: () => Effect.succeed([]),
    prompt: (input) => Effect.sync(() => { prompts.push(input.sessionID); return response(input.sessionID) }) }
  const tool = yield* TaskTool
  const def = yield* tool.init()
  const invalid = { ...params, prompt: 17 } as unknown as Schema.Schema.Type<typeof Parameters>
  const exit = yield* def.execute(invalid, {
    sessionID: fixture.parent.id, messageID: fixture.assistant.id, callID: "invalid-schema",
    agent: "build", abort: new AbortController().signal, messages: [], extra: { promptOps: ops },
    metadata: (value) => Effect.sync(() => { metadata.push(value.metadata ?? {}) }), ask: () => Effect.void,
  }).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(prompts).toEqual([])
  expect(yield* sessions.children(fixture.parent.id)).toEqual([])
  expect(metadata.at(-1)).toMatchObject({ taskExecution: { started: false, localQuiescence: true } })
}))

it.instance("ordinary agent configured variant is present in awaited native admission and prompt", () => Effect.gen(function* () {
  const fixture = yield* seed()
  const bound: unknown[] = []
  const requested: unknown[] = []
  const host = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]),
    trigger: (name, input, output) => Effect.sync(() => { if (name === "task.execute.start") bound.push((input as { model: unknown }).model); return output }),
  })
  const ops: TaskPromptOps = { cancel: () => Effect.void, resolvePromptParts: () => Effect.succeed([]),
    prompt: (input) => Effect.sync(() => { requested.push({ model: input.model, variant: input.variant }); return response(input.sessionID) }) }
  yield* Effect.gen(function* () {
    const tool = yield* TaskTool
    const def = yield* tool.init()
    return yield* def.execute(params, {
      sessionID: fixture.parent.id, messageID: fixture.assistant.id, callID: "configured-variant",
      agent: "build", abort: new AbortController().signal, messages: [], extra: { promptOps: ops },
      metadata: () => Effect.void, ask: () => Effect.void,
    })
  }).pipe(Effect.provideService(Plugin.Service, host))
  expect(bound).toEqual([{ providerID: "offline", id: "review", variant: "max" }])
  expect(requested).toEqual([{ model: { providerID: "offline", modelID: "review" }, variant: "max" }])
}), { config: {
  agent: { general: { model: "offline/review", variant: "max" } },
  provider: { offline: { npm: "@ai-sdk/openai-compatible", models: { review: {
    name: "review", limit: { context: 32000, output: 2000 }, variants: { max: { reasoningEffort: "high" } },
  } } } },
} })

it.instance("continuation preserves creation origin and advances its additive terminal receipt", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const fixture = yield* seed()
  const ops: TaskPromptOps = { cancel: () => Effect.void, resolvePromptParts: () => Effect.succeed([]), prompt: (input) => Effect.succeed(response(input.sessionID)) }
  const tool = yield* TaskTool
  const def = yield* tool.init()
  const ctx = { sessionID: fixture.parent.id, messageID: fixture.assistant.id, agent: "build",
    abort: new AbortController().signal, messages: [], extra: { promptOps: ops }, metadata: () => Effect.void, ask: () => Effect.void }
  const first = yield* def.execute(params, { ...ctx, callID: "creation-call" })
  const child = yield* sessions.get(first.metadata.sessionId)
  expect(child.metadata?.["opencode.task.origin"]).toEqual({ version: 1, parentSessionID: fixture.parent.id, tool: "task", callID: "creation-call" })
  expect(child.metadata?.["opencode.task.terminal"]).toMatchObject({ callID: "creation-call", status: "completed", localQuiescence: true })
  yield* def.execute({ ...params, task_id: child.id }, { ...ctx, callID: "continuation-call" })
  const resumed = yield* sessions.get(child.id)
  expect(resumed.metadata?.["opencode.task.origin"]).toEqual(child.metadata?.["opencode.task.origin"])
  expect(resumed.metadata?.["opencode.task.terminal"]).toMatchObject({ callID: "continuation-call", status: "completed", localQuiescence: true })
}))

it.instance("parent abort reports failed Task plus cancelled receipt even when provider returns normally", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const fixture = yield* seed()
  const ready = yield* Deferred.make<SessionID>()
  const cancelled = yield* Deferred.make<void>()
  const abort = new AbortController()
  const ops: TaskPromptOps = {
    cancel: () => Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
    resolvePromptParts: () => Effect.succeed([]),
    prompt: (input) => Effect.gen(function* () {
      yield* Deferred.succeed(ready, input.sessionID)
      yield* Deferred.await(cancelled)
      return response(input.sessionID)
    }),
  }
  const tool = yield* TaskTool
  const def = yield* tool.init()
  const fiber = yield* def.execute(params, {
    sessionID: fixture.parent.id, messageID: fixture.assistant.id, callID: "abort-call",
    agent: "build", abort: abort.signal, messages: [], extra: { promptOps: ops }, metadata: () => Effect.void, ask: () => Effect.void,
  }).pipe(Effect.forkChild)
  const child = yield* awaitWithTimeout(Deferred.await(ready), "Task never started")
  abort.abort()
  const exit = yield* awaitWithTimeout(Fiber.await(fiber), "abort did not settle Task")
  expect(Exit.isFailure(exit)).toBe(true)
  expect((yield* sessions.get(child)).metadata?.["opencode.task.terminal"]).toMatchObject({ callID: "abort-call", status: "cancelled", localQuiescence: true })
}))
