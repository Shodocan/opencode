import { afterEach, expect } from "bun:test"
import { Deferred, Effect } from "effect"
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

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
function response(sessionID: SessionID): SessionV1.WithParts {
  const messageID = MessageID.ascending()
  return { info: { id: messageID, sessionID, role: "user", agent: "general", model, time: { created: 3 } },
    parts: [{ id: PartID.ascending(), messageID, sessionID, type: "text", text: "Completed bounded task." }] }
}

for (const background of [false, true]) {
  it.instance(`native Task explicitly requests quiescence before ${background ? "notifying the parent" : "returning foreground completion"}`, () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service
    const flags = yield* RuntimeFlags.Service
    const parent = yield* sessions.create({ title: "explicit wait fixture" })
    const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model, time: { created: 1 } })
    const assistant = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "assistant", parentID: user.id,
      agent: "build", mode: "build", ...model, cost: 0, path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    const waits: { id: string; quiescent?: boolean }[] = []
    const observed = BackgroundJob.Service.of({ ...jobs, wait: input => {
      waits.push(input)
      return jobs.wait(input)
    } })
    const notified = yield* Deferred.make<void>()
    const hooks = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]), trigger: (_name, _input, output) => Effect.succeed(output) })
    const ops: TaskPromptOps = { cancel: runState.cancel, resolvePromptParts: () => Effect.succeed([]), prompt: input => input.sessionID === parent.id
      ? Deferred.succeed(notified, undefined).pipe(Effect.as(response(input.sessionID))) : Effect.succeed(response(input.sessionID)) }
    yield* Effect.gen(function* () {
      const task = yield* TaskTool
      const definition = yield* task.init()
      const result = yield* definition.execute({ description: "Explicit quiescence", prompt: "Read only.", subagent_type: "general", background },
        { sessionID: parent.id, messageID: assistant.id, callID: "quiescent-wait-call", agent: "build", abort: new AbortController().signal,
          messages: [], extra: { promptOps: ops }, metadata: () => Effect.void, ask: () => Effect.void })
      if (background) {
        expect(result.metadata.background).toBe(true)
        yield* awaitWithTimeout(Deferred.await(notified), "background completion never notified parent")
      }
      expect(waits.length).toBeGreaterThan(0)
      expect(waits.every(input => input.quiescent === true), "every native completion wait must explicitly require local cleanup").toBe(true)
    }).pipe(Effect.provideService(BackgroundJob.Service, observed), Effect.provideService(Plugin.Service, hooks),
      Effect.provideService(RuntimeFlags.Service, { ...flags, experimentalBackgroundSubagents: true }))
  }))
}
