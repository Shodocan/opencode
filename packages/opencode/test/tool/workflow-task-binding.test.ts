import { afterEach, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { Plugin } from "../../src/plugin"
import { MessageID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppLayer } from "../../src/effect/app-runtime"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
for (const denied of [false, true]) {
  it.instance(`awaits workflow child binding ${denied ? "denied" : "accepted"}`, () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "workflow parent" })
    const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model: ref, time: { created: 1 },
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(), sessionID: parent.id, role: "assistant", parentID: user.id,
      agent: "build", mode: "build", ...ref, variant: "xhigh", cost: 0,
      path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const events: string[] = []
    const bindings: unknown[] = []
    const ops: TaskPromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.sync(() => { events.push("prompt"); return { info: user, parts: [] } }),
    }
    const host = Plugin.Service.of({
      init: () => Effect.void, list: () => Effect.succeed([]),
      trigger: (name, input, output) => Effect.gen(function* () {
        if (String(name) !== "task.execute.start") return output
        bindings.push(input)
        yield* Effect.promise(() => Promise.resolve())
        events.push("binding")
        if (denied) return yield* Effect.die(new Error("workflow lease binding denied"))
        return output
      }),
    })
    const result = yield* Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      return yield* def.execute({ description: "bind worker", prompt: "test", subagent_type: "general" }, {
        sessionID: parent.id, messageID: assistant.id, callID: "native-bound-call", agent: "build",
        abort: new AbortController().signal, messages: [], extra: { promptOps: ops },
        metadata: () => Effect.void, ask: () => Effect.void,
      })
    }).pipe(Effect.provideService(Plugin.Service, host), Effect.exit)
    expect(bindings).toHaveLength(1)
    const children = yield* sessions.children(parent.id)
    expect(children).toHaveLength(1)
    expect(bindings[0]).toMatchObject({ sessionID: parent.id, callID: "native-bound-call", childSessionID: children[0].id })
    expect(events).toEqual(denied ? ["binding"] : ["binding", "prompt"])
    expect(Exit.isSuccess(result)).toBe(!denied)
  }))
}
