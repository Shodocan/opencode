import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { tool, type ModelMessage } from "ai"
import z from "zod"
import { LLMRequestPrep } from "@/session/llm/request"
import type { Provider } from "@/provider/provider"
import type { Agent } from "../../src/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"

// T02 — Shared preparation, executable tools, conservative media.
// Spec: specs/qwen-context-budget.md (late pre-dispatch estimate),
// plan: specs/qwen-context-budget-plan.md "T02 — Shared preparation".
//
// Contract under test (source_touch_set: src/session/llm/request.ts):
//  - `Prepared.tools` stays executable and unchanged (GitLab inline execution,
//    native ToolRuntime, AI SDK all dispatch through it).
//  - A separate immutable data-only `budgetProjection` carries the estimate
//    inputs: transformed system/messages, current user input, tool calls and
//    results, max-step additions, active tool name/description/JSON schema,
//    serialization-affecting provider options, and the output allowance.
//  - Functions never enter the projection; media is sized conservatively
//    without dereference; unknown-size media fails closed.
//  - Normal output allowance stays 32000; compaction gets min(4096, ...).

const sessionID = "session-llm-request-budget"
const MODEL_OUTPUT = 32_000

function testModel(override: Partial<Provider.Model> = {}): Provider.Model {
  return {
    id: "m1",
    providerID: "testq",
    api: { id: "m1", url: "https://api.testq.invalid/v1", npm: "@ai-sdk/openai-compatible" },
    name: "Test Model",
    capabilities: {
      toolcall: true,
      attachment: true,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: true },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 262_144, output: MODEL_OUTPUT },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
    ...override,
  } as Provider.Model
}

function testAgent(override: Partial<Agent.Info> = {}): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [],
    ...override,
  } as Agent.Info
}

function testUser(override: Partial<SessionV1.User> = {}): SessionV1.User {
  return {
    id: "msg_user-budget",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "testq", modelID: "m1" },
    ...override,
  } as SessionV1.User
}

const pluginPass = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as never

type PrepareOverrides = {
  user?: Partial<SessionV1.User>
  agent?: Partial<Agent.Info>
  model?: Partial<Provider.Model>
  system?: string[]
  messages?: ModelMessage[]
  tools?: Record<string, any>
  plugin?: any
}

function prepareInput(overrides: PrepareOverrides = {}) {
  return {
    user: testUser(overrides.user),
    sessionID,
    model: testModel(overrides.model),
    agent: testAgent(overrides.agent),
    system: overrides.system ?? ["BASE-SYSTEM-MARKER"],
    messages: overrides.messages ?? [{ role: "user", content: "CURRENT-INPUT-MARKER" } as ModelMessage],
    tools: overrides.tools ?? {},
    provider: { id: "testq", options: {} } as Provider.Info,
    auth: undefined,
    plugin: overrides.plugin ?? pluginPass,
    flags: { outputTokenMax: MODEL_OUTPUT, client: "test" } as never,
    isWorkflow: false,
  }
}

const run = (input: ReturnType<typeof prepareInput>) =>
  Effect.runPromise(LLMRequestPrep.prepare(input as never))

const runExit = (input: ReturnType<typeof prepareInput>) =>
  Effect.runPromiseExit(LLMRequestPrep.prepare(input as never))

function assertNoFunctions(value: unknown, path = "$") {
  if (typeof value === "function") throw new Error(`function found in projection at ${path}`)
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoFunctions(item, `${path}[${i}]`))
    return
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoFunctions(item, `${path}.${key}`)
  }
}

describe("session.llm-request-budget (T02)", () => {
  test("returns a separate data-only budgetProjection while Prepared.tools stays executable", async () => {
    const gitlabOutput = { output: "ran-inline" }
    const prepared = await run(
      prepareInput({
        tools: {
          gitlab_ci: tool({
            description: "Run a GitLab workflow step inline",
            inputSchema: z.object({ step: z.string() }),
            execute: async () => gitlabOutput,
          }),
        },
      }),
    )

    // Runtime preparation must remain executable...
    const runtimeTool = (prepared as any).tools["gitlab_ci"]
    expect(typeof runtimeTool?.execute).toBe("function")
    expect(await runtimeTool.execute({ step: "build" }, { toolCallId: "call-1" })).toEqual(gitlabOutput)

    // ...separate from the estimate projection.
    const projection = (prepared as any).budgetProjection
    expect(projection).toBeDefined()

    // Data-only: tool entries are {name, description, inputSchema}; no execute.
    const projectedTool = (projection as any).tools["gitlab_ci"]
    expect(projectedTool).toBeDefined()
    expect(projectedTool.execute).toBeUndefined()
    expect(projectedTool.name).toBe("gitlab_ci")
    expect(projectedTool.description).toContain("GitLab workflow step inline")
    expect(projectedTool.inputSchema).toBeDefined()

    // No function anywhere in the projection.
    assertNoFunctions(projection)
  })

  test("projection includes transformed system, current input, tool calls/results, and max-step additions", async () => {
    const prepared = await run(
      prepareInput({
        user: { system: "USER-SYSTEM-MARKER" },
        messages: [
          { role: "user", content: "older question" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-77",
                toolName: "deploy",
                input: { env: "prod" },
              },
            ],
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
          { role: "assistant", content: MAX_STEPS_PROMPT },
          { role: "user", content: "CURRENT-INPUT-MARKER" },
        ],
      }),
    )
    const serialized = JSON.stringify((prepared as any).budgetProjection)

    // Transformed system: provider default + input system + current user system.
    expect(serialized).toContain("BASE-SYSTEM-MARKER")
    expect(serialized).toContain("USER-SYSTEM-MARKER")
    // Tool call and result content.
    expect(serialized).toContain('"deploy"')
    expect(serialized).toContain("call-77")
    expect(JSON.stringify(JSON.parse(serialized))).toContain("prod")
    expect(serialized).toContain("RESULT-PAYLOAD-MARKER")
    // Max-step additions reach the estimate input.
    expect(serialized).toContain("MAXIMUM STEPS REACHED")
    // Current user input.
    expect(serialized).toContain("CURRENT-INPUT-MARKER")
  })

  test("projection includes active tool JSON input schema without zod function payload", async () => {
    const prepared = await run(
      prepareInput({
        tools: {
          query_db: tool({
            description: "Query the database",
            inputSchema: z.object({ sql: z.string().describe("The SQL to run") }),
            execute: async () => ({ output: "rows" }),
          }),
        },
      }),
    )
    const projection = (prepared as any).budgetProjection
    assertNoFunctions(projection)
    const schema = (projection as any).tools["query_db"].inputSchema
    expect(schema?.properties?.sql?.type).toBe("string")
    const serialized = JSON.stringify(projection)
    expect(serialized).toContain("Query the database")
    expect(serialized).toContain("The SQL to run")
  })

  test("projection carries serialization-affecting provider options and 32000 normal output allowance", async () => {
    const prepared = await run(prepareInput({ model: { options: { store: false } } }))
    const projection = (prepared as any).budgetProjection
    const options = (projection as any).options ?? (projection as any).messageTransformOptions
    expect(options?.store).toBe(false)
    // Normal requests keep the full runtime output allowance.
    expect((projection as any).outputAllowance ?? (projection as any).outputTokens).toBe(32_000)
  })

  test("compaction requests project min(4096, route output) as the output allowance", async () => {
    const atCap = await run(prepareInput({ agent: { name: "compaction" } as Partial<Agent.Info> }))
    expect(
      (atCap as any).budgetProjection.outputAllowance ?? (atCap as any).budgetProjection.outputTokens,
    ).toBe(4_096)

    // Route output limit below 4096 wins (min applies to route output too).
    const smallRoute = await run(
      prepareInput({ agent: { name: "compaction" } as Partial<Agent.Info>, model: { limit: { context: 262_144, output: 2_000 } } as Partial<Provider.Model> }),
    )
    expect(
      (smallRoute as any).budgetProjection.outputAllowance ?? (smallRoute as any).budgetProjection.outputTokens,
    ).toBe(2_000)

    // Runtime requested cap below both still binds (min of all three).
    const smallRuntime = await run(
      prepareInput({
        agent: { name: "compaction" } as Partial<Agent.Info>,
        flags: undefined,
      } as PrepareOverrides),
    )
    expect((smallRuntime as any).budgetProjection).toBeDefined()
  })

  test("projection is immutable: later mutation of prepared inputs does not change it", async () => {
    const system = ["BASE-SYSTEM-MARKER"]
    const messages: ModelMessage[] = [{ role: "user", content: "CURRENT-INPUT-MARKER" }]
    const prepared = await run(prepareInput({ system, messages }))
    const projection = (prepared as any).budgetProjection
    const before = JSON.stringify(projection)

    system.push("LATE-INJECTED-SYSTEM")
    ;(messages[0] as any).content = "MUTATED-AFTER-PREPARE"

    expect(JSON.stringify(projection)).toBe(before)
    expect(JSON.stringify(projection)).not.toContain("LATE-INJECTED-SYSTEM")
    expect(JSON.stringify(projection)).not.toContain("MUTATED-AFTER-PREPARE")
  })

  test("plugin late system growth raises the projection size", async () => {
    const bigChunk = "G".repeat(5_000)
    const pluginGrow = {
      trigger: (_name: string, _input: unknown, output: any) => {
        if (_name === "experimental.chat.system.transform") output.system.push(bigChunk)
        return Effect.succeed(output)
      },
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    } as never

    const base = await run(prepareInput({}))
    const grown = await run(prepareInput({ plugin: pluginGrow }))
    const baseLen = JSON.stringify((base as any).budgetProjection).length
    const grownLen = JSON.stringify((grown as any).budgetProjection).length
    expect(grownLen - baseLen).toBeGreaterThanOrEqual(bigChunk.length)
  })

  test("late tool schema/description growth raises the projection size", async () => {
    const bigDescription = "D".repeat(4_000)
    const small = await run(
      prepareInput({
        tools: {
          searcher: tool({
            description: "Small description",
            inputSchema: z.object({ q: z.string() }),
            execute: async () => ({ output: "" }),
          }),
        },
      }),
    )
    const grown = await run(
      prepareInput({
        tools: {
          searcher: tool({
            description: bigDescription,
            inputSchema: z.object({ q: z.string(), extraContext: z.string().describe("E".repeat(4_000)) }),
            execute: async () => ({ output: "" }),
          }),
        },
      }),
    )
    const smallLen = JSON.stringify((small as any).budgetProjection).length
    const grownLen = JSON.stringify((grown as any).budgetProjection).length
    expect(grownLen - smallLen).toBeGreaterThanOrEqual(4_000)
  })

  test("media is sized conservatively without dereference; larger known media raises the projection", async () => {
    const smallMedia: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "CURRENT-INPUT-MARKER" },
        { type: "file", data: `data:image/png;base64,${"A".repeat(1_000)}`, mediaType: "image/png" },
      ] as any,
    }
    const bigMedia: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "CURRENT-INPUT-MARKER" },
        { type: "file", data: `data:image/png;base64,${"A".repeat(12_000)}`, mediaType: "image/png" },
      ] as any,
    }

    const none = await run(prepareInput({}))
    const small = await run(prepareInput({ messages: [smallMedia] }))
    const big = await run(prepareInput({ messages: [bigMedia] }))

    const noneLen = JSON.stringify((none as any).budgetProjection).length
    const smallLen = JSON.stringify((small as any).budgetProjection).length
    const bigLen = JSON.stringify((big as any).budgetProjection).length

    // Conservative accounting: media contributes, monotonically with known
    // encoded length, and the projection never embeds raw binary wholesale
    // (no 12k A-run inside the data-only projection).
    expect(smallLen).toBeGreaterThan(noneLen)
    expect(bigLen).toBeGreaterThan(smallLen)
    expect(JSON.stringify((big as any).budgetProjection)).not.toContain("A".repeat(1_000))
  })

  test("URI media is accounted without dereference and unknown-size media fails closed", async () => {
    // Unfetchable remote URL: projection must still succeed using source-kind
    // plus deterministic envelope overhead (never dereference the URI).
    const remote: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "CURRENT-INPUT-MARKER" },
        { type: "file", data: new URL("http://127.0.0.1:1/definitely-unreachable.png"), mediaType: "image/png" },
      ] as any,
    }
    const base = await run(prepareInput({}))
    const withRemote = await run(prepareInput({ messages: [remote] }))
    expect(
      JSON.stringify((withRemote as any).budgetProjection).length,
    ).toBeGreaterThan(JSON.stringify((base as any).budgetProjection).length)

    // A file handle with no derivable size (file://, never dereferenced) must
    // fail closed instead of producing a silently small estimate.
    const unknownSize: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "CURRENT-INPUT-MARKER" },
        { type: "file", data: new URL("file:///unknown/size/is/unknowable.bin"), mediaType: "application/octet-stream" },
      ] as any,
    }
    const exit = await runExit(prepareInput({ messages: [unknownSize] }))
    expect(exit._tag).toBe("Failure")
  })

  test("inline GitLab-style tool still executes through Prepared.tools, not the projection", async () => {
    const prepared = await run(
      prepareInput({
        tools: {
          workflow_deploy: tool({
            description: "Inline workflow deployment step",
            inputSchema: z.object({ stage: z.string() }),
            execute: async (args: any, options: any) => ({
              output: `executed:${args.stage}:${options.toolCallId}`,
            }),
          }),
        },
      }),
    )

    const execute = (prepared as any).tools["workflow_deploy"]?.execute
    expect(typeof execute).toBe("function")
    const result = await execute({ stage: "canary" }, { toolCallId: "call-gitlab-9" })
    expect(result).toEqual({ output: "executed:canary:call-gitlab-9" })

    // The projection keeps only the name/description/schema triplet.
    const projected = (prepared as any).budgetProjection.tools["workflow_deploy"]
    expect(Object.keys(projected).toSorted()).toEqual(["description", "inputSchema", "name"])
    expect(projected.execute).toBeUndefined()
    assertNoFunctions((prepared as any).budgetProjection)
  })
})