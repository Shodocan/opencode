import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Exit } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// Every LLM call must go out as a streaming request. Agent.generate (the
// `opencode agent create` path) used a non-stream generateObject call.
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Plugin.node,
      Provider.node,
      Auth.node,
      Config.node,
      Skill.node,
      RuntimeFlags.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const generated = { identifier: "ping-responder", whenToUse: "Use to get PONG.", systemPrompt: "Reply PONG." }
const full = JSON.stringify(generated)
const cut = full.slice(0, 30)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const generate = Agent.Service.use((svc) => svc.generate({ description: "an agent that replies PONG", model }))
const chunk = (delta: Record<string, unknown>) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta }],
})
const config = { config: (url: string) => testProviderConfig(url) }

it.live("Agent.generate sends a streaming request and returns the collected object", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        yield* llm.text(full)
        const result = yield* generate
        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(1)
        expect(inputs[0].stream).toBe(true)
        expect(result).toEqual(generated)
      }),
    config,
  ),
)

it.live("a stream cut before its finish is retried", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().text(cut))
        yield* llm.text(full)
        expect(yield* generate).toEqual(generated)
        expect(yield* llm.calls).toBe(2)
      }),
    config,
  ),
)

it.live("a mid-stream error event is retried", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        yield* llm.push(
          raw({ head: [chunk({ role: "assistant", content: cut })], tail: [{ error: { message: "boom" } }] }),
        )
        yield* llm.text(full)
        expect(yield* generate).toEqual(generated)
        expect(yield* llm.calls).toBe(2)
      }),
    config,
  ),
)

it.live("a body that keeps breaking fails after two retries", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().text(cut), reply().text(cut), reply().text(cut), reply().text(full).stop())
        const exit = yield* generate.pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* llm.calls).toBe(3)
      }),
    config,
  ),
)

it.live("a complete response that fails the schema is not retried", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        yield* llm.text(JSON.stringify({ identifier: "x" }))
        yield* llm.text(full)
        const exit = yield* generate.pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* llm.calls).toBe(1)
      }),
    config,
  ),
)
