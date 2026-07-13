import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps, type TaskSessionOriginV1 } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// Stub provider that resolves the test model with a variants map so the
// override resolver can validate caller-specified variants.
const stubModel = {
  id: ref.modelID,
  providerID: ref.providerID,
  route: { type: "openai" as const, id: "test-model" },
  defaults: undefined,
  compatibility: undefined,
  variants: { xhigh: {}, max: {}, default: {} },
} as unknown as Provider.Model

const stubProviderInfo = {
  id: ref.providerID,
  name: "test",
  source: "config" as const,
  env: [],
  options: {},
  models: { [ref.modelID]: stubModel } as never,
}

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    list: () => Effect.succeed({ [ref.providerID]: stubProviderInfo } as never),
    getProvider: () => Effect.succeed(stubProviderInfo as never),
    getModel: (providerID, modelID) =>
      providerID === ref.providerID && modelID === ref.modelID
        ? Effect.succeed(stubModel)
        : Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID })),
    getLanguage: () => Effect.die("not implemented"),
    closest: () => Effect.succeed(undefined),
    getSmallModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.succeed({ providerID: ref.providerID, modelID: ref.modelID }),
  }),
)

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      Provider.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      [Provider.node, providerLayer],
    ],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  function taskCtx(opts: { sessionID: SessionID; messageID: MessageID; callID?: string; promptOps?: TaskPromptOps }) {
    return {
      sessionID: opts.sessionID,
      messageID: opts.messageID,
      agent: "build",
      abort: new AbortController().signal,
      callID: opts.callID,
      extra: { promptOps: opts.promptOps ?? stubOps() },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }
  }

  function originMeta(parentID: string, callID: string) {
    return { "opencode.task.origin": { version: 1, parentSessionID: parentID, tool: "task" as const, callID } }
  }

  // @ts-expect-error — version literal must be 1, not 2
  const _originBadVersion: TaskSessionOriginV1 = { version: 2, parentSessionID: "s", tool: "task", callID: "c" }
  // @ts-expect-error — callID is required
  const _originMissingField: TaskSessionOriginV1 = { version: 1, parentSessionID: "s", tool: "task" }

  it.instance("TaskSessionOriginV1 accepts valid shape", () =>
    Effect.gen(function* () {
      const valid: TaskSessionOriginV1 = {
        version: 1,
        parentSessionID: "ses_test",
        tool: "task",
        callID: "call_001",
      } satisfies TaskSessionOriginV1
      expect(valid.version).toBe(1)
    }),
  )

  it.instance("fresh creation: callID defined sets origin, undefined omits, empty string preserved", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      {
        const result = yield* def.execute(
          { description: "task", prompt: "p", subagent_type: "general" },
          taskCtx({ sessionID: chat.id, messageID: assistant.id, callID: "call_001" }),
        )
        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.metadata).toEqual(originMeta(chat.id, "call_001"))
      }

      {
        const result = yield* def.execute(
          { description: "task", prompt: "p", subagent_type: "general" },
          taskCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.metadata).toBeUndefined()
      }

      {
        const result = yield* def.execute(
          { description: "task", prompt: "p", subagent_type: "general" },
          taskCtx({ sessionID: chat.id, messageID: assistant.id, callID: "" }),
        )
        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.metadata).toEqual(originMeta(chat.id, ""))
      }
    }),
  )

  it.instance("same-parent task_id resumes child without second session.created or metadata overwrite", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const created = yield* Deferred.make<number>()
      let count = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === "session.created") {
          count++
          Deferred.doneUnsafe(created, Effect.succeed(count))
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const sentinelOrigin = { version: 1, parentSessionID: chat.id, tool: "task", callID: "sentinel" }
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        metadata: { "opencode.task.origin": sentinelOrigin },
      })

      const firstCount = yield* awaitWithTimeout(Deferred.await(created), "timed out waiting for first session.created")
      expect(firstCount).toBe(1)

      const result = yield* def.execute(
        { description: "task", prompt: "p", subagent_type: "general", task_id: child.id },
        taskCtx({ sessionID: chat.id, messageID: assistant.id, callID: "call_resume" }),
      )

      // Synchronous dispatch contract: execute completed means no second session.created
      expect(count).toBe(1)

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)

      // Metadata unchanged (resume does not overwrite)
      const persisted = yield* sessions.get(child.id)
      expect(persisted.metadata).toEqual({ "opencode.task.origin": sentinelOrigin })
    }),
  )

  it.instance("nonexistent and foreign-parent task_id both create fresh child with current callID origin", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const foreignParent = yield* sessions.create({ title: "Foreign parent" })
      const foreignChild = yield* sessions.create({ parentID: foreignParent.id, title: "Foreign child" })

      const res1 = yield* def.execute(
        { description: "task", prompt: "p", subagent_type: "general", task_id: "ses_nonexistent" },
        taskCtx({ sessionID: chat.id, messageID: assistant.id, callID: "call_nonexistent" }),
      )
      expect(res1.metadata.sessionId).not.toBe("ses_nonexistent")
      const c1 = yield* sessions.get(res1.metadata.sessionId)
      expect(c1.parentID).toBe(chat.id)
      expect(c1.metadata).toEqual(originMeta(chat.id, "call_nonexistent"))

      const res2 = yield* def.execute(
        { description: "task", prompt: "p", subagent_type: "general", task_id: foreignChild.id },
        taskCtx({ sessionID: chat.id, messageID: assistant.id, callID: "call_foreign" }),
      )
      expect(res2.metadata.sessionId).not.toBe(foreignChild.id)
      const c2 = yield* sessions.get(res2.metadata.sessionId)
      expect(c2.parentID).toBe(chat.id)
      expect(c2.metadata).toEqual(originMeta(chat.id, "call_foreign"))

      const foreignKids = yield* sessions.children(foreignParent.id)
      expect(foreignKids).toHaveLength(1)
      expect(foreignKids[0]?.id).toBe(foreignChild.id)

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(2)
      expect(kids.map((k) => k.id).sort()).toEqual([res1.metadata.sessionId, res2.metadata.sessionId].sort())

      yield* sessions.remove(foreignChild.id)
      yield* sessions.remove(foreignParent.id)
    }),
  )

  it.instance("forged params: excess metadata is rejected by types and ignored at runtime", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "task",
          prompt: "p",
          subagent_type: "general",
          // @ts-expect-error — Parameters deliberately excludes model-controlled metadata
          metadata: {
            "opencode.task.origin": {
              version: 1,
              parentSessionID: "ses_forged",
              tool: "task",
              callID: "call_forged",
            },
            "unrelated.forge": true,
          },
        },
        taskCtx({ sessionID: chat.id, messageID: assistant.id, callID: "call_real" }),
      )

      const child = yield* sessions.get(result.metadata.sessionId)
      // Origin set from ctx.callID, not from forged params
      expect(child.metadata).toEqual(originMeta(chat.id, "call_real"))
      // Exact top-level key — no forged keys leaked
      expect(Object.keys(child.metadata!)).toEqual(["opencode.task.origin"])
    }),
  )

  it.instance("EventV2Bridge: session.created event captured before prompt with exact origin", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const callID = "call_evt_origin"

      const order: ("event" | "prompt")[] = []
      const captured = yield* Deferred.make<{ sessionID: string; info: { id: string; parentID?: string; metadata?: Record<string, unknown> } }>()
      const unsub = yield* events.listen((event) => {
        if (event.type === "session.created") {
          const data = event.data as { sessionID: string; info: { id: string; parentID?: string; metadata?: Record<string, unknown> } }
          const origin = data.info.metadata?.["opencode.task.origin"] as { callID: string } | undefined
          if (origin?.callID === callID) {
            order.push("event")
            Deferred.doneUnsafe(captured, Effect.succeed(data))
          }
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      let promptInput: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({
        onPrompt: (input) => {
          order.push("prompt")
          promptInput = input
        },
      })

      const result = yield* def.execute(
        { description: "task", prompt: "p", subagent_type: "general" },
        taskCtx({ sessionID: chat.id, messageID: assistant.id, callID, promptOps }),
      )

      const evidence = yield* awaitWithTimeout(Deferred.await(captured), "timed out waiting for session.created event")
      expect(evidence.sessionID).toBe(result.metadata.sessionId)
      expect(evidence.info.id).toBe(result.metadata.sessionId)
      expect(evidence.info.parentID).toBe(chat.id)
      expect(evidence.info.metadata).toEqual(originMeta(chat.id, callID))
      expect(promptInput?.sessionID).toBe(result.metadata.sessionId)
      expect(order).toEqual(["event", "prompt"])
    }),
  )

  it.instance("post-create prompt failure: origin event captured, child queryable, failure observed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const callID = "call_fail_origin"

      const captured = yield* Deferred.make<{ sessionID: string; info: { id: string; metadata?: Record<string, unknown> } }>()
      const unsub = yield* events.listen((event) => {
        if (event.type === "session.created") {
          const data = event.data as { sessionID: string; info: { id: string; metadata?: Record<string, unknown> } }
          Deferred.doneUnsafe(captured, Effect.succeed(data))
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: () => Effect.succeed([{ type: "text" as const, text: "prompt" }]),
        prompt: () => Effect.sync(() => { throw new Error("simulated prompt failure") }),
      }

      const exit = yield* def.execute(
        { description: "task", prompt: "p", subagent_type: "general" },
        taskCtx({ sessionID: chat.id, messageID: assistant.id, callID, promptOps }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)

      const evidence = yield* awaitWithTimeout(Deferred.await(captured), "timed out waiting for session.created event")
      expect(evidence.info.metadata).toEqual(originMeta(chat.id, callID))

      const child = yield* sessions.get(SessionID.make(evidence.sessionID))
      expect(child.metadata).toEqual(originMeta(chat.id, callID))

      // Background job created with error status (no after-hook claim of success)
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.get(evidence.sessionID)
      expect(job).toBeDefined()
      expect(job?.status).toBe("error")
      expect(job?.error).toBe("simulated prompt failure")
    }),
  )

  it.instance("two concurrent TaskTool calls: distinct callID → child ID → event bijection", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const callID1 = "concurrent_a"
      const callID2 = "concurrent_b"

      // Subscribe once — collect events keyed by callID
      const eventMap = yield* Deferred.make<Map<string, { sessionID: string; info: { id: string; parentID?: string; metadata?: Record<string, unknown> } }>>()
      const map = new Map<string, { sessionID: string; info: { id: string; parentID?: string; metadata?: Record<string, unknown> } }>()
      const unsub = yield* events.listen((event) => {
        if (event.type === "session.created") {
          const data = event.data as { sessionID: string; info: { id: string; parentID?: string; metadata?: Record<string, unknown> } }
          const origin = data.info.metadata?.["opencode.task.origin"] as { callID: string } | undefined
          if (origin?.callID) {
            map.set(origin.callID, data)
            if (map.size >= 2) Deferred.doneUnsafe(eventMap, Effect.succeed(new Map(map)))
          }
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const ctxBase = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: {} as { promptOps: TaskPromptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const results = yield* Effect.all(
        [
          def.execute(
            { description: "task a", prompt: "prompt a", subagent_type: "general" },
            { ...ctxBase, callID: callID1, extra: { promptOps: stubOps({ text: "done_a" }) } },
          ),
          def.execute(
            { description: "task b", prompt: "prompt b", subagent_type: "general" },
            { ...ctxBase, callID: callID2, extra: { promptOps: stubOps({ text: "done_b" }) } },
          ),
        ],
        { concurrency: "unbounded" },
      )

      const result1 = results[0]
      const result2 = results[1]

      const evidence = yield* awaitWithTimeout(Deferred.await(eventMap), "timed out waiting for both session.created events")
      const ev1 = evidence.get(callID1)
      const ev2 = evidence.get(callID2)
      expect(ev1).toBeDefined()
      expect(ev2).toBeDefined()
      if (!ev1 || !ev2) throw new Error("missing event evidence")

      expect(ev1.sessionID).toBe(result1.metadata.sessionId)
      expect(ev1.info.id).toBe(result1.metadata.sessionId)
      expect(ev1.info.parentID).toBe(chat.id)
      expect(ev2.sessionID).toBe(result2.metadata.sessionId)
      expect(ev2.info.id).toBe(result2.metadata.sessionId)
      expect(ev2.info.parentID).toBe(chat.id)

      expect(result1.metadata.sessionId).not.toBe(result2.metadata.sessionId)

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(2)
      const ids = kids.map((k) => k.id).sort()
      expect(ids).toEqual([result1.metadata.sessionId, result2.metadata.sessionId].sort())
    }),
  )
})