import { expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Agent } from "../../src/agent/agent"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { Session } from "../../src/session/session"
import { SessionTools } from "../../src/session/tools"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ToolRegistry } from "../../src/tool/registry"
import { TaskTool } from "../../src/tool/task"
import { Config } from "../../src/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { BackgroundJob } from "../../src/background/job"
import { SessionRunState } from "../../src/session/run-state"
import { Truncate } from "../../src/tool/truncate"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const parent = SessionID.make("ses_validation_error_parent")
const call = "validation-error-call"
const agent: Agent.Info = { name: "build", mode: "primary", options: {}, permission: [] }
const model = { providerID: ProviderV2.ID.make("opencode-route"), api: { id: "qwen3.8-thinking" } } as Provider.Model
let childCreations = 0
let providerPrompts = 0
const it = testEffect(Layer.mergeAll(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, Config.node, Database.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty], [Account.node, AccountTest.empty], [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
  Layer.mock(Permission.Service, { ask: () => Effect.void }),
  Layer.mock(MCP.Service, { tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) }),
  Layer.mock(Truncate.Service, { output: text => Effect.succeed({ content: text, truncated: false }) }),
  RuntimeFlags.layer({ disableDefaultPlugins: true }),
  Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
  Layer.mock(BackgroundJob.Service, {}),
  Layer.mock(SessionRunState.Service, {}),
  Layer.mock(Session.Service, { createTaskChild: () => Effect.sync(() => { childCreations++; throw new Error("unexpected child creation") }) }),
  Layer.mock(Provider.Service, { getModel: () => Effect.succeed({ variants: {} } as Provider.Model) }),

))

it.instance("a failing error observer cannot strand a workflow claim after native Task validation rejects before child creation", () => Effect.gen(function* () {
  const fixture = yield* TestInstance
  const stateRoot = path.join(fixture.directory, "workflow-state")
  const proofPath = path.join(fixture.directory, "native-error-proof.json")
  const observer = path.join(fixture.directory, "failing-observer.ts")
  const first = path.join(fixture.directory, "workflow-plugin.ts")
  const second = path.join(fixture.directory, "recording-observer.ts")
  const workflowRoot = process.env.WORKFLOWS_REPO_ROOT ?? "/tmp/workflows-v4.3.0"
  yield* Effect.promise(() => Bun.write(observer,
    `export default async () => ({'tool.execute.error': async () => {throw new Error('unrelated observer failed')}});\n`))
  yield* Effect.promise(() => Bun.write(first,
    `import plugin from ${JSON.stringify(path.join(workflowRoot, "src/v02/server/index.ts"))};\n` +
    `export default async input => plugin.server(input, {stateDir:${JSON.stringify(stateRoot)},parentWakeup:'disabled',requireNativeWorkflowRuntime:true});\n`))
  yield* Effect.promise(() => Bun.write(second,
    `import fs from 'node:fs'; export default async () => ({\n` +
    `'tool.execute.error': async (input,output) => {if(input.tool==='task')fs.writeFileSync(${JSON.stringify(proofPath)},JSON.stringify({input,output}));}\n` +
    `});\n`))
  yield* Effect.promise(() => Bun.write(path.join(fixture.directory, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(observer).href, pathToFileURL(first).href, pathToFileURL(second).href],
  })))
  const plugins = yield* Plugin.Service
  const hooks = yield* plugins.list()
  const workflowHooks = hooks.find(hook => hook.tool?.workflow)
  expect(workflowHooks, "real workflow plugin must load after the failing observer").toBeDefined()
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    for (const hook of hooks) await (hook as unknown as { dispose?: () => Promise<void> }).dispose?.()
  }))
  const context = { sessionID: parent, directory: fixture.directory, worktree: fixture.directory, messageID: "parent-message",
    agent: "architect", abort: new AbortController().signal, metadata() {}, async ask() {} }
  const workflow = { schema_version: "1.1", workflow_id: "before-chain", workflow_revision: 1, executor: "native_interactive",
    policies: { allow_add_phase: false, allow_add_node: false, max_dynamic_additions: 0, allowed_subagents: ["code-scout"] },
    phases: [{ phase_id: "review", title: "Review", strategy: "serial", nodes: [{ kind: "subagent", node_id: "worker",
      description: "Read the supplied request", subagent_type: "code-scout", prompt: "Read only.",
      model: { providerID: "opencode-route", id: "qwen3.8-thinking", variant: "xhigh" } }] }] }
  const start: any = yield* Effect.promise(() => workflowHooks!.tool!.workflow.execute({ action: "start", workflow,
    args: { request: "Read-only regression for native validation rejecting an already claimed Task." } }, context as never))
  const output = typeof start === "string" ? start : start.output
  expect(output).not.toMatch(/^Error:/)
  const runID = output.match(/Run ID: `([^`]+)`/)?.[1]
  const storeModule = path.join(workflowRoot, "src/v02/store.ts")
  const { JournalStore } = yield* Effect.promise(() => import(storeModule))
  const journal = new JournalStore(stateRoot)
  const card = journal.replay(runID).nodes.worker.attempts[0].dispatchCard
  const messageID = MessageID.ascending()
  let part: SessionV1.ToolPart = { id: PartID.ascending(), sessionID: parent, messageID, type: "tool", tool: "task", callID: call,
    state: { status: "running", input: {}, time: { start: 1 } } }
  const nativeTool = yield* TaskTool
  const nativeDefinition = yield* nativeTool.init()
  const tools = yield* SessionTools.resolve({ agent, model, session: { id: parent, permission: [] } as unknown as Session.Info,
    processor: { message: { id: messageID, sessionID: parent, role: "assistant", parentID: MessageID.ascending(), agent: "build", mode: "build",
      path: { cwd: fixture.directory, root: fixture.directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("qwen3.8-thinking"), providerID: ProviderV2.ID.make("opencode-route"), time: { created: 1 } },
      updateToolCall: (_id, update) => Effect.sync(() => { part = update(part); return part }), completeToolCall: () => Effect.void },
    bypassAgentCheck: false, messages: [], promptOps: { cancel: () => Effect.void, resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.sync(() => { providerPrompts++; throw new Error("unexpected provider prompt") }) } }).pipe(
    Effect.provide(Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([{ id: "task", ...nativeDefinition }]) })))
  const result = yield* Effect.promise(async () => {
    try { await tools.task.execute!({ description: card.description, prompt: card.prompt, subagent_type: card.subagent_type, model: card.model },
      { toolCallId: call, abortSignal: new AbortController().signal, messages: [] }); return "unexpected success" }
    catch (error) { return String(error) }
  })
  expect(childCreations).toBe(0)
  expect(providerPrompts).toBe(0)
  expect(part.state).toMatchObject({ metadata: { taskExecution: { started: false, localQuiescence: true } } })
  const state = journal.replay(runID)
  const attempt = state.nodes.worker.attempts.find((value: any) => value.taskCallID === call)
  expect(attempt, "first real plugin must durably claim this exact call").toBeDefined()
  expect(attempt.childSessionID).toBeUndefined()
  expect(attempt.nativeNotStarted, "native prepare proof must survive an unrelated observer failure").toBe(true)
  expect(attempt.completedAt).toBeTypeOf("string")
  expect(attempt.status).not.toBe("accepted")
  expect(attempt.resultLease?.seal).toBeUndefined()
  const proof = yield* Effect.promise(() => Bun.file(proofPath).json())
  expect(proof).toMatchObject({ input: { tool: "task", sessionID: parent, callID: call },
    output: { metadata: { taskExecution: { started: false, localQuiescence: true } } } })
  const status: any = yield* Effect.promise(() => workflowHooks!.tool!.workflow.execute({ action: "status", runID }, context as never))
  expect(typeof status === "string" ? status : status.output).not.toMatch(/reconciliation_required/)
  expect(result).toContain("Unsupported explicit task model variant")
}).pipe(Effect.ensuring(Effect.promise(disposeAllInstances))))
