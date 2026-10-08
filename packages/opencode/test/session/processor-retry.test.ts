import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Clock, Effect, Fiber, Layer, Stream } from "effect"
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
// The script receives the stream input, so it can invoke a tracked tool body
// the way a transport does.
const journal: string[] = []
let script: (call: number, input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown> = () => Stream.empty
let calls = 0
const scriptedLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      const call = ++calls
      return Stream.scoped(
        Stream.unwrap(
          Effect.acquireRelease(
            Effect.sync(() => journal.push(`open:${call}`)),
            () => Effect.sync(() => journal.push(`close:${call}`)),
          ).pipe(Effect.map(() => script(call, input))),
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

const start = Effect.fn("test.start")(function* (
  dir: string,
  tools: Record<string, any> = {},
  resume?: SessionProcessor.Resume,
) {
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
  const handle = yield* processors.create({
    assistantMessage: msg,
    sessionID: chat.id as SessionID,
    model: mdl,
    resume,
  })
  const process = handle.process({
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
  return { handle, process, parts: MessageV2.parts(msg.id) }
})

const run = Effect.fn("test.run")(function* (
  dir: string,
  tools: Record<string, any> = {},
  resume?: SessionProcessor.Resume,
) {
  const step = yield* start(dir, tools, resume)
  const value = yield* step.process
  return { value, parts: yield* step.parts, message: step.handle.message, resume: step.handle.resume }
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
// Resolves only once the server starts the response body, so the delay is
// measured from the request rather than from test setup.
const lazy = (wait: () => Promise<unknown>): PromiseLike<unknown> => ({
  then: (done, fail) => wait().then(done, fail),
})
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

itServer.live("a dropped connection while a started tool runs waits for it and continues without replay", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executions = 0
        const cutSent = sleep(100)
        // An upstream restart: the socket closes mid-body, no error payload.
        yield* llm.push(
          raw({
            head: [line({ role: "assistant" }), lookupCall(0, "call_1", '{"query":"weather"}')],
            wait: cutSent,
            error: new Error("upstream restarted"),
          }),
        )
        yield* llm.text("never")
        const result = yield* run(dir, {
          lookup: lookup(async (input, options) => {
            executions++
            await cutSent
            await sleep(400)
            if (options.abortSignal?.aborted) throw new Error("aborted by the cut")
            return { title: "lookup", output: `result:${input.query}`, metadata: {} }
          }),
        })
        expect(executions).toBe(1)
        expect(yield* llm.calls).toBe(1)
        expect(result.message.error).toBeUndefined()
        expect(result.value).toBe("continue")
        expect(toolParts(result.parts)[0]?.state).toMatchObject({ status: "completed", output: "result:weather" })
      }),
    { config: (url) => cfg({ url, retry }) },
  ),
)

// Review follow-ups. The scripted transport invokes the tracked tool body
// itself, so the order of the cut, the settle step and each execute is forced
// instead of raced.
const invoke = async (input: LLM.StreamInput, id: string, query: string) =>
  input.tools.lookup?.execute?.({ query }, { toolCallId: id, messages: [] })
// Resolves once the stream scope of attempt `call` closed: its settle step follows.
const closed = async (call: number) => {
  while (!journal.includes(`close:${call}`)) await sleep(5)
}
const scriptedCall = (id: string, query: string) => [
  LLMEvent.toolInputStart({ id, name: "lookup" }),
  LLMEvent.toolCall({ id, name: "lookup", input: { query } }),
]
// One lookup call whose body the transport started, then the cut.
const cutWhileRunning = (input: LLM.StreamInput, id = "call_1", query = "weather") =>
  Stream.concat(
    Stream.make(LLMEvent.stepStart({ index: 0 }), ...scriptedCall(id, query)),
    Stream.unwrap(
      Effect.sync(() => {
        void invoke(input, id, query).catch(() => undefined)
        return Stream.fail(cut)
      }),
    ),
  )
const answer = (text: string) =>
  Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "t" }),
    LLMEvent.textDelta({ id: "t", text }),
    LLMEvent.textEnd({ id: "t" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  )
const found = (query: string): LookupOutput => ({ title: "lookup", output: `result:${query}`, metadata: {} })

// The fleet retry budget (30 minutes), with short delays.
const fleet = { maxAttempts: 200, initialDelayMs: 1, maxDelayMs: 5, maxElapsedMs: 1_800_000 }
// A clock the test can jump forward; sleeps stay real.
const jumpClock = Effect.gen(function* () {
  const real = yield* Clock.Clock
  const state = { offset: 0 }
  const millis = () => real.currentTimeMillisUnsafe() + state.offset
  const nanos = () => real.currentTimeNanosUnsafe() + BigInt(state.offset) * 1_000_000n
  return {
    jump: (ms: number) => {
      state.offset += ms
    },
    clock: {
      currentTimeMillisUnsafe: millis,
      currentTimeMillis: Effect.sync(millis),
      currentTimeNanosUnsafe: nanos,
      currentTimeNanos: Effect.sync(nanos),
      sleep: (duration) => real.sleep(duration),
    } satisfies Clock.Clock,
  }
})

itScripted.live("time spent waiting for a started tool does not consume the retry budget", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const time = yield* jumpClock
        reset((call, input) => {
          if (call === 1) return cutWhileRunning(input)
          // The continuation step: a plain retryable failure, no tool started.
          if (call === 2) return Stream.fail(cut)
          return answer("done")
        })
        const first = yield* run(dir, {
          lookup: lookup(async (input) => {
            // The tool outlives the whole budget after the cut.
            await closed(1)
            time.jump(31 * 60_000)
            return found(input.query)
          }),
        }).pipe(Effect.provideService(Clock.Clock, time.clock))
        expect(first.value).toBe("continue")
        expect(first.message.error).toBeUndefined()
        expect(toolParts(first.parts)[0]?.state).toMatchObject({ status: "completed", output: "result:weather" })
        expect(first.resume?.attempts).toBe(1)

        const second = yield* run(dir, {}, first.resume).pipe(Effect.provideService(Clock.Clock, time.clock))
        expect(calls).toBe(3)
        expect(second.value).toBe("continue")
        expect(second.message.error).toBeUndefined()
        expect(texts(second.parts)).toStrictEqual(["done"])
      }),
    { config: cfg({ retry: fleet }) },
  ),
)

itScripted.live("a second cut after a tool outlived the retry budget still resumes", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const time = yield* jumpClock
        const ran: string[] = []
        reset((call, input) => cutWhileRunning(input, `call_${call}`, `q${call}`))
        const tools = {
          lookup: lookup(async (input) => {
            ran.push(input.query)
            if (input.query !== "q1") return found(input.query)
            await closed(1)
            time.jump(31 * 60_000)
            return found(input.query)
          }),
        }
        const first = yield* run(dir, tools).pipe(Effect.provideService(Clock.Clock, time.clock))
        const second = yield* run(dir, tools, first.resume).pipe(Effect.provideService(Clock.Clock, time.clock))
        expect(calls).toBe(2)
        expect(ran).toStrictEqual(["q1", "q2"])
        expect(second.value).toBe("continue")
        expect(second.message.error).toBeUndefined()
        expect(toolParts(second.parts)[0]?.state).toMatchObject({ status: "completed", output: "result:q2" })
        expect(second.resume?.attempts).toBe(2)
      }),
    { config: cfg({ retry: fleet }) },
  ),
)

itScripted.live("retry time carried from an earlier resume still bounds the turn", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        reset((call) => (call === 1 ? Stream.fail(cut) : answer("never")))
        const result = yield* run(dir, {}, { attempts: 1, elapsed: fleet.maxElapsedMs })
        expect(calls).toBe(1)
        expect(result.value).toBe("stop")
        const error = result.message.error
        expect(SessionV1.APIError.isInstance(error)).toBe(true)
        if (!SessionV1.APIError.isInstance(error)) return
        expect(error.data.statusCode).toBe(500)
      }),
    { config: cfg({ retry: fleet }) },
  ),
)

itScripted.live("an execute arriving while its cut attempt settles never runs and is recorded as not executed", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const ran: string[] = []
        let transport: LLM.StreamInput | undefined
        let late: unknown
        reset((_call, input) => {
          transport = input
          return Stream.concat(
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              ...scriptedCall("call_1", "first"),
              // Announced to the consumer, but its execute is still to come.
              ...scriptedCall("call_2", "second"),
            ),
            Stream.unwrap(
              Effect.sync(() => {
                void invoke(input, "call_1", "first").catch(() => undefined)
                return Stream.fail(cut)
              }),
            ),
          )
        })
        const result = yield* run(dir, {
          lookup: lookup(async (input) => {
            ran.push(input.query)
            if (input.query !== "first" || !transport) return found(input.query)
            // The first call is still awaited by the settle step when the
            // transport gets around to the second one.
            await closed(1)
            await sleep(50)
            late = await invoke(transport, "call_2", "second").then(
              () => "executed",
              (error: unknown) => error,
            )
            return found(input.query)
          }),
        })
        expect(ran).toStrictEqual(["first"])
        expect(late).toBeInstanceOf(Error)
        expect(calls).toBe(1)
        expect(result.value).toBe("continue")
        expect(result.message.error).toBeUndefined()
        const called = toolParts(result.parts)
        expect(called.map((part) => [part.callID, part.state.status])).toStrictEqual([
          ["call_1", "completed"],
          ["call_2", "error"],
        ])
        expect(called[1]?.state.status === "error" && called[1].state.metadata?.notExecuted).toBe(true)
      }),
    { config: cfg({ retry }) },
  ),
)

itScripted.live("an execute that arrives after its attempt was replayed never runs", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const ran: string[] = []
        let first: LLM.StreamInput | undefined
        let late: unknown
        reset((call, input) => {
          if (call === 1) {
            first = input
            // The call was announced, the cut came before its execute.
            return Stream.concat(
              Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.toolInputStart({ id: "call_1", name: "lookup" })),
              Stream.fail(cut),
            )
          }
          const stale = first
          if (!stale) return Stream.fail(new Error("no first attempt"))
          // The replay is streaming when the first attempt's execute shows up.
          return Stream.unwrap(
            Effect.promise(() =>
              invoke(stale, "call_1", "weather").then(
                () => "executed",
                (error: unknown) => error,
              ),
            ).pipe(
              Effect.map((outcome) => {
                late = outcome
                return answer("final answer")
              }),
            ),
          )
        })
        const result = yield* run(dir, {
          lookup: lookup(async (input) => {
            ran.push(input.query)
            return found(input.query)
          }),
        })
        expect(calls).toBe(2)
        expect(ran).toStrictEqual([])
        expect(late).toBeInstanceOf(Error)
        expect(result.value).toBe("continue")
        expect(result.message.error).toBeUndefined()
        expect(toolParts(result.parts)).toHaveLength(0)
        expect(texts(result.parts)).toStrictEqual(["final answer"])
      }),
    { config: cfg({ retry }) },
  ),
)

itScripted.live("a cut after the step finished continues even when the retry budget is exhausted", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        reset(() =>
          Stream.concat(
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              ...scriptedCall("call_1", "weather"),
              LLMEvent.toolResult({ id: "call_1", name: "lookup", result: { type: "json", value: found("weather") } }),
              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            ),
            Stream.fail(cut),
          ),
        )
        const result = yield* run(dir)
        expect(calls).toBe(1)
        expect(result.value).toBe("continue")
        expect(result.message.error).toBeUndefined()
        expect(result.message.finish).toBe("tool-calls")
        expect(toolParts(result.parts)[0]?.state).toMatchObject({ status: "completed", output: "result:weather" })
        expect(result.parts.filter((part) => part.type === "step-finish")).toHaveLength(1)
      }),
    { config: cfg({ retry: { ...retry, maxAttempts: 1 } }) },
  ),
)

itScripted.live("a cancel while a started tool is awaited halts the turn and stops the tool", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        let signal: AbortSignal | undefined
        const stopped = Promise.withResolvers<void>()
        reset((_call, input) => cutWhileRunning(input))
        const step = yield* start(dir, {
          lookup: lookup(async (input, options) => {
            signal = options.abortSignal
            // Runs until it is told to stop, and then still reports success.
            await new Promise<void>((done) =>
              options.abortSignal?.addEventListener("abort", () => done(), { once: true }),
            )
            stopped.resolve()
            return found(input.query)
          }),
        })
        const fiber = yield* step.process.pipe(Effect.forkChild)
        yield* Effect.promise(() => closed(1))
        yield* Effect.sleep("150 millis")
        // The cut alone left the tool running: the settle step is awaiting it.
        expect(signal?.aborted).toBe(false)
        expect(toolParts(yield* step.parts)[0]?.state.status).toBe("running")

        yield* Fiber.interrupt(fiber)
        yield* Effect.promise(() => Promise.race([stopped.promise, sleep(2_000)]))
        yield* Effect.sleep("50 millis")
        expect(signal?.aborted).toBe(true)
        expect(calls).toBe(1)
        expect(step.handle.message.error?.name).toBe("MessageAbortedError")
        expect(step.handle.resume).toBeUndefined()
        const called = toolParts(yield* step.parts)
        expect(called).toHaveLength(1)
        expect(called[0]?.state).toMatchObject({ status: "error", metadata: { interrupted: true } })
      }),
    { config: cfg({ retry }) },
  ),
)

// The cut lands in the same moment as the tool call, at several offsets. What
// the race decides may differ; what is recorded must match what ran.
itServer.live(
  "a cut right behind a tool call never runs it twice and records what happened",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          for (const wait of [0, 0, 0, 1, 2, 3, 5, 8, 13, 21]) {
            let executions = 0
            const before = yield* llm.calls
            yield* llm.push(
              raw({
                head: [line({ role: "assistant" }), lookupCall(0, "call_1", '{"query":"weather"}')],
                ...(wait > 0 ? { wait: lazy(() => sleep(wait)) } : {}),
                tail: [cutLine],
              }),
            )
            const result = yield* run(dir, {
              lookup: lookup(async (input) => {
                executions++
                await sleep(20)
                return found(input.query)
              }),
            })
            // A detached execute of the cut attempt would show up here.
            yield* Effect.sleep("200 millis")
            const called = toolParts(result.parts)
            expect((yield* llm.calls) - before).toBe(1)
            expect(executions).toBeLessThanOrEqual(1)
            expect(called.map((part) => part.callID)).toStrictEqual(["call_1"])
            const error = result.message.error
            if (result.value === "stop") {
              // The cut settled before the transport reached the body: the
              // call was refused afterwards, so the turn fails without a run.
              expect(executions).toBe(0)
              expect(SessionV1.APIError.isInstance(error) && error.data.metadata?.code).toBe("ProviderRetryUnsafeError")
              continue
            }
            expect(error).toBeUndefined()
            expect(called[0]?.state).toMatchObject(
              executions === 1
                ? { status: "completed", output: "result:weather" }
                : { status: "error", metadata: { notExecuted: true } },
            )
          }
        }),
      { config: (url) => cfg({ url, retry }) },
    ),
  60_000,
)
