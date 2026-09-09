import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const parent = SessionID.make("ses_workflow_parent")
const call = "call-workflow-native"
const agent: Agent.Info = { name: "build", mode: "primary", options: {}, permission: [] }
const model = { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model

for (const mode of ["failed", "defect", "interrupted", "denied", "completed", "hook-failure"] as const) {
  const calls: Array<{ name: string; input: unknown; output: unknown }> = []
  let executions = 0
  const original = new Error("native provider failure")
  const layer = Layer.mergeAll(
    Layer.mock(Plugin.Service, {
      trigger: (name, input, output) => Effect.gen(function* () {
        calls.push({ name, input, output })
        if (name === "tool.execute.before" && mode === "denied") return yield* Effect.die(new Error("admission denied"))
        if (String(name) === "tool.execute.error" && mode === "hook-failure") return yield* Effect.die(new Error("terminal journal unavailable"))
        return output
      }),
    }),
    Layer.mock(Permission.Service, { ask: () => Effect.void }),
    Layer.mock(MCP.Service, { tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, { output: (text) => Effect.succeed({ content: text, truncated: false }) }),
    RuntimeFlags.layer(),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([{
        id: "task", description: "native task fixture", parameters: Schema.Struct({}),
        jsonSchema: { type: "object", properties: {} },
        execute: (_args, ctx) => Effect.gen(function* () {
          executions++
          yield* ctx.metadata({ metadata: { sessionId: "ses_workflow_child", marker: "native-only" } })
          if (mode === "completed") return { title: "done", metadata: { sessionId: "ses_workflow_child" }, output: "sealed" }
          if (mode === "interrupted") return yield* Effect.interrupt
          if (mode === "defect") return yield* Effect.die(original)
          return yield* Effect.fail(original)
        }).pipe(Effect.orDie),
      } satisfies Tool.Def]),
    }),
  )
  const it = testEffect(layer)
  it.effect(`native terminal callback ${mode}`, () => Effect.gen(function* () {
    const messageID = MessageID.ascending()
    let state: SessionV1.ToolPart = {
      id: PartID.ascending(), sessionID: parent, messageID, type: "tool", tool: "task", callID: call,
      state: { status: "running", input: {}, time: { start: 1 } },
    }
    const tools = yield* SessionTools.resolve({
      agent, model, session: { id: parent, permission: [] } as unknown as Session.Info,
      processor: {
        message: {
          id: messageID, sessionID: parent, role: "assistant", parentID: MessageID.ascending(),
          agent: "build", mode: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test"), time: { created: 1 },
        },
        updateToolCall: (_id, update) => Effect.sync(() => { state = update(state); return state }),
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false, messages: [], promptOps: {} as never,
    })
    const execute = tools.task.execute!
    const outcome = yield* Effect.promise(async () => {
      try { return { value: await execute({}, { toolCallId: call, abortSignal: new AbortController().signal, messages: [] }), error: undefined } }
      catch (error) { return { value: undefined, error: String(error) } }
    })
    expect(executions).toBe(mode === "denied" ? 0 : 1)
    expect(calls.filter((x) => x.name === "tool.execute.before")).toHaveLength(1)
    const errors = calls.filter((x) => x.name === "tool.execute.error")
    if (mode === "denied" || mode === "completed") {
      expect(errors).toHaveLength(0)
      expect(calls.filter((x) => x.name === "tool.execute.after")).toHaveLength(mode === "completed" ? 1 : 0)
      return
    }
    expect(errors).toHaveLength(1)
    expect(errors[0].input).toMatchObject({ tool: "task", sessionID: parent, callID: call, args: {} })
    expect(errors[0].output).toMatchObject({ metadata: { sessionId: "ses_workflow_child", marker: "native-only" } })
    expect(calls.filter((x) => x.name === "tool.execute.after")).toHaveLength(0)
    expect(outcome.error).toBeDefined()
    if (mode === "hook-failure") expect(outcome.error).toContain("terminal journal unavailable")
    if (mode === "failed" || mode === "defect") expect(outcome.error).toContain("native provider failure")
  }))
}
