import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { TaskTool } from "../../src/tool/task"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { SessionSummary } from "../../src/session/summary"
import { BackgroundJob } from "../../src/background/job"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { MessageID } from "../../src/session/schema"
import { TestLLMServer, httpError, reply } from "../lib/llm-server"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"

afterEach(disposeAllInstances)

// Count actual HTTP at the provider boundary; Task, both transport adapters and
// the session retry loop remain real. Auxiliary summary work is outside scope.
const summary = Layer.succeed(SessionSummary.Service, SessionSummary.Service.of({
  summarize: () => Effect.void, diff: () => Effect.succeed([]), computeDiff: () => Effect.succeed([]),
}))
const model = { providerID: ProviderV2.ID.make("retry-test"), modelID: ModelV2.ID.make("workflow-child") }

for (const native of [false, true]) {
  const it = testEffect(AppNodeBuilderV1.build(LayerNode.group([
    SessionPrompt.node, Session.node, SessionRunState.node, BackgroundJob.node, ToolRegistry.node,
    Agent.node, Config.node, Provider.node, Database.node, Plugin.node, RuntimeFlags.node, CrossSpawnSpawner.node,
    Truncate.node,
    SessionProjector.node, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
  ]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: native })],
    [SessionSummary.node, summary],
  ]))

  for (const managed of [true, false]) {
    it.live(`${native ? "native" : "SDK"} HTTP retry budget: ${managed ? "managed Task sends once" : "ordinary Task retains retries"}`, () =>
      provideTmpdirServer(({ llm }) => Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const parent = yield* sessions.create({ title: "retry parent" })
        const user = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id,
          role: "user", agent: "build", model, time: { created: 1 } })
        const assistant = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: parent.id,
          role: "assistant", parentID: user.id, agent: "build", mode: "build", ...model,
          cost: 0, path: { cwd: "/tmp", root: "/tmp" }, time: { created: 2 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
        yield* llm.pushMatch((hit) => hit.body.model === "workflow-child",
          httpError(429, { error: { message: "rate limit", type: "rate_limit_error", code: "rate_limit_exceeded" } }),
          reply().text("retry succeeded").stop())
        const terminals: unknown[] = []
        const host = Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]),
          trigger: (name, _input, output) => Effect.sync(() => {
            if (name === "task.execute.start" && managed) return { ...output, managedRetry: true }
            if (name === "task.execute.end") terminals.push(output)
            return output
          }),
        })
        const exit = yield* Effect.gen(function* () {
          const tool = yield* TaskTool
          const def = yield* tool.init()
          return yield* def.execute({ description: "retry child", prompt: "Respond once", subagent_type: "general",
            model: { providerID: model.providerID, id: model.modelID } }, {
            sessionID: parent.id, messageID: assistant.id, callID: `retry-${native}-${managed}`,
            agent: "build", abort: new AbortController().signal, messages: [], extra: { promptOps: prompt },
            metadata: () => Effect.void, ask: () => Effect.void,
          })
        }).pipe(Effect.provideService(Plugin.Service, host), Effect.exit)
        const hits = (yield* llm.hits).filter((hit) => hit.body.model === "workflow-child")
        if (hits.length === 0 && Exit.isFailure(exit)) throw new Error(`Provider fixture was never reached: ${Cause.pretty(exit.cause)}`)
        expect(hits.length).toBe(managed ? 1 : 2)
        expect(Exit.isFailure(exit)).toBe(managed)
        expect(terminals).toEqual([expect.objectContaining({
          status: managed ? "failed" : "completed", localQuiescence: true,
          ...(managed ? { executionFailure: { kind: "provider", error: expect.objectContaining({ name: "APIError" }) } } : {}),
        })])
      }), { config: (url) => ({
        model: "retry-test/workflow-child", small_model: "retry-test/auxiliary",
        provider: { "retry-test": { npm: "@ai-sdk/openai-compatible", options: { baseURL: url, apiKey: "local-test" },
          models: {
            "workflow-child": { name: "workflow child", limit: { context: 100000, output: 2000 }, tool_call: true },
            auxiliary: { name: "auxiliary", limit: { context: 100000, output: 2000 }, tool_call: true },
          },
        } },
      }) }), 30000)
  }
}
