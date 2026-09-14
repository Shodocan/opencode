import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { createHash } from "node:crypto"
import { LLMAISDK } from "@/session/llm/ai-sdk"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})


// In normal N tests this is the existing synthetic proxy-verified adapter seam.
// Set both HARNESS_ROUTE_ROOT and HARNESS_ROUTE_PYTHON to run the same assertions
// with the current H source signer and its real HMAC-verifying callback.
const modes = ["valid", "invalid", "missing", ...(process.env.HARNESS_ROUTE_ROOT ? ["bad_signature"] : [])]
for (const mode of modes) {
  const stream = Layer.succeed(LLM.Service, LLM.Service.of({
    stream: input => Stream.unwrap(Effect.gen(function* () {
      const nonce = "1".repeat(32)
      const headers: Record<string, string> = yield* Effect.promise(async () => {
        if (process.env.HARNESS_ROUTE_ROOT) {
          const child = Bun.spawn([process.env.HARNESS_ROUTE_PYTHON ?? "python3",
            path.join(import.meta.dir, "../fixture/harness-route-receipt.py")], {
            stdin: new Blob([JSON.stringify({ session: input.sessionID, mode })]), stdout: "pipe", stderr: "pipe",
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
          })
          const [text, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
          if (exit !== 0) throw new Error(`Contained H signer failed: ${error}`)
          return JSON.parse(text) as Record<string, string>
        }
        const receipt = { v: 2, nonce: mode === "invalid" ? "4".repeat(32) : nonce,
          session_sha256: createHash("sha256").update(input.sessionID).digest("hex"), target: "grok", model: "grok-4.6",
          observation_id: "2".repeat(32), effort: "xhigh", requested_model: "glm-5.3", requested_effort: "high",
          generation: 7, selection_reason: "availability" }
        return mode === "missing" ? {} : { "x-opencode-route-attestation":
          `${Buffer.from(JSON.stringify(receipt, Object.keys(receipt).sort())).toString("base64url")}.${"3".repeat(64)}` }
      })
      expect(Object.keys(headers).length).toBe(mode === "valid" ? 1 : process.env.HARNESS_ROUTE_ROOT || mode === "missing" ? 0 : 1)
      const adapted = yield* LLMAISDK.toLLMEvents(LLMAISDK.adapterState({
        providerID: "opencode-route", nonce, sessionID: input.sessionID,
      }), { type: "finish-step", response: { id: "synthetic", timestamp: new Date(0), modelId: "provider-unverified-name", headers },
        finishReason: "stop", rawFinishReason: "stop", usage: { inputTokens: 10, outputTokens: 4 } } as Parameters<typeof LLMAISDK.toLLMEvents>[1])
      return Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), ...adapted, LLMEvent.finish({ reason: "stop" })])
    })),
  }))
  const it = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, stream]]))
  it.live(`processor persists request-bound v2 provenance: ${mode}`, () => provideTmpdirInstance(dir => Effect.gen(function* () {
    const { processors, session, provider } = yield* boot()
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "synthetic receipt accounting")
    const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
    const mdl = { ...(yield* provider.getModel(ref.providerID, ref.modelID)), providerID: ProviderV2.ID.make("opencode-route"), id: ModelV2.ID.make("glm-5.3") }
    msg.variant = "high"
    msg.providerID = mdl.providerID
    msg.modelID = mdl.id
    yield* session.updateMessage(msg)
    const request = { provider: msg.providerID, model: msg.modelID, effort: msg.variant }
    const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
    const result = yield* handle.process({ user: parent, sessionID: chat.id, model: mdl, agent: agent(), system: [],
      messages: [{ role: "user", content: "synthetic receipt accounting" }], tools: {} })
    expect(result).toBe("continue")
    const parts = yield* MessageV2.parts(msg.id)
    const finishes = parts.filter((part): part is SessionV1.StepFinishPart => part.type === "step-finish")
    expect(finishes).toHaveLength(1)
    const finish = finishes[0]
    expect(finish.inference?.requested).toEqual({ provider_id: "opencode-route", model_id: "glm-5.3", effort: "high" })
    expect(finish.inference?.response).toEqual({ model_id: "provider-unverified-name", source: "transport_response", upstream_actual_identity: "unknown" })
    expect(finish.inference?.cost).toEqual({ amount: finish.cost, semantics: "configured_rate_estimate", actual_bill: "unknown" })
    expect(finish.inference?.usage).toMatchObject({ input_tokens: 10, output_tokens: 4 })
    expect({ provider: msg.providerID, model: msg.modelID, effort: msg.variant }).toEqual(request)
    if (mode === "valid") expect(finish.inference?.transport_route).toEqual({ source: "managed_gateway_attestation",
      provider: "grok", model: "grok-4.6", effort: "xhigh", observation_id: "2".repeat(32), receipt_version: 2,
      requested_model: "glm-5.3", requested_effort: "high", generation: 7, selection_reason: "availability" })
    else expect(finish.inference?.transport_route).toBeUndefined()
    // A fresh public storage read must retain the sealed projection exactly.
    expect((yield* MessageV2.parts(msg.id)).find(part => part.type === "step-finish")).toEqual(finish)
  }), { config: cfg }))
}
