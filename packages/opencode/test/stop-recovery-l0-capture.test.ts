import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionProcessor } from "@/session/processor"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "./fixture/fixture"
import { testEffect } from "./lib/effect"
import { TestLLMServer } from "./lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"

// FORK FEATURE (9) stop-recovery — L0 per-field delivery capture test.
//
// Exercises the actual production Provider SDK resolution path: a local
// dynamic-port TestLLMServer captures the real @ai-sdk/openai-compatible
// request, and we assert each L0 field arrives verbatim in the outgoing
// JSON body. This replaces the copied collectExtraBody / fetch mirror tests
// with assertions that traverse production resolveSDK().
//
// The production gate in provider.ts resolveSDK() is:
//   model.api.npm.includes("@ai-sdk/openai-compatible")
// Only models whose npm string contains that prefix get the extraBody
// fetch wrapper. Hosted / non-compatible providers do not.

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

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function findChatInput(inputs: readonly Record<string, unknown>[]) {
  return inputs.find((body) => {
    if (body.model !== ref.modelID || !Array.isArray(body.messages)) return false
    return body.messages.some((message) => {
      if (!message || typeof message !== "object" || Reflect.get(message, "role") !== "user") return false
      return containsText(Reflect.get(message, "content"), "hi")
    })
  })
}

function containsText(input: unknown, expected: string): boolean {
  if (input === expected) return true
  if (Array.isArray(input)) return input.some((item) => containsText(item, expected))
  if (!input || typeof input !== "object") return false
  return Object.values(input).some((item) => containsText(item, expected))
}

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
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

// ---------------------------------------------------------------------------
// Provider configs — extra body keys live in model.options so that
// production resolveSDK() -> collectExtraBody(model.options) picks them up.
// ---------------------------------------------------------------------------

function extraBodyConfig(baseURL: string) {
  return {
    provider: {
      test: {
        name: "Test vLLM",
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
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {
              min_p: 0.05,
              top_k: 50,
              thinking_token_budget: 4096,
              repetition_detection: {
                min_pattern_size: 1,
                max_pattern_size: 40,
                min_count: 4,
              },
              extraBody: {
                custom_extra_field: "fork-tripwire",
              },
            },
          },
        },
        options: { apiKey: "test-key", baseURL },
      },
    },
  }
}

function nonCompatibleConfig(baseURL: string) {
  return {
    provider: {
      test: {
        name: "Test OpenAI",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {
              min_p: 0.05,
              top_k: 50,
              thinking_token_budget: 4096,
              repetition_detection: {
                min_pattern_size: 1,
                max_pattern_size: 40,
                min_count: 4,
              },
              extraBody: {
                custom_extra_field: "fork-tripwire",
              },
            },
          },
        },
        options: { apiKey: "test-key", baseURL },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const msg = {
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "build" as const,
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
    finish: "end_turn" as const,
  }
  yield* session.updateMessage(msg)
  return msg
})

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests — production SDK resolution path
// ---------------------------------------------------------------------------

describe("L0 extra-body delivery through production Provider SDK resolution", () => {
  it.live("recognized vLLM keys reach outgoing OpenAI-compatible request body", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          yield* llm.text("ok")

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hi")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user" as const,
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            },
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user" as const, content: "hi" }],
            tools: {},
          }

          yield* handle.process(input)
          yield* llm.wait(1)

          const inputs = yield* llm.inputs
          // Select the user chat request independently from the fields under test.
          const body = findChatInput(inputs)

          expect(body).toBeDefined()
          // Recognized vLLM keys — delivered by production collectExtraBody +
          // resolveSDK fetch wrapper:
          expect(body?.min_p).toBe(0.05)
          expect(body?.top_k).toBe(50)
          expect(body?.thinking_token_budget).toBe(4096)
          expect(body?.repetition_detection).toEqual({
            min_pattern_size: 1,
            max_pattern_size: 40,
            min_count: 4,
          })
        }),
      { config: (url) => extraBodyConfig(url) },
    ),
  )

  it.live("caller-supplied extraBody record reaches outgoing request body", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          yield* llm.text("ok")

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hi")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user" as const,
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            },
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user" as const, content: "hi" }],
            tools: {},
          }

          yield* handle.process(input)
          yield* llm.wait(1)

          const inputs = yield* llm.inputs
          const body = findChatInput(inputs)

          expect(body).toBeDefined()
          // Caller-supplied extraBody record — merged by production
          // collectExtraBody into the outgoing request:
          expect(body?.custom_extra_field).toBe("fork-tripwire")
        }),
      { config: (url) => extraBodyConfig(url) },
    ),
  )

  it.live("non-compatible provider npm bypasses extra-body fetch wrapper", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          yield* llm.text("ok")

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hi")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user" as const,
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            },
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user" as const, content: "hi" }],
            tools: {},
          }

          yield* handle.process(input)
          yield* llm.wait(1)

          const inputs = yield* llm.inputs
          // For a non-compatible provider (npm: "@ai-sdk/openai"), the
          // production resolveSDK gate
          //   model.api.npm.includes("@ai-sdk/openai-compatible")
          // evaluates to false, so NO extraBody fetch wrapper is installed.
          // The model.options keys MUST NOT appear in the outgoing request.
          expect(inputs.length).toBeGreaterThan(0)
          for (const body of inputs) {
            expect(body.min_p).toBeUndefined()
            expect(body.top_k).toBeUndefined()
            expect(body.thinking_token_budget).toBeUndefined()
            expect(body.repetition_detection).toBeUndefined()
            expect(body.custom_extra_field).toBeUndefined()
          }
        }),
      { config: (url) => nonCompatibleConfig(url) },
    ),
  )
})
