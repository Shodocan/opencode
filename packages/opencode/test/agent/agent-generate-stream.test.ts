import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
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

it.live("Agent.generate sends a streaming request and returns the collected object", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const generated = { identifier: "ping-responder", whenToUse: "Use to get PONG.", systemPrompt: "Reply PONG." }
        yield* llm.text(JSON.stringify(generated))
        const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
        const result = yield* Agent.Service.use((svc) =>
          svc.generate({ description: "an agent that replies PONG", model }),
        )
        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(1)
        expect(inputs[0].stream).toBe(true)
        expect(result).toEqual(generated)
      }),
    { config: (url) => testProviderConfig(url) },
  ),
)
