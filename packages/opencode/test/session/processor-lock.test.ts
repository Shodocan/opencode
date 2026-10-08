import { afterAll, expect } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { tool } from "ai"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import z from "zod"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { SessionRetry } from "@/session/retry"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// A file database: a second connection plays another OpenCode process holding
// the write lock, which an in-memory database cannot have.
const file = path.join(os.tmpdir(), `opencode-processor-lock-${process.pid}-${Date.now()}.sqlite`)

afterAll(async () => {
  await Promise.all(["", "-wal", "-shm"].map((suffix) => fs.rm(file + suffix, { force: true })))
})

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const providerCfg = (url: string) => ({
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
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const agent = (): Agent.Info => ({
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
})

const base = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LayerNode.group([
        SessionProcessor.node,
        Session.node,
        SessionProjector.node,
        Provider.node,
        Database.node,
        EventV2Bridge.node,
        SessionStatus.node,
        CrossSpawnSpawner.node,
      ]),
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [Database.node, Database.layerFromPath(file)],
      [
        SessionSummary.node,
        Layer.succeed(
          SessionSummary.Service,
          SessionSummary.Service.of({
            summarize: () => Effect.void,
            diff: () => Effect.succeed([]),
            computeDiff: () => Effect.succeed([]),
          }),
        ),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

// No test here waits for the database longer than 20s (the longest budget it
// sets), so 25s means a wait that did not end; the runner stops a test at 30s.
const TEST_TIMEOUT = 30_000
const LIMIT = 25_000
const it = {
  effect: base.effect,
  live: ((name, value, opts) =>
    base.live(
      name,
      Effect.suspend(() => (typeof value === "function" ? value() : value)).pipe(
        Effect.timeoutOrElse({
          duration: LIMIT,
          orElse: () =>
            Effect.die(
              new Error(`${name}: not finished after ${LIMIT}ms: something is still waiting for the database lock`),
            ),
        }),
      ),
      opts ?? TEST_TIMEOUT,
    )) as typeof base.live,
}

const BUSY = "database is locked (SQLITE_BUSY) during BEGIN IMMEDIATE; gave up waiting for the write lock"
const QUEUED = "an earlier write of this process is still waiting for the database; gave up waiting for the write lock"

// A turn with one assistant message, a connection standing for another
// process, and every session event seen since.
const turn = Effect.fn("test.turn")(function* (dir: string, text: string) {
  const session = yield* Session.Service
  const processors = yield* SessionProcessor.Service
  const provider = yield* Provider.Service
  const events = yield* EventV2Bridge.Service
  const chat = yield* session.create({})
  const parent = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: parent.id, sessionID: chat.id, type: "text", text })
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
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  const model = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new BunDatabase(file)),
    (db) => Effect.sync(() => db.close()),
  )
  const seen: Array<{ type: string; data: unknown }> = []
  const unsubscribe = yield* events.listen((event) =>
    Effect.sync(() => void seen.push({ type: event.type, data: event.data })),
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const input = (tools: Parameters<typeof handle.process>[0]["tools"]) => ({
    user: {
      id: parent.id,
      sessionID: chat.id,
      role: "user",
      time: parent.time,
      agent: parent.agent,
      model: ref,
    } satisfies SessionV1.User,
    sessionID: chat.id,
    model,
    agent: agent(),
    system: [],
    messages: [{ role: "user" as const, content: text }],
    tools,
  })
  return { session, handle, other, seen, msg, model, input, sessionID: chat.id }
})

const toolPart = (messageID: MessageID) =>
  MessageV2.parts(messageID).pipe(
    Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
  )

// Resolves once the call is stored as running, so the lock below is met by
// the write of its result and by nothing before it.
const running = async (messageID: MessageID) => {
  const db = new BunDatabase(file, { readonly: true })
  const deadline = Date.now() + 10_000
  try {
    while (
      !db
        .query<{ data: string }, [string]>("SELECT data FROM part WHERE message_id = ?")
        .all(messageID)
        .some((row) => row.data.includes('"status":"running"'))
    ) {
      if (Date.now() > deadline) throw new Error("the tool call was not stored as running within 10s")
      await Bun.sleep(5)
    }
  } finally {
    db.close()
  }
}

const statuses = (seen: Array<{ type: string; data: unknown }>) =>
  seen.flatMap((event) =>
    event.type === SessionStatus.Event.Status.type
      ? [(event.data as { status: { type: string; message?: string } }).status]
      : [],
  )

const limits = (retry: { budget: number; outcome: number; abort: number }) =>
  Effect.provideService(Database.LockRetry, { ...retry, busy: 5, base: 2, cap: 10 })

it.live("a tool result outlasts the lock wait of other writes, is stored once and the session says it waits", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const input = yield* turn(dir, "tool")
        yield* llm.tool("deploy", { target: "prod" })
        let runs = 0

        const started = Date.now()
        const value = yield* input.handle
          .process(
            input.input({
              deploy: tool({
                description: "Deploy",
                inputSchema: z.object({ target: z.string() }),
                execute: async () => {
                  runs++
                  // Another process takes the write lock while the tool runs and
                  // keeps it five times longer than any other write would wait.
                  await running(input.msg.id)
                  input.other.run("BEGIN IMMEDIATE")
                  setTimeout(() => input.other.run("COMMIT"), 300)
                  return { title: "Deploy", output: "deployed", metadata: {} }
                },
              }),
            }),
          )
          .pipe(limits({ budget: 60, outcome: 5_000, abort: 60 }))

        const call = yield* toolPart(input.msg.id)
        expect(value).toBe("continue")
        expect(Date.now() - started).toBeGreaterThanOrEqual(280)
        expect(runs).toBe(1)
        expect(call?.state.status === "completed" && call.state.output).toBe("deployed")
        expect(yield* llm.calls).toBe(1)
        const waiting = statuses(input.seen).filter((status) => status.type === "retry")
        expect(waiting.length).toBeGreaterThan(0)
        expect(waiting.every((status) => status.message === "Database is busy: waiting to store a tool result")).toBe(
          true,
        )
        expect(statuses(input.seen).some((status) => status.type === "busy")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("past its ceiling a tool result ends the turn with the lock error and the call reads as interrupted", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const input = yield* turn(dir, "tool")
        yield* llm.tool("deploy", { target: "prod" })
        let runs = 0

        const started = Date.now()
        const exit = yield* input.handle
          .process(
            input.input({
              deploy: tool({
                description: "Deploy",
                inputSchema: z.object({ target: z.string() }),
                execute: async () => {
                  runs++
                  await running(input.msg.id)
                  input.other.run("BEGIN IMMEDIATE")
                  return { title: "Deploy", output: "deployed", metadata: {} }
                },
              }),
            }),
          )
          .pipe(limits({ budget: 60, outcome: 300, abort: 100 }), Effect.exit)
        const elapsed = Date.now() - started
        input.other.run("COMMIT")

        // The ceiling, then one short shared wait for the writes that end the turn: no more.
        expect(elapsed).toBeGreaterThanOrEqual(380)
        expect(elapsed).toBeLessThan(2_000)
        const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(defect).toBeInstanceOf(Database.LockedError)
        // What the user sees: the session error with the SQLite cause, and an idle session.
        const error = input.seen.find((event) => event.type === Session.Event.Error.type)?.data as
          | { error?: { name: string; data: { message?: string } } }
          | undefined
        expect(error?.error?.name).toBe("UnknownError")
        expect(error?.error?.data.message).toBe(BUSY)
        expect(statuses(input.seen).at(-1)?.type).toBe("idle")
        // What the next turn sees: the call is still running in the database,
        // which history reads as interrupted. It was run once and not replayed.
        const call = yield* toolPart(input.msg.id)
        expect(call?.state.status).toBe("running")
        expect(runs).toBe(1)
        expect(yield* llm.calls).toBe(1)
        const history = yield* MessageV2.toModelMessagesEffect(
          yield* input.session.messages({ sessionID: input.sessionID }),
          input.model,
        )
        expect(JSON.stringify(history)).toContain("[Tool execution was interrupted]")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("an interrupt ends the wait of a tool result for the lock, and the result is not stored later", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const input = yield* turn(dir, "tool")
        yield* llm.tool("deploy", { target: "prod" })
        let runs = 0

        // The result would wait 20 seconds for the lock.
        const run = yield* input.handle
          .process(
            input.input({
              deploy: tool({
                description: "Deploy",
                inputSchema: z.object({ target: z.string() }),
                execute: async () => {
                  runs++
                  await running(input.msg.id)
                  input.other.run("BEGIN IMMEDIATE")
                  return { title: "Deploy", output: "deployed", metadata: {} }
                },
              }),
            }),
          )
          .pipe(limits({ budget: 20_000, outcome: 20_000, abort: 150 }), Effect.forkChild)
        // The session says it is waiting: the write of the result is the one held.
        yield* Effect.gen(function* () {
          while (!statuses(input.seen).some((status) => status.type === "retry")) yield* Effect.sleep("10 millis")
        }).pipe(Effect.timeout("5 seconds"))

        const started = Date.now()
        yield* Fiber.interrupt(run)
        const exit = yield* Fiber.await(run)
        const elapsed = Date.now() - started
        input.other.run("COMMIT")

        // One short wait for the writes that end the turn, then it is over.
        expect(Exit.isFailure(exit)).toBe(true)
        expect(elapsed).toBeGreaterThanOrEqual(140)
        expect(elapsed).toBeLessThan(1_500)
        expect(statuses(input.seen).at(-1)?.type).toBe("idle")
        // The result is dropped, not written once the lock is free: the call
        // stays running, which history reads as interrupted.
        yield* Effect.sleep("300 millis")
        expect((yield* toolPart(input.msg.id))?.state.status).toBe("running")
        expect(runs).toBe(1)
        const history = yield* MessageV2.toModelMessagesEffect(
          yield* input.session.messages({ sessionID: input.sessionID }),
          input.model,
        )
        expect(JSON.stringify(history)).toContain("[Tool execution was interrupted]")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

// A tool that ends after its turn, as one that ignores the abort does: it
// writes its result itself, from its own fiber.
const lateTool = Effect.fnUntraced(function* (
  input: Effect.Success<ReturnType<typeof turn>>,
  body: (write: () => Promise<void>) => Promise<void>,
) {
  const state = { runs: 0, written: Promise.withResolvers<void>() }
  // As the session's tools do: in the instance the turn belongs to.
  const context = yield* Effect.context<never>()
  return {
    state,
    tools: {
      deploy: tool({
        description: "Deploy",
        inputSchema: z.object({ target: z.string() }),
        execute: async (_args, options) => {
          state.runs++
          const output = { title: "Deploy", output: "deployed", metadata: {} }
          await running(input.msg.id)
          input.other.run("BEGIN IMMEDIATE")
          // Bounded like the turn, so a write that is not given up still ends.
          await body(() =>
            Effect.runPromiseWith(context)(
              input.handle
                .completeToolCall(options.toolCallId, output)
                .pipe(limits({ budget: 20_000, outcome: 20_000, abort: 150 })),
            ),
          )
          state.written.resolve()
          return output
        },
      }),
    },
  }
})

it.live("a tool that ends after its turn was aborted does not write its result", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const input = yield* turn(dir, "tool")
        yield* llm.tool("deploy", { target: "prod" })
        const gate = Promise.withResolvers<void>()
        const late = yield* lateTool(input, async (write) => {
          await gate.promise
          await write()
        })

        const run = yield* input.handle
          .process(input.input(late.tools))
          .pipe(limits({ budget: 20_000, outcome: 20_000, abort: 150 }), Effect.forkChild)
        yield* Effect.promise(() => running(input.msg.id))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(run)
        // The turn could not mark the call: the lock was held. It is over all the same.
        expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true)
        expect((yield* toolPart(input.msg.id))?.state.status).toBe("running")

        // The database is free again and only now the tool ends.
        input.other.run("COMMIT")
        gate.resolve()
        yield* Effect.promise(() => late.state.written.promise)
        expect((yield* toolPart(input.msg.id))?.state.status).toBe("running")
        expect(late.state.runs).toBe(1)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("a result a tool was still writing when its turn was aborted is given up, not stored later", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const input = yield* turn(dir, "tool")
        yield* llm.tool("deploy", { target: "prod" })
        // The tool writes its result itself and that write waits for the lock.
        const late = yield* lateTool(input, (write) => write())

        const run = yield* input.handle
          .process(input.input(late.tools))
          .pipe(limits({ budget: 20_000, outcome: 20_000, abort: 150 }), Effect.forkChild)
        yield* Effect.gen(function* () {
          while (!statuses(input.seen).some((status) => status.type === "retry")) yield* Effect.sleep("10 millis")
        }).pipe(Effect.timeout("5 seconds"))
        const started = Date.now()
        yield* Fiber.interrupt(run)
        expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true)
        expect(Date.now() - started).toBeLessThan(2_000)

        // The write was given up with the turn: freeing the database stores nothing.
        yield* Effect.promise(() => late.state.written.promise).pipe(Effect.timeout("2 seconds"))
        input.other.run("COMMIT")
        yield* Effect.sleep("400 millis")
        expect((yield* toolPart(input.msg.id))?.state.status).toBe("running")
        expect(late.state.runs).toBe(1)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

// A call that did not run has no outcome to keep: the note saying so waits for
// the database as long as any other write, not as long as a result.
const marker = (error: () => Error) =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const input = yield* turn(dir, "tool")
        yield* llm.tool("deploy", { target: "prod" })

        const started = Date.now()
        const exit = yield* input.handle
          .process(
            input.input({
              deploy: tool({
                description: "Deploy",
                inputSchema: z.object({ target: z.string() }),
                execute: async (): Promise<{ title: string; output: string; metadata: Record<string, never> }> => {
                  await running(input.msg.id)
                  input.other.run("BEGIN IMMEDIATE")
                  throw error()
                },
              }),
            }),
          )
          .pipe(limits({ budget: 200, outcome: 6_000, abort: 100 }), Effect.exit)
        const elapsed = Date.now() - started
        input.other.run("COMMIT")

        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(Database.LockedError)
        expect(elapsed).toBeGreaterThanOrEqual(190)
        expect(elapsed).toBeLessThan(3_000)
        expect(statuses(input.seen).some((status) => status.type === "retry")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  )

it.live("a refused call keeps the wait of any other write", () => marker(() => new PermissionV1.RejectedError()))

it.live("a call that was not executed keeps the wait of any other write", () =>
  marker(() => new Error(SessionProcessor.NOT_EXECUTED)),
)

it.live("aborting a turn with an open tool call under a held lock ends within the abort wait", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const input = yield* turn(dir, "tool abort")
        yield* llm.toolHang("bash", { cmd: "pwd" })

        // Any other write of this turn would wait 20 seconds for the lock.
        const run = yield* input.handle
          .process(input.input({}))
          .pipe(limits({ budget: 20_000, outcome: 20_000, abort: 150 }), Effect.forkChild)
        yield* llm.wait(1)
        yield* Effect.gen(function* () {
          while ((yield* toolPart(input.msg.id).pipe(Effect.provideService(Database.Service, database))) === undefined)
            yield* Effect.sleep("10 millis")
        }).pipe(Effect.timeout("2 seconds"))
        input.other.run("BEGIN IMMEDIATE")
        const started = Date.now()
        yield* Fiber.interrupt(run)
        const exit = yield* Fiber.await(run)
        const elapsed = Date.now() - started
        input.other.run("COMMIT")

        expect(Exit.isFailure(exit)).toBe(true)
        expect(elapsed).toBeGreaterThanOrEqual(140)
        expect(elapsed).toBeLessThan(1_500)
        // The abort marker could not be written: the call is left running,
        // which history reads as interrupted.
        expect(["pending", "running"]).toContain((yield* toolPart(input.msg.id))?.state.status ?? "")
        expect(statuses(input.seen).at(-1)?.type).toBe("idle")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("a running snapshot that waited for the lock never lands over the result written after it", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const input = yield* turn(dir, "order")
        const calls = Array.from({ length: 8 }, (_, index) => ({
          id: PartID.ascending(),
          messageID: input.msg.id,
          sessionID: input.sessionID,
          type: "tool" as const,
          callID: `call-${index}`,
          tool: "deploy",
        }))
        const start = Date.now()

        // Both writes of every call wait behind another process. The connection
        // is free between two tries, so without an order the later write (the
        // result) can commit first and the earlier one (running) replace it.
        input.other.run("BEGIN IMMEDIATE")
        const writes = yield* Effect.forEach(
          calls.flatMap((call) => [
            { ...call, state: { status: "running" as const, input: {}, time: { start } } },
            {
              ...call,
              state: {
                status: "completed" as const,
                input: {},
                output: "deployed",
                title: "Deploy",
                metadata: {},
                time: { start, end: start + 1 },
              },
            },
          ]),
          (part) =>
            input.session.updatePart(part).pipe(
              Effect.forkChild,
              Effect.tap(() => Effect.sleep("2 millis")),
            ),
        )
        yield* Effect.sleep("150 millis")
        input.other.run("COMMIT")
        yield* Effect.forEach(writes, Fiber.join)

        const stored = (yield* MessageV2.parts(input.msg.id)).filter((part) => part.type === "tool")
        expect(stored).toHaveLength(8)
        expect(stored.map((part) => part.state.status)).toEqual(Array.from({ length: 8 }, () => "completed"))
      }).pipe(limits({ budget: 5_000, outcome: 5_000, abort: 5_000 })),
    { config: (url) => providerCfg(url) },
  ),
)

it.effect("a database lock failure never replays the provider turn", () =>
  Effect.sync(() => {
    for (const message of [BUSY, QUEUED]) {
      const error = MessageV2.fromError(new Database.LockedError({ message, attempts: 12, waited: 60_000 }), {
        providerID: ref.providerID,
      })
      expect(error.name).toBe("UnknownError")
      expect("message" in error.data ? error.data.message : undefined).toBe(message)
      // The wait for the lock is the retry for this failure. A session retry
      // would send the provider request again to reach the same database, and
      // without a provider retry policy it would run the turn's tools again.
      expect(SessionRetry.retryable(error, "test")).toBeUndefined()
      expect(SessionRetry.retryable(error, "test", { maxAttempts: 200 })).toBeUndefined()
    }
  }),
)
