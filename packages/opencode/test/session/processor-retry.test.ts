import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"

// V4-182 runtime retry layer: a failed provider attempt is replayed only when
// it left nothing durable, and never over a tool that already started.

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const retry = { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 5 }

function cfg(input: { url?: string; retry?: Record<string, unknown> } = {}) {
  return {
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
          baseURL: input.url ?? "http://localhost:1/v1",
          ...(input.retry ? { retry: input.retry } : {}),
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return { name: "build", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] }
}

// A LiteLLM mid-stream cut as delivered after HTTP 200 (retryable 5xx).
const cut = {
  message:
    "litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: ChatgptException - Connection closed.",
  type: null,
  param: null,
  code: "500",
}

// Scripted fake transport: one stream per attempt, with open/close journal.
const journal: string[] = []
let script: (call: number) => Stream.Stream<LLMEvent, unknown> = () => Stream.empty
let calls = 0
const scriptedLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => {
      const call = ++calls
      return Stream.scoped(
        Stream.unwrap(
          Effect.acquireRelease(
            Effect.sync(() => journal.push(`open:${call}`)),
            () => Effect.sync(() => journal.push(`close:${call}`)),
          ).pipe(Effect.map(() => script(call))),
        ),
      )
    },
  }),
)
const reset = (next: typeof script) => {
  journal.length = 0
  calls = 0
  script = next
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)
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
const itScripted = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, scriptedLLM]]))
const itServer = testEffect(
  LayerNode.compile(
    LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
    replacements,
  ),
)

const run = Effect.fn("test.run")(function* (dir: string, tools: Record<string, any> = {}) {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  const chat = yield* session.create({})
  const parent = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: parent.id, sessionID: chat.id, type: "text", text: "go" })
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    path: { cwd: path.resolve(dir), root: path.resolve(dir) },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID: parent.id,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(msg)
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id as SessionID, model: mdl })
  const value = yield* handle.process({
    user: {
      id: parent.id,
      sessionID: chat.id,
      role: "user",
      time: parent.time,
      agent: "build",
      model: ref,
    } satisfies SessionV1.User,
    sessionID: chat.id,
    model: mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: "go" }],
    tools,
  })
  const parts = yield* MessageV2.parts(msg.id)
  return { value, parts, message: handle.message }
})

const texts = (parts: SessionV1.Part[]) =>
  parts.filter((part): part is SessionV1.TextPart => part.type === "text").map((part) => part.text)
const toolParts = (parts: SessionV1.Part[]) =>
  parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")

itScripted.live("retry discards the failed attempt's partial output", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        reset((call) =>
          call === 1
            ? Stream.concat(
                Stream.make(
                  LLMEvent.stepStart({ index: 0 }),
                  LLMEvent.reasoningStart({ id: "r" }),
                  LLMEvent.reasoningDelta({ id: "r", text: "first thoughts" }),
                  LLMEvent.textStart({ id: "t" }),
                  LLMEvent.textDelta({ id: "t", text: "partial answer" }),
                ),
                Stream.fail(cut),
              )
            : Stream.make(
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.textStart({ id: "t" }),
                LLMEvent.textDelta({ id: "t", text: "final answer" }),
                LLMEvent.textEnd({ id: "t" }),
                LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                LLMEvent.finish({ reason: "stop" }),
              ),
        )
        const result = yield* run(dir)
        expect(result.value).toBe("continue")
        expect(calls).toBe(2)
        expect(result.message.error).toBeUndefined()
        expect(texts(result.parts)).toStrictEqual(["final answer"])
        expect(result.parts.filter((part) => part.type === "reasoning")).toHaveLength(0)
        expect(result.parts.filter((part) => part.type === "step-start")).toHaveLength(1)
      }),
    { config: cfg({ retry }) },
  ),
)

itScripted.live("retry never starts a new attempt before the previous one is closed", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        reset((call) =>
          call < 3
            ? Stream.concat(Stream.make(LLMEvent.stepStart({ index: 0 })), Stream.fail(cut))
            : Stream.make(
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                LLMEvent.finish({ reason: "stop" }),
              ),
        )
        const result = yield* run(dir)
        expect(result.value).toBe("continue")
        expect(journal).toStrictEqual(["open:1", "close:1", "open:2", "close:2", "open:3", "close:3"])
      }),
    { config: cfg({ retry }) },
  ),
)

itScripted.live("a mid-stream failure after a tool completed continues from its result without replay", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const toolRound = (call: number) =>
          Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "t" }),
            LLMEvent.textDelta({ id: "t", text: `checking ${call}` }),
            LLMEvent.textEnd({ id: "t" }),
            LLMEvent.toolInputStart({ id: `call-${call}`, name: "lookup" }),
            LLMEvent.toolCall({ id: `call-${call}`, name: "lookup", input: { q: "x" } }),
            LLMEvent.toolResult({
              id: `call-${call}`,
              name: "lookup",
              result: { type: "json", value: { title: "lookup", output: "found", metadata: {} } },
            }),
          )
        reset((call) => Stream.concat(toolRound(call), Stream.fail(cut)))
        const result = yield* run(dir)
        expect(calls).toBe(1)
        expect(result.value).toBe("continue")
        expect(result.message.error).toBeUndefined()
        expect(result.message.finish).toBe("tool-calls")
        const called = toolParts(result.parts)
        expect(called).toHaveLength(1)
        expect(called[0]?.state.status).toBe("completed")
        expect(texts(result.parts)).toStrictEqual(["checking 1"])
      }),
    { config: cfg({ retry }) },
  ),
)

itScripted.live("a mid-stream failure while a tool is running stops with a typed error", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        reset(() =>
          Stream.concat(
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolInputStart({ id: "call-1", name: "bash" }),
              LLMEvent.toolCall({ id: "call-1", name: "bash", input: { cmd: "make deploy" } }),
            ),
            Stream.fail(cut),
          ),
        )
        const result = yield* run(dir)
        expect(calls).toBe(1)
        expect(result.value).toBe("stop")
        const error = result.message.error
        expect(SessionV1.APIError.isInstance(error)).toBe(true)
        if (!SessionV1.APIError.isInstance(error)) return
        expect(error.data.isRetryable).toBe(false)
        expect(error.data.metadata?.code).toBe("ProviderRetryUnsafeError")
        expect(error.data.metadata?.tools).toBe("bash")
        expect(toolParts(result.parts)).toHaveLength(1)
      }),
    { config: cfg({ retry }) },
  ),
)

itScripted.live("a configured policy retries workflow-managed tasks whose RetryLimit is 0", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        reset((call) =>
          call === 1
            ? Stream.fail(cut)
            : Stream.make(
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                LLMEvent.finish({ reason: "stop" }),
              ),
        )
        const result = yield* run(dir).pipe(Effect.provideService(SessionRetry.RetryLimit, 0))
        expect(calls).toBe(2)
        expect(result.message.error).toBeUndefined()
      }),
    { config: cfg({ retry }) },
  ),
)

itScripted.live("without a configured policy a RetryLimit of 0 keeps the failed attempt unchanged", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        reset(() =>
          Stream.concat(
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "t" }),
              LLMEvent.textDelta({ id: "t", text: "partial" }),
              LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
              LLMEvent.toolCall({ id: "call-1", name: "lookup", input: { q: "x" } }),
              LLMEvent.toolResult({
                id: "call-1",
                name: "lookup",
                result: { type: "json", value: { title: "lookup", output: "found", metadata: {} } },
              }),
            ),
            Stream.fail(cut),
          ),
        )
        const result = yield* run(dir).pipe(Effect.provideService(SessionRetry.RetryLimit, 0))
        expect(calls).toBe(1)
        expect(result.value).toBe("stop")
        const error = result.message.error
        expect(SessionV1.APIError.isInstance(error)).toBe(true)
        if (!SessionV1.APIError.isInstance(error)) return
        expect(error.data.statusCode).toBe(500)
        expect(error.data.metadata?.code).toBeUndefined()
        expect(texts(result.parts)).toStrictEqual(["partial"])
        expect(toolParts(result.parts)).toHaveLength(1)
      }),
    { config: cfg() },
  ),
)

itServer.live("a configured policy does not retry a 400", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        yield* llm.error(400, { error: { message: "internal server error while validating tool_choice" } })
        yield* llm.text("never")
        const result = yield* run(dir)
        expect(yield* llm.calls).toBe(1)
        expect(result.value).toBe("stop")
        expect(result.message.error?.name).toBe("APIError")
      }),
    { config: (url) => cfg({ url, retry }) },
  ),
)

itServer.live("an executed AI SDK tool is not executed again after a mid-stream failure", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executions = 0
        const settled = new Promise((done) => setTimeout(done, 200))
        const line = (delta: Record<string, unknown>) => ({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta }],
        })
        // The tool call streams and runs; then LiteLLM reports a mid-stream cut.
        yield* llm.push(
          raw({
            head: [
              line({ role: "assistant" }),
              line({
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"weather"}' } },
                ],
              }),
            ],
            wait: settled,
            tail: [{ error: { message: cut.message, type: null, param: null, code: "500" } }],
          }),
        )
        yield* llm.push(reply().tool("lookup", { query: "weather" }))
        const result = yield* run(dir, {
          lookup: tool({
            description: "Look up information",
            inputSchema: z.object({ query: z.string() }),
            execute: async (input) => {
              executions++
              return { title: "lookup", output: `result:${input.query}`, metadata: {} }
            },
          }),
        })
        expect(executions).toBe(1)
        expect(yield* llm.calls).toBe(1)
        expect(result.message.error).toBeUndefined()
        expect(result.message.finish).toBe("tool-calls")
        const called = toolParts(result.parts)
        expect(called).toHaveLength(1)
        expect(called[0]?.state.status).toBe("completed")
      }),
    { config: (url) => cfg({ url, retry }) },
  ),
)

// Safe resume: a cut after a tool call started keeps that call (awaited to its
// terminal state) and lets the loop continue from history; it never replays.
const line = (delta: Record<string, unknown>) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta }],
})
const cutLine = { error: { message: cut.message, type: null, param: null, code: "500" } }
const lookupCall = (index: number, id: string, args: string) =>
  line({ tool_calls: [{ index, id, type: "function", function: { name: "lookup", arguments: args } }] })
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
// One complete lookup call, then the cut once `wait` resolves.
const cutAfterLookup = (wait: PromiseLike<unknown>) =>
  raw({ head: [line({ role: "assistant" }), lookupCall(0, "call_1", '{"query":"weather"}')], wait, tail: [cutLine] })

type LookupOutput = { title: string; output: string; metadata: Record<string, unknown> }
const lookup = (execute: (input: { query: string }, options: { abortSignal?: AbortSignal }) => Promise<LookupOutput>) =>
  tool({
    description: "Look up information",
    inputSchema: z.object({ query: z.string() }),
    execute: (input, options) => execute(input, options),
  })

itServer.live("a cut while a started tool is running waits for its result and continues without replay", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executions = 0
        let abortedAtEnd: boolean | undefined
        const cutSent = sleep(100)
        yield* llm.push(cutAfterLookup(cutSent))
        yield* llm.text("never")
        const result = yield* run(dir, {
          lookup: lookup(async (input, options) => {
            executions++
            await cutSent
            await sleep(400)
            abortedAtEnd = options.abortSignal?.aborted
            if (options.abortSignal?.aborted) throw new Error("aborted by the cut")
            return { title: "lookup", output: `result:${input.query}`, metadata: {} }
          }),
        })
        expect(executions).toBe(1)
        expect(abortedAtEnd).toBe(false)
        expect(yield* llm.calls).toBe(1)
        expect(result.value).toBe("continue")
        expect(result.message.error).toBeUndefined()
        expect(result.message.finish).toBe("tool-calls")
        const called = toolParts(result.parts)
        expect(called).toHaveLength(1)
        expect(called[0]?.state).toMatchObject({ status: "completed", output: "result:weather" })
      }),
    { config: (url) => cfg({ url, retry }) },
  ),
)

itServer.live("a started tool that fails after the cut is recorded as failed and the turn continues", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executions = 0
        const cutSent = sleep(100)
        yield* llm.push(cutAfterLookup(cutSent))
        const result = yield* run(dir, {
          lookup: lookup(async () => {
            executions++
            await cutSent
            await sleep(200)
            throw new Error("lookup backend down")
          }),
        })
        expect(executions).toBe(1)
        expect(yield* llm.calls).toBe(1)
        expect(result.value).toBe("continue")
        expect(result.message.error).toBeUndefined()
        const called = toolParts(result.parts)
        expect(called).toHaveLength(1)
        expect(called[0]?.state).toMatchObject({ status: "error", error: "lookup backend down" })
        expect(called[0]?.state.status === "error" && called[0].state.metadata?.interrupted).toBeFalsy()
      }),
    { config: (url) => cfg({ url, retry }) },
  ),
)

itServer.live("a cut marks the partial text incomplete and records a never-started call as not executed", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executions = 0
        yield* llm.push(
          raw({
            head: [
              line({ role: "assistant", content: "checking the weath" }),
              lookupCall(0, "call_1", '{"query":"weather"}'),
              // A second call whose arguments never finished streaming.
              lookupCall(1, "call_2", '{"query":"tem'),
            ],
            wait: sleep(300),
            tail: [cutLine],
          }),
        )
        const result = yield* run(dir, {
          lookup: lookup(async (input) => {
            executions++
            return { title: "lookup", output: `result:${input.query}`, metadata: {} }
          }),
        })
        expect(executions).toBe(1)
        expect(result.value).toBe("continue")
        expect(result.message.error).toBeUndefined()
        const text = result.parts.find((part): part is SessionV1.TextPart => part.type === "text")
        expect(text?.text).toBe("checking the weath")
        expect(text?.metadata?.incomplete).toBe(true)
        const called = toolParts(result.parts)
        expect(called.map((part) => [part.callID, part.state.status])).toStrictEqual([
          ["call_1", "completed"],
          ["call_2", "error"],
        ])
        expect(called[1]?.state.status === "error" && called[1].state.metadata?.notExecuted).toBe(true)
        // The internal marker never reaches a provider request.
        const mdl = yield* (yield* Provider.Service).getModel(ref.providerID, ref.modelID)
        const history = yield* MessageV2.filterCompactedEffect(result.message.sessionID)
        const messages = yield* MessageV2.toModelMessagesEffect(history, mdl)
        expect(JSON.stringify(messages)).not.toContain("incomplete")
        expect(JSON.stringify(messages)).toContain("checking the weath")
      }),
    { config: (url) => cfg({ url, retry }) },
  ),
)

itServer.live("an exhausted retry budget fails a cut after a tool call with the unsafe-retry error", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executions = 0
        yield* llm.push(cutAfterLookup(sleep(200)))
        yield* llm.text("never")
        const result = yield* run(dir, {
          lookup: lookup(async (input) => {
            executions++
            return { title: "lookup", output: `result:${input.query}`, metadata: {} }
          }),
        })
        expect(executions).toBe(1)
        expect(yield* llm.calls).toBe(1)
        expect(result.value).toBe("stop")
        const error = result.message.error
        expect(SessionV1.APIError.isInstance(error)).toBe(true)
        if (!SessionV1.APIError.isInstance(error)) return
        expect(error.data.isRetryable).toBe(false)
        expect(error.data.metadata?.code).toBe("ProviderRetryUnsafeError")
        expect(error.data.metadata?.tools).toBe("lookup")
      }),
    { config: (url) => cfg({ url, retry: { ...retry, maxAttempts: 1 } }) },
  ),
)

itServer.live("without a retry config a cut still aborts a running tool and fails as before", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executions = 0
        let aborted = false
        const finished = Promise.withResolvers<void>()
        const cutSent = sleep(100)
        yield* llm.push(cutAfterLookup(cutSent))
        const result = yield* run(dir, {
          lookup: lookup(async (_input, options) => {
            executions++
            await cutSent
            await sleep(400)
            aborted = options.abortSignal?.aborted === true
            finished.resolve()
            return { title: "lookup", output: "late", metadata: {} }
          }),
        }).pipe(Effect.provideService(SessionRetry.RetryLimit, 0))
        yield* Effect.promise(() => finished.promise)
        expect(executions).toBe(1)
        expect(aborted).toBe(true)
        expect(yield* llm.calls).toBe(1)
        expect(result.value).toBe("stop")
        const error = result.message.error
        expect(SessionV1.APIError.isInstance(error)).toBe(true)
        if (!SessionV1.APIError.isInstance(error)) return
        expect(error.data.statusCode).toBe(500)
        expect(error.data.metadata?.code).toBeUndefined()
      }),
    { config: (url) => cfg({ url }) },
  ),
)
