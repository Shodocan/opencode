/**
 * T04 acceptance tests - exact final-payload gate and native/AI SDK parity.
 *
 * The accepted test challenge corrected the original oracle as follows:
 * - native golden requests are compiled with LLMClient.prepare before compare;
 * - AI SDK golden, rejection, and compaction cases use the production LLM.Service;
 * - native rejection uses a native-capable provider with small limits;
 * - the small-route budget is 7,424 and the oversized fixture is 300,000 chars;
 * - tool results use the canonical @opencode-ai/llm ToolResultValue shape; and
 * - retry arithmetic is tested as route-local evaluation, not as an unobservable
 *   retry implementation.
 *
 * Expected RED is behavioral: the current production tree has no final
 * ContextBudget admission gate, no compaction output clamp at the outgoing
 * seams. Golden lowering, tool execution, and pure budget arithmetic must
 * remain green. The invocation-local route/hash ledger is deferred: the
 * current LLM.Service exposes no retry seam, so a cross-call assertion would
 * invent service-global state rather than test one invocation.
 */

import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent, LLMRequest, type LLMError } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLM } from "../../src/session/llm"
import { LLMRequestPrep } from "../../src/session/llm/request"
import * as Overflow from "../../src/session/overflow"
import goldenFixture from "../fixtures/context-budget/native-golden-request.json"
import aiSdkFixture from "../fixtures/context-budget/ai-sdk-golden-options.json"
import admissionFixture from "../fixtures/context-budget/admission-cases.json"
import { TestConfig } from "../fixture/config"
import z from "zod"
import { Schema } from "effect"

// --- Frozen fixtures ---------------------------------------------------------

const golden = goldenFixture as {
  inputs: {
    model: {
      id: string
      providerID: string
      api: { id: string; url: string; npm: string }
      limit: Provider.Model["limit"]
    }
    agent: { name: string; prompt: string }
    user: { id: string; sessionID: string }
    system: string[]
    messages: ModelMessage[]
    tools: Record<string, { description: string; inputSchema: unknown }>
    toolChoice: "auto"
    apiKey: string
    outputTokenMax: number
    modelOutputLimit: number
  }
  native: { route: string; protocol: string; body: Record<string, unknown> }
  budget: { phase: string; projectionEstimate: number; outputAllowanceNormal: number }
}

const goldenAiSdk = aiSdkFixture as unknown as {
  inputs: typeof golden.inputs
  aiSdk: {
    prompt: Array<Record<string, unknown>>
    tools: Array<{ type: string; name: string; description: string; inputSchema: unknown }>
    toolChoice: { type: string }
    temperature: number | null
    topP: number | null
    maxOutputTokens: number
    providerOptions: Record<string, unknown> | null
  }
  budget: { phase: string; projectionEstimate: number; outputAllowanceNormal: number }
}

const cases = admissionFixture as {
  constants: { GROWTH_HEADROOM: number; SAFETY_MARGIN: number; HEADROOM: number; DEFAULT_RESERVED: number }
  requests: {
    normal: { system: string[]; messagesUserText: string }
    oversized: { oversizedSystemChars: number }
    compaction: { agentName: string }
  }
  routes: Array<{
    qualifier: { providerID: string; modelID: string }
    model: {
      id: string
      providerID: string
      api: { id: string; url: string; npm: string }
      limit: Provider.Model["limit"]
    }
  }>
  nativeRoutes: Array<{
    qualifier: { providerID: string; modelID: string }
    model: {
      id: string
      providerID: string
      api: { id: string; url: string; npm: string }
      limit: Provider.Model["limit"]
    }
  }>
  expectations: {
    normalSmall: { admitted: boolean; budget: number }
    normalLarge: { admitted: boolean; budget: number }
    oversizedSmall: { admitted: boolean; expectedError: string; expectedZeroCalls: string[] }
    oversizedLarge: { admitted: boolean }
  }
}

// --- Direct preparation helpers used only for the frozen T02 projection pin -

function fixtureModel(f: typeof golden.inputs): Provider.Model {
  return testModel({
    providerID: f.model.providerID,
    modelID: f.model.id,
    url: f.model.api.url,
    context: f.model.limit.context,
    input: (f.model.limit as any).input,
    output: f.model.limit.output as number,
  })
}

function routeModel(route: (typeof cases.routes)[number], context?: number): Provider.Model {
  return testModel({
    providerID: route.model.providerID,
    modelID: route.model.id,
    url: route.model.api.url,
    context: context ?? route.model.limit.context,
    input: (route.model.limit as any).input,
    output: route.model.limit.output as number,
  })
}

function nativeRouteModel(route: (typeof cases.nativeRoutes)[number]): Provider.Model {
  return testModel({
    providerID: route.model.providerID,
    modelID: route.model.id,
    url: route.model.api.url,
    context: route.model.limit.context,
    input: (route.model.limit as any).input,
    output: route.model.limit.output as number,
  })
}

function testModel(opts: {
  providerID: string
  modelID: string
  url: string
  context: number
  input?: number
  output: number
}): Provider.Model {
  return {
    id: opts.modelID,
    providerID: opts.providerID,
    api: { id: opts.modelID, url: opts.url, npm: "@ai-sdk/openai-compatible" },
    name: "Test Model",
    capabilities: {
      toolcall: true,
      attachment: true,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: opts.context, input: opts.input, output: opts.output },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } as Provider.Model
}

function cfg(compaction?: ConfigV1.Info["compaction"]): ConfigV1.Info {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return compaction === undefined ? base : { ...base, compaction }
}

const pluginPass = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as never

const deployTool = () =>
  tool({
    description: "Deploy the service",
    inputSchema: z.object({ env: z.string(), region: z.string() }),
    execute: async () => ({ output: "ok" }),
  })

const goldenMessages = (userText: string): ModelMessage[] => [
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call-77", toolName: "deploy", input: { env: "prod" } }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-77",
        toolName: "deploy",
        output: { type: "text", value: "RESULT-PAYLOAD-MARKER" },
      },
    ],
  } as ModelMessage,
  { role: "user", content: userText },
]

function prepareInput(opts: {
  model: Provider.Model
  sessionID: string
  system?: string[]
  messages?: ModelMessage[]
  tools?: Record<string, Tool>
  agentName?: string
}) {
  return {
    user: {
      id: "msg_user-t04",
      sessionID: opts.sessionID,
      role: "user",
      time: { created: 0 },
      agent: opts.agentName ?? "build",
      model: { providerID: opts.model.providerID, modelID: opts.model.id },
    } as SessionV1.User,
    sessionID: opts.sessionID,
    model: opts.model,
    agent: {
      name: opts.agentName ?? "build",
      mode: "primary",
      prompt: opts.agentName === "compaction" ? "COMPACT-SUMMARY-MARKER" : "ANSWER-CONCISELY-MARKER",
      options: {},
      permission: [],
    } as never,
    system: opts.system ?? [...golden.inputs.system],
    messages: opts.messages ?? goldenMessages("CURRENT-INPUT-MARKER"),
    tools: opts.tools ?? { deploy: deployTool() },
    provider: { id: opts.model.providerID, options: { apiKey: golden.inputs.apiKey } } as unknown as Provider.Info,
    auth: undefined,
    plugin: pluginPass,
    flags: { outputTokenMax: golden.inputs.outputTokenMax, client: "test" } as never,
    isWorkflow: false,
  } as never
}

type Prepared = {
  budgetProjection: {
    system: string[]
    messages: Array<{ role: string; content: unknown }>
    tools: Record<string, { name: string; description: string; inputSchema: unknown }>
    options: Record<string, unknown>
    outputAllowance: number
  }
}

const prep = (opts: Parameters<typeof prepareInput>[0]) =>
  Effect.runPromise(LLMRequestPrep.prepare(prepareInput(opts))) as Promise<Prepared>

// --- Production LLM.Service harness -----------------------------------------

type ClientHarness = {
  layer: Layer.Layer<import("@opencode-ai/llm/route").LLMClientService>
  calls: () => number
  lastRequest: () => LLMRequest | undefined
}

function clientHarness(handler?: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>): ClientHarness {
  let calls = 0
  let lastRequest: LLMRequest | undefined
  return {
    layer: Layer.succeed(
      LLMClient.Service,
      LLMClient.Service.of({
        prepare: () => Effect.die(new Error("service prepare is not the tested native seam")),
        stream: (request) => {
          calls++
          lastRequest = request
          return handler?.(request) ?? Stream.empty
        },
        generate: () => Effect.die(new Error("unused")),
      }),
    ),
    calls: () => calls,
    lastRequest: () => lastRequest,
  }
}

function terminalModel(modelID: string, onStream?: (options: Record<string, unknown>) => void) {
  return {
    specificationVersion: "v3" as const,
    provider: "t04.fake",
    modelId: modelID,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unused")
    },
    doStream: async (options: Record<string, unknown>) => {
      onStream?.(options)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
      }
    },
  }
}

function providerLayer(model: Provider.Model, language: unknown, apiKey = "test-key") {
  const info: Provider.Info = {
    id: model.providerID,
    name: "Test Provider",
    source: "config",
    env: [],
    options: { apiKey },
    models: { [model.id]: model },
  }
  return Layer.succeed(
    Provider.Service,
    Provider.Service.of({
      list: () => Effect.succeed({ [info.id]: info }),
      getProvider: (providerID) =>
        providerID === info.id ? Effect.succeed(info) : Effect.die(new Error(`unknown provider: ${providerID}`)),
      getModel: () => Effect.succeed(model),
      getLanguage: () => Effect.succeed(language as never),
      closest: () => Effect.succeed(undefined),
      getSmallModel: () => Effect.succeed(undefined),
      defaultModel: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
    }),
  )
}

const authNoneLayer = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

const pluginPassLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: (_name, _input, output) => Effect.succeed(output),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }),
)

function configLayer(compaction?: ConfigV1.Info["compaction"]) {
  const value = cfg(compaction)
  return TestConfig.layer({
    get: () => Effect.succeed(value),
    getGlobal: () => Effect.succeed(value),
  })
}

function llmHarness(opts: {
  model: Provider.Model
  client: ClientHarness
  native: boolean
  compaction?: ConfigV1.Info["compaction"]
  language?: unknown
}) {
  const language = opts.language ?? terminalModel(opts.model.api.id)
  return LayerNode.compile(LLM.node, [
    [Auth.node, authNoneLayer],
    [Config.node, configLayer(opts.compaction)],
    [Provider.node, providerLayer(opts.model, language)],
    [Plugin.node, pluginPassLayer],
    [llmClient, opts.client.layer],
    [
      RuntimeFlags.node,
      RuntimeFlags.layer({
        experimentalNativeLlm: opts.native,
        outputTokenMax: golden.inputs.outputTokenMax,
        client: "test",
      }),
    ],
  ] as const)
}

function serviceInput(opts: {
  model: Provider.Model
  sessionID: string
  system?: string[]
  messages?: ModelMessage[]
  tools?: Record<string, Tool>
  agentName?: string
  userID?: string
}): LLM.StreamInput {
  const agentName = opts.agentName ?? "build"
  return {
    user: {
      id: opts.userID ?? `msg_user-${opts.sessionID}`,
      sessionID: opts.sessionID,
      role: "user",
      time: { created: 0 },
      agent: agentName,
      model: { providerID: opts.model.providerID, modelID: opts.model.id },
    } as SessionV1.User,
    sessionID: opts.sessionID,
    model: opts.model,
    agent: {
      name: agentName,
      mode: "primary",
      prompt: agentName === "compaction" ? "COMPACT-SUMMARY-MARKER" : "ANSWER-CONCISELY-MARKER",
      options: {},
      permission: [],
    } as never,
    system: opts.system ?? [...golden.inputs.system],
    messages: opts.messages ?? goldenMessages("CURRENT-INPUT-MARKER"),
    tools: opts.tools ?? { deploy: deployTool() },
    toolChoice: "auto",
  }
}

async function runService(env: Layer.Layer<LLM.Service>, input: LLM.StreamInput) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* LLM.Service
      return yield* service.stream(input).pipe(Stream.runCollect, Effect.exit)
    }).pipe(Effect.provide(env)),
  )
}

function failureOf(exit: unknown): unknown {
  if (!Exit.isFailure(exit as Exit.Exit<unknown, unknown>)) return undefined
  return Cause.squash((exit as Exit.Exit<unknown, unknown> & { cause: Cause.Cause<unknown> }).cause)
}

function evaluate(opts: {
  model: Provider.Model
  estimate: number
  outputTokens?: number
  compaction?: ConfigV1.Info["compaction"]
}) {
  return Overflow.ContextBudget.evaluate({
    model: opts.model,
    cfg: cfg(opts.compaction),
    estimate: opts.estimate,
    phase: "normal",
    outputTokens: opts.outputTokens,
  })
}

const oversizedSystem = () => [
  cases.requests.normal.system[0]!,
  "D".repeat(cases.requests.oversized.oversizedSystemChars),
]
const oversizedSessionID = "session-t04-oversized-common"

// --- 1. Native seam: production LLM.Service plus compiled request golden ----

describe("T04 native seam - exact compiled payload handed to llmClient.stream", () => {
  test("admitted dispatch matches the native golden after LLMClient.prepare", async () => {
    const model = fixtureModel(golden.inputs)
    const client = clientHarness()
    const env = llmHarness({ model, client, native: true })
    const exit = await runService(
      env,
      serviceInput({
        model,
        sessionID: golden.inputs.user.sessionID,
        userID: golden.inputs.user.id,
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(client.calls()).toBe(1)
    const captured = client.lastRequest()
    expect(captured).toBeDefined()
    if (!captured) throw new Error("native request was not captured")

    // The native seam captures LLMRequest, not the provider body. Compile the
    // captured request through the same route compiler used before transport.
    const prepared = await Effect.runPromise(LLMClient.prepare(captured))
    expect(prepared).toMatchObject({
      route: golden.native.route,
      protocol: golden.native.protocol,
    })
    expect(prepared.body).toEqual(golden.native.body)
  })

  test("executable tools remain attached and execute through the native ToolRuntime", async () => {
    const model = fixtureModel(golden.inputs)
    const client = clientHarness(() =>
      Stream.make(LLMEvent.toolCall({ id: "call-77", name: "deploy", input: { env: "prod", region: "eu" } })),
    )
    const env = llmHarness({ model, client, native: true })
    const exit = await runService(
      env,
      serviceInput({
        model,
        sessionID: golden.inputs.user.sessionID,
        userID: golden.inputs.user.id,
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(client.calls()).toBe(1)
    if (!Exit.isSuccess(exit)) throw new Error(String(failureOf(exit)))
    const events = Array.from(exit.value as ReadonlyArray<unknown>)
    const result = events.find((event: any) => event.type === "tool-result") as any
    expect(result).toBeDefined()
    expect(result.result).toEqual({ type: "json", value: { output: "ok" } })
  })
})

// --- 2. AI SDK seam: production LLM.Service terminal provider ---------------

describe("T04 AI SDK seam - production transform at terminal doStream", () => {
  test("final outgoing options match the AI SDK golden projection", async () => {
    const model = fixtureModel(goldenAiSdk.inputs)
    const captured: Record<string, unknown>[] = []
    const language = terminalModel(model.api.id, (options) => captured.push(options))
    const client = clientHarness()
    const env = llmHarness({ model, client, native: false, language })
    const jsonSchemaTool = tool({
      description: goldenAiSdk.inputs.tools.deploy.description,
      inputSchema: jsonSchema(goldenAiSdk.inputs.tools.deploy.inputSchema as any),
      execute: async () => ({ output: "ok" }),
    })
    const exit = await runService(
      env,
      serviceInput({
        model,
        sessionID: goldenAiSdk.inputs.user.sessionID,
        userID: goldenAiSdk.inputs.user.id,
        tools: { deploy: jsonSchemaTool },
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(client.calls()).toBe(0)
    expect(captured).toHaveLength(1)
    const options = captured[0]!
    expect(options.prompt).toEqual(goldenAiSdk.aiSdk.prompt)
    const tools = ((options.tools ?? []) as Array<Record<string, unknown>>).map((item) => ({
      type: item.type,
      name: item.name,
      description: item.description ?? "",
      inputSchema: item.inputSchema,
    }))
    expect(tools).toEqual(goldenAiSdk.aiSdk.tools)
    expect(options.toolChoice).toEqual(goldenAiSdk.aiSdk.toolChoice)
    expect(options.temperature ?? null).toBe(goldenAiSdk.aiSdk.temperature)
    expect(options.topP ?? null).toBe(goldenAiSdk.aiSdk.topP)
    expect(options.maxOutputTokens).toBe(goldenAiSdk.aiSdk.maxOutputTokens)
    expect(options.providerOptions ?? null).toEqual(goldenAiSdk.aiSdk.providerOptions)
  })
})

// --- 3. Pure admission and projection pins ----------------------------------

describe("T04 ContextBudget admission and projection", () => {
  test("fixture constants pin the evaluator knobs", () => {
    expect(Overflow.ContextBudget.HEADROOM).toBe(cases.constants.HEADROOM)
    expect(Overflow.ContextBudget.GROWTH_HEADROOM).toBe(cases.constants.GROWTH_HEADROOM)
    expect(Overflow.ContextBudget.SAFETY_MARGIN).toBe(cases.constants.SAFETY_MARGIN)
    expect(Overflow.ContextBudget.DEFAULT_RESERVED).toBe(cases.constants.DEFAULT_RESERVED)
  })

  test("late estimate of the golden projection is frozen; normal admission is allowed", async () => {
    const model = fixtureModel(golden.inputs)
    const prepared = await prep({ model, sessionID: golden.inputs.user.sessionID })
    const estimate = Overflow.ContextBudget.estimate(prepared.budgetProjection)
    expect(estimate).toBe(golden.budget.projectionEstimate)
    expect(prepared.budgetProjection.outputAllowance).toBe(golden.budget.outputAllowanceNormal)
    const result = evaluate({ model, estimate })
    expect(result.admitted).toBe(true)
    expect(result.outputAllowance).toBe(golden.inputs.outputTokenMax)
  })

  test("normal allowances: small route binds at 7,424; large route at 209,664", () => {
    const small = routeModel(cases.routes[0]!)
    const large = routeModel(cases.routes[1]!)
    const smallResult = evaluate({ model: small, estimate: 1_000 })
    const largeResult = evaluate({ model: large, estimate: 1_000 })
    expect(smallResult.admitted).toBe(cases.expectations.normalSmall.admitted)
    expect(smallResult.budget).toBe(cases.expectations.normalSmall.budget)
    expect(largeResult.admitted).toBe(cases.expectations.normalLarge.admitted)
    expect(largeResult.budget).toBe(cases.expectations.normalLarge.budget)
  })

  test("identical oversized final system growth is route-qualified with one session ID", async () => {
    for (const route of cases.routes) {
      const model = routeModel(route)
      const prepared = await prep({ model, sessionID: oversizedSessionID, system: oversizedSystem() })
      const estimate = Overflow.ContextBudget.estimate(prepared.budgetProjection)
      const result = evaluate({ model, estimate })
      if (route.qualifier.providerID === cases.routes[0]!.qualifier.providerID) {
        expect(result.admitted).toBe(cases.expectations.oversizedSmall.admitted)
        expect(estimate).toBeGreaterThan(result.budget)
      } else {
        expect(result.admitted).toBe(cases.expectations.oversizedLarge.admitted)
        expect(estimate).toBeLessThanOrEqual(result.budget)
      }
    }
  })
})

// --- 4. Final production admission gates ------------------------------------

describe("T04 production final admission gates", () => {
  test("native oversized final payload is typed-rejected with zero llmClient.stream calls", async () => {
    const model = nativeRouteModel(cases.nativeRoutes[0]!)
    const client = clientHarness()
    const env = llmHarness({ model, client, native: true })
    const exit = await runService(
      env,
      serviceInput({ model, sessionID: oversizedSessionID, system: oversizedSystem(), tools: {} }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const failure = failureOf(exit)
    expect(Overflow.ContextBudgetExceededError.isInstance(failure)).toBe(true)
    expect((failure as { name?: unknown }).name).toBe(cases.expectations.oversizedSmall.expectedError)
    // The injected native client is the pre-network/HTTP boundary.
    expect(client.calls()).toBe(0)
  })

  test("AI SDK oversized final payload is typed-rejected before doStream", async () => {
    const model = nativeRouteModel(cases.nativeRoutes[0]!)
    let doStreamCalls = 0
    const language = terminalModel(model.api.id, () => {
      doStreamCalls++
    })
    const client = clientHarness()
    const env = llmHarness({ model, client, native: false, language })
    const exit = await runService(
      env,
      serviceInput({ model, sessionID: oversizedSessionID, system: oversizedSystem(), tools: {} }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const failure = failureOf(exit)
    expect(Overflow.ContextBudgetExceededError.isInstance(failure)).toBe(true)
    expect((failure as { name?: unknown }).name).toBe(cases.expectations.oversizedSmall.expectedError)
    // The fake terminal model is the provider/HTTP boundary.
    expect(doStreamCalls).toBe(0)
    expect(client.calls()).toBe(0)
  })
})

// --- 5. Compaction outgoing allowance ---------------------------------------

describe("T04 production compaction allowance", () => {
  test("large-route native compaction sends max_tokens 4,096", async () => {
    const model = nativeRouteModel(cases.nativeRoutes[1]!)
    const client = clientHarness()
    const env = llmHarness({ model, client, native: true })
    const exit = await runService(
      env,
      serviceInput({
        model,
        sessionID: "session-t04-compaction-native",
        agentName: cases.requests.compaction.agentName,
        system: ["BASE-SYSTEM-MARKER"],
        messages: [{ role: "user", content: "CURRENT-INPUT-MARKER" }],
        tools: {},
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(client.calls()).toBe(1)
    const captured = client.lastRequest()
    expect(captured).toBeDefined()
    if (!captured) throw new Error("compaction native request was not captured")
    const prepared = await Effect.runPromise(LLMClient.prepare(captured))
    const body = prepared.body as Record<string, unknown>
    expect(body.max_tokens ?? body.max_output_tokens).toBe(4_096)
  })

  test("large-route AI SDK compaction sends maxOutputTokens 4,096", async () => {
    const model = nativeRouteModel(cases.nativeRoutes[1]!)
    let captured: Record<string, unknown> | undefined
    const language = terminalModel(model.api.id, (options) => {
      captured = options
    })
    const client = clientHarness()
    const env = llmHarness({ model, client, native: false, language })
    const exit = await runService(
      env,
      serviceInput({
        model,
        sessionID: "session-t04-compaction-ai",
        agentName: cases.requests.compaction.agentName,
        system: ["BASE-SYSTEM-MARKER"],
        messages: [{ role: "user", content: "CURRENT-INPUT-MARKER" }],
        tools: {},
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(client.calls()).toBe(0)
    expect(captured).toBeDefined()
    expect(captured?.maxOutputTokens).toBe(4_096)
  })
})

// --- 6. Compatibility and observable invocation-local overflow ledger -------

describe("T04 production compatibility", () => {
  test("auto:false preserves isOverflow compatibility but cannot bypass final admission", async () => {
    const model = nativeRouteModel(cases.nativeRoutes[0]!)
    const compactionOff = { auto: false } as ConfigV1.Info["compaction"]
    expect(
      Overflow.isOverflow({
        cfg: cfg(compactionOff),
        tokens: { total: 500_000, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        model,
      }),
    ).toBe(false)

    const client = clientHarness()
    const env = llmHarness({ model, client, native: true, compaction: compactionOff })
    const exit = await runService(
      env,
      serviceInput({
        model,
        sessionID: oversizedSessionID,
        system: oversizedSystem(),
        tools: {},
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = failureOf(exit)
    expect(Overflow.ContextBudgetExceededError.isInstance(failure)).toBe(true)
    expect((failure as { name?: unknown }).name).toBe(cases.expectations.oversizedSmall.expectedError)
    expect(client.calls()).toBe(0)
  })
})

// --- 7. Retry wording: pure route-local arithmetic only ---------------------

describe("T04 route-local re-evaluation arithmetic", () => {
  test("an unchanged estimate stays rejected on the small route and a rebuilt estimate is fresh", async () => {
    const largeModel = routeModel(cases.routes[1]!)
    const prepared = await prep({ model: largeModel, sessionID: "session-t04-re-evaluate", system: oversizedSystem() })
    const estimateBefore = Overflow.ContextBudget.estimate(prepared.budgetProjection)

    expect(evaluate({ model: largeModel, estimate: estimateBefore }).admitted).toBe(true)

    const smallModel = routeModel(cases.routes[0]!)
    expect(evaluate({ model: smallModel, estimate: estimateBefore }).admitted).toBe(false)

    const rebuilt = await prep({ model: smallModel, sessionID: "session-t04-re-evaluate-rebuilt" })
    const estimateAfter = Overflow.ContextBudget.estimate(rebuilt.budgetProjection)
    expect(evaluate({ model: smallModel, estimate: estimateAfter }).admitted).toBe(true)
  })
})
