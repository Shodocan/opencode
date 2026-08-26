import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { SessionID } from "../../src/session/schema"
import { Snapshot } from "../../src/snapshot"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"

// Site tests for the tool.execute.finally wiring at the handleSubtask direct
// task execution site in packages/opencode/src/session/prompt.ts. Harness
// copied from test/session/prompt.test.ts; the Plugin service is replaced so
// a recording trigger observes every trigger the loop fires.

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

type Event = { name: string; input: any; output: unknown }

function recordingTrigger(events: Event[], dieOnBefore?: string) {
  return ((name: unknown, input: any, output: unknown) => {
    events.push({ name: name as string, input, output })
    if (dieOnBefore !== undefined && name === "tool.execute.before" && input?.tool === dieOnBefore)
      return Effect.die(new Error("before hook exploded"))
    return Effect.succeed(output)
  }) as Plugin.Interface["trigger"]
}

function pluginNode(trigger: Plugin.Interface["trigger"]) {
  return LayerNode.make({
    service: Plugin.Service,
    layer: Layer.succeed(
      Plugin.Service,
      Plugin.Service.of({
        trigger,
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      }),
    ),
    deps: [],
  })
}

function makePrompt(input: { trigger: Plugin.Interface["trigger"]; processor?: "blocking" }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [Plugin.node, pluginNode(input.trigger)],
  ] as const
  if (input.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input: { trigger: Plugin.Interface["trigger"] }) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [Plugin.node, pluginNode(input.trigger)],
  ] as const
  return LayerNode.compile(root, replacements)
}

const successEvents: Event[] = []
const withLLM = testEffect(makeHttp({ trigger: recordingTrigger(successEvents) }))

const errorEvents: Event[] = []
const noLLM = testEffect(makePrompt({ trigger: recordingTrigger(errorEvents) }))

const beforeRejectEvents: Event[] = []
const noLLMBeforeReject = testEffect(makePrompt({ trigger: recordingTrigger(beforeRejectEvents, "task") }))

const interruptEvents: Event[] = []
const noLLMBlocking = testEffect(makePrompt({ trigger: recordingTrigger(interruptEvents), processor: "blocking" }))

const subtaskPart = (agent: string) => ({
  type: "subtask" as const,
  prompt: "look into the cache key path",
  description: "inspect bug",
  agent,
})

function taskToolPartOf(msgs: SessionV1.WithParts[]) {
  return msgs
    .flatMap((m) => m.parts)
    .find((p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === "task")
}

describe("session prompt handleSubtask tool.execute.finally", () => {
  withLLM.instance(
    "subtask completion fires before, after, then exactly one success finally with the task args and origin",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Parent" })
        const taskOrigin = { version: 1 as const, parentSessionID: SessionID.make("ses_origin_parent"), taskCallID: "call_origin" }
        yield* llm.text("subtask done")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [subtaskPart("general")],
          taskOrigin,
        })
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const taskPart = taskToolPartOf(msgs)
        expect(taskPart).toBeDefined()
        if (!taskPart) return
        expect(taskPart.state.status).toBe("completed")
        const toolEvents = successEvents.filter((e) => e.name.startsWith("tool.execute."))
        expect(toolEvents.map((e) => [e.name, e.input.tool, e.input.callID])).toEqual([
          ["tool.execute.before", "task", taskPart.callID],
          ["tool.execute.after", "task", taskPart.callID],
          ["tool.execute.finally", "task", taskPart.callID],
        ])
        const fin = toolEvents[2].input
        expect(fin.sessionID).toBe(chat.id)
        expect(fin.args).toMatchObject({
          prompt: "look into the cache key path",
          description: "inspect bug",
          subagent_type: "general",
        })
        expect(fin.taskOrigin).toEqual(taskOrigin)
        expect(fin.outcome).toBe("success")
        expect(fin.error).toBeUndefined()
      }),
  )

  noLLM.instance(
    "subtask with an unknown agent fails the loop, fires exactly one error finally, and no after",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Parent" })
        const exit = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [subtaskPart("does-not-exist")],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.squash(exit.cause) as Error
        expect(error.name).toBe("UnknownError")
        const errorData = (error as any).data as { message?: string } | undefined
        expect(errorData?.message ?? String(error.message)).toContain('Agent not found: "does-not-exist".')
        const toolEvents = errorEvents.filter((e) => e.name.startsWith("tool.execute."))
        expect(toolEvents.map((e) => e.name)).toEqual(["tool.execute.before", "tool.execute.finally"])
        const fin = toolEvents[1].input
        expect(fin.tool).toBe("task")
        expect(fin.sessionID).toBe(chat.id)
        expect(fin.callID).toBe(toolEvents[0].input.callID)
        expect(fin.outcome).toBe("error")
        expect(fin.error).toEqual({ name: error.name, message: String(error.message).slice(0, 500) })
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const taskPart = taskToolPartOf(msgs)
        expect(taskPart).toBeDefined()
        if (taskPart) expect(toolEvents[0].input.callID).toBe(taskPart.callID)
      }),
    { config: cfg },
  )

  noLLMBeforeReject.instance(
    "a dying before hook fails the loop with that rejection and fires no after and no finally",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Parent" })
        const exit = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [subtaskPart("general")],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.squash(exit.cause)
        expect(String(error)).toContain("before hook exploded")
        const toolEvents = beforeRejectEvents.filter((e) => e.name.startsWith("tool.execute."))
        expect(toolEvents.map((e) => e.name)).toEqual(["tool.execute.before"])
      }),
    { config: cfg },
  )

  noLLMBlocking.instance(
    "an interrupted subtask fires exactly one cancelled finally and no after",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Parent" })
        const fiber = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [subtaskPart("general")],
          })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.sync(() => (interruptEvents.some((e) => e.name === "tool.execute.before") ? true : undefined)),
          "timed out waiting for the task before hook",
        )
        yield* Fiber.interrupt(fiber)
        yield* Fiber.await(fiber)
        const toolEvents = interruptEvents.filter((e) => e.name.startsWith("tool.execute."))
        expect(toolEvents.map((e) => e.name)).toEqual(["tool.execute.before", "tool.execute.finally"])
        const fin = toolEvents[1].input
        expect(fin.tool).toBe("task")
        expect(fin.sessionID).toBe(chat.id)
        expect(fin.outcome).toBe("cancelled")
        expect(fin.error).toBeUndefined()
      }),
    { config: cfg },
    15_000,
  )
})
