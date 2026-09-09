import { afterEach, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { Plugin } from "../../src/plugin"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppLayer } from "../../src/effect/app-runtime"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

// Expected RED declared in docs/workflow-reliability-native-red.md before edits:
// Task reduces provider failures to text; no durable/native terminal record or
// awaited actual-terminal callback exists; an aborted binding may launch work.
afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
for (const mode of ["completed", "provider", "tool", "aborted-before", "aborted-binding", "terminal-hook-fails"] as const) {
  it.instance(`native workflow terminal evidence ${mode}`, () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "workflow terminal parent" })
    const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
    const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id, role: "user", agent: "build", model: ref, time: { created: 1 } })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(), sessionID: parent.id, role: "assistant", parentID: user.id,
      agent: "build", mode: "build", ...ref, variant: "xhigh", cost: 0,
      path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const controller = new AbortController()
    if (mode === "aborted-before") controller.abort()
    const metadata: Array<Record<string, unknown>> = []
    const terminal: Array<{input: unknown; output: unknown}> = []
    let prompts = 0
    const providerError = { name: "APIError" as const, data: { message: "quota", statusCode: 429, isRetryable: true, responseHeaders: { "retry-after": "1" } } }
    const ops: TaskPromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: (input) => Effect.sync(() => {
        prompts++
        const id = MessageID.ascending()
        return {
          info: { ...assistant, id, sessionID: input.sessionID, ...(mode === "provider" ? { error: providerError } : {}) },
          parts: mode === "tool" ? [{
            id: PartID.ascending(), sessionID: input.sessionID, messageID: id, type: "tool" as const,
            tool: "bash", callID: "failed-check", state: { status: "error" as const, input: {}, error: "test assertion failed", time: {start: 1,end: 2} },
          }] : [{id: PartID.ascending(), sessionID: input.sessionID, messageID: id, type: "text" as const, text: "sealed result"}],
        }
      }),
    }
    const host = Plugin.Service.of({
      init: () => Effect.void, list: () => Effect.succeed([]),
      trigger: (name, input, output) => Effect.gen(function* () {
        if (String(name) === "task.execute.start" && mode === "aborted-binding") controller.abort()
        if (String(name) === "task.execute.end") {
          terminal.push({input,output})
          if (mode === "terminal-hook-fails") return yield* Effect.die(new Error("terminal journal unavailable"))
        }
        return output
      }),
    })
    const result = yield* Effect.gen(function* () {
      const tool = yield* TaskTool
      const def = yield* tool.init()
      return yield* def.execute({description:"terminal worker",prompt:"test",subagent_type:"general"}, {
        sessionID:parent.id,messageID:assistant.id,callID:"native-terminal-call",agent:"build",
        abort:controller.signal,messages:[],extra:{promptOps:ops},
        metadata:(value)=>Effect.sync(()=>{metadata.push(value.metadata ?? {})}),ask:()=>Effect.void,
      })
    }).pipe(Effect.provideService(Plugin.Service,host),Effect.exit)
    const aborted = mode.startsWith("aborted")
    expect(prompts).toBe(aborted ? 0 : 1)
    expect(Exit.isSuccess(result)).toBe(mode === "completed")
    if (mode === "aborted-before") return // no child need be created before an already-aborted call
    const children = yield* sessions.children(parent.id)
    expect(children).toHaveLength(1)
    expect(terminal).toHaveLength(1)
    expect(terminal[0].input).toMatchObject({sessionID:parent.id,callID:"native-terminal-call",childSessionID:children[0].id})
    const status = aborted ? "cancelled" : mode === "provider" || mode === "tool" ? "failed" : "completed"
    expect(terminal[0].output).toMatchObject({status})
    const persisted = yield* sessions.get(children[0].id)
    expect(persisted.metadata?.["opencode.task.terminal"]).toMatchObject({
      version:1,parentSessionID:parent.id,callID:"native-terminal-call",childSessionID:children[0].id,
      status,localQuiescence:true,remoteOutcome:aborted ? "unknown" : "completed",
    })
    if (mode === "provider") {
      expect(terminal[0].output).toMatchObject({executionFailure:{kind:"provider",error:providerError}})
      expect(metadata.at(-1)).toMatchObject({executionFailure:{kind:"provider",error:providerError}})
    }
    if (mode === "tool") expect(terminal[0].output).toMatchObject({executionFailure:{kind:"tool"}})
    yield* sessions.setMetadata({sessionID:children[0].id,metadata:{"opencode.task.terminal":{status:"forged"},user_marker:"safe"}})
    const after = yield* sessions.get(children[0].id)
    expect(after.metadata?.["opencode.task.terminal"]).toEqual(persisted.metadata?.["opencode.task.terminal"])
    expect(after.metadata?.user_marker).toBe("safe")
  }))
}
