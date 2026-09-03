import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { HttpRecorderInternal } from "@opencode-ai/http-recorder/internal"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { eq, asc } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { describe, expect } from "bun:test"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ContextBudget } from "../../src/session/overflow"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { Instruction } from "../../src/session/instruction"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { SystemPrompt } from "../../src/session/system"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { LLM } from "../../src/session/llm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// ─── T06 RED contract ────────────────────────────────────────────────────────
//
// The cassette is credential-free no-regression evidence: it replays the
// Qwen-shaped one-shot overflow cycle (history, late provider-reported usage
// overflow, one 4,096-summary compaction, one 32,000 rebuild) against the
// recorded HTTP client on the NATIVE runtime (experimentalNativeLlm; the
// repo's supported recording seam, llm-native-recorded.test.ts precedent) —
// no live network, no credentials. The native seam reports the overflow
// reactively at step-finish from the provider-reported usage total (240,050)
// crossing the model's legacy usable boundary (262,144 - 32,000 = 230,144);
// the session does not map a 413 executor failure to the overflow repair on
// the native runtime. On pre-T06 source the loop replays through the legacy
// repair (no durable lineage); the suite must fail with the orchestration
// sentinel below, never with a load or environment error.

const LINEAGE_TYPE = "session.next.context-budget.lineage"
const LINEAGE_V1 = `${LINEAGE_TYPE}.1`

const InternalSessionEvent = SessionEvent as typeof SessionEvent & {
  readonly ContextBudgetLineage?: {
    readonly type: string
    readonly durable?: { readonly version: number; readonly aggregate: string }
    readonly data: unknown
  }
}

function lineageDefinition() {
  const definition = InternalSessionEvent.ContextBudgetLineage
  if (!definition) throw new Error("T06 RED: missing ContextBudgetLineage internal durable event")
  return definition
}

type LineageState = {
  readonly sessionID: string
  readonly userMessageID: string
  readonly expectedGeneration: number
  readonly newGeneration: number
  readonly compaction_count: number
  readonly routeLedger: readonly {
    readonly providerID: string
    readonly modelID: string
    readonly requestHash: string
    readonly runtime: string
    readonly outcome: string
  }[]
  readonly overflowHashes: readonly string[]
  readonly preDispatch: {
    readonly providerID: string
    readonly modelID: string
    readonly runtime: string
    readonly requestHash: string
    readonly projection: unknown
  }
  readonly watermark: { readonly outputSeq: number }
}

const lineageRows = Effect.fn("test.lineageRows")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows.filter((row) => row.type === LINEAGE_V1)
})

function decodeLineage(rows: readonly { data: Record<string, unknown> }[]): LineageState {
  const definition = lineageDefinition()
  const last = rows[rows.length - 1]!
  return Schema.decodeUnknownSync(definition.data as never)(last.data) as LineageState
}

// ─── Recorded HTTP wiring ────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(import.meta.dir, "../fixtures/recordings")
const CASSETTE = "session/qwen-context-budget-recorded"
const QCB_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

const MARKERS = ["QCB-HIST-1", "QCB-HIST-2", "QCB-FINAL"] as const

// The recorded request bodies cannot be matched byte-for-byte (the system
// prompt is harness-built), so equivalence is pinned on the contract that
// matters for no-regression: same route, same model, same output allowance,
// and the same content-marker profile (history present/absent, latest turn
// present). Any duplicate transport, oversized rebuild, or re-dispatch of the
// overflow request breaks the marker/allowance profile and fails the replay.
const qcbMatch = (incoming: { method: string; url: string; body: string }, recorded: { method: string; url: string; body: string }) => {
  const incomingBody = JSON.parse(incoming.body) as Record<string, unknown>
  const recordedBody = JSON.parse(recorded.body) as Record<string, unknown>
  const maxTokens = (body: Record<string, unknown>) => body.max_tokens ?? body.max_completion_tokens
  const profile = (body: string) => JSON.stringify(MARKERS.filter((marker) => body.includes(marker)))
  if (incoming.method !== "POST" || recorded.method !== "POST") return false
  if (incoming.url !== recorded.url) return false
  if (!incoming.url.endsWith("/chat/completions")) return false
  if (incomingBody.model !== recordedBody.model) return false
  if (maxTokens(incomingBody) !== maxTokens(recordedBody)) return false
  return profile(incoming.body) === profile(recorded.body)
}

const recordedHttp = HttpRecorderInternal.cassetteLayer(CASSETTE, {
  directory: FIXTURES_DIR,
  mode: "replay",
  match: qcbMatch,
})

// Only the HTTP client is recorded; RequestExecutor and the opencode LLM
// stack remain real on the native runtime (credential-free replay).
const recordedClient = LLMClient.layer.pipe(
  Layer.provide(Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(recordedHttp)), WebSocketExecutor.layer)),
)

const auth = Layer.mock(Auth.Service)({
  get: () => Effect.succeed(undefined),
  all: () => Effect.succeed({}),
})

const provider = ProviderSvc.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(auth),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(ModelsDev.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true, experimentalNativeLlm: true })),
)

// LLM.defaultLayer would resolve RuntimeFlags from the environment, so the
// test flags are provided directly (same seam as the recorded precedent):
// experimentalNativeLlm selects the native runtime that the cassette
// intercepts via LLMClient/RequestExecutor.
const llm = LLM.layer.pipe(
  Layer.provide(auth),
  Layer.provide(Config.defaultLayer),
  Layer.provide(provider),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(recordedClient),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true, experimentalNativeLlm: true })),
)

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

function makeMcp() {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed([]),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in qcb recorded tests"),
      authenticate: () => Effect.die("unexpected MCP auth in qcb recorded tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in qcb recorded tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

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

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function makeRecordedPrompt() {
  const flags = RuntimeFlags.layer({ experimentalEventSystem: true, experimentalNativeLlm: true })
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    llm,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    makeMcp(),
    FSUtil.defaultLayer,
    BackgroundJob.defaultLayer,
    status,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(flags),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(
      SystemPrompt.layer.pipe(
        Layer.provide(Skill.defaultLayer),
        Layer.provide(LocationServiceMap.layer),
        Layer.provide(deps),
      ),
    ),
    Layer.provide(flags),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

const it = testEffect(makeRecordedPrompt())

// ─── Config + fixtures ───────────────────────────────────────────────────────

const QCB_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"

// Qwen-shaped route under the opencode-managed OpenAI-compatible provider:
// the native runtime gate admits providerID "opencode*" with an API key, and
// the explicit model pin selects the QCB-shaped fixture model (the session
// never resolves a catalog default).
const qwenCfg: Partial<ConfigV1.Info> = {
  model: "opencode/qwen3-coder-plus",
  provider: {
    opencode: {
      name: "Qwen",
      id: "opencode",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "qwen3-coder-plus": {
          id: "qwen3-coder-plus",
          name: "Qwen3 Coder Plus",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 262_144, output: 32_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "fixture-qcb-key", baseURL: QCB_BASE_URL },
    },
  },
}

const writeQwenConfig = Effect.fn("test.writeQwenConfig")(function* () {
  const fs = yield* FSUtil.Service
  const { directory } = yield* TestInstance
  yield* fs.writeWithDirs(path.join(directory, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", ...qwenCfg }))
})

function qwenModel() {
  return {
    id: "qwen-max",
    providerID: "qwen",
    name: "Qwen Max",
    limit: { context: 262_144, input: undefined as unknown as number, output: 32_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai-compatible" },
    options: {},
  } as unknown as Parameters<typeof ContextBudget.evaluate>[0]["model"]
}

const HISTORY_MARKERS = ["QCB-HIST-1", "QCB-HIST-2"] as const

// ─── Test ────────────────────────────────────────────────────────────────────

describe("Qwen context-budget recorded proof", () => {
  it.instance("replays the credential-free recorded one-shot overflow repair without live network", () =>
    Effect.gen(function* () {
      yield* writeQwenConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "QCB recorded",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // Two small history turns (cassette interactions 1-2), then the final
      // turn (interaction 3): the replayed provider reports a usage total
      // (240,050) that crosses the model's legacy usable boundary (262,144 -
      // 32,000 = 230,144) at step-finish — the native runtime's reactive
      // overflow — driving the one-shot repair: one 4,096-summary compaction
      // (interaction 4) and one 32,000 rebuild (interaction 5).
      for (const marker of HISTORY_MARKERS) {
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: marker + "H".repeat(7_990) }],
        })
        yield* prompt.loop({ sessionID: chat.id })
      }
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "QCB-FINAL" + "f".repeat(400) }],
      })
      const result = yield* prompt.loop({ sessionID: chat.id })

      const rows = yield* lineageRows(chat.id)
      if (rows.length === 0) throw new Error("T06 RED: missing durable-lineage one-shot compact/rebuild orchestration")

      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
      const state = decodeLineage(rows)
      expect(state.compaction_count).toBe(1)
      // The replay ran on the native runtime: the lineage records it.
      expect(state.preDispatch.runtime).toBe("native")
      expect(state.routeLedger.length).toBeGreaterThanOrEqual(3)
      const hashes = new Set(state.routeLedger.map((entry) => entry.requestHash))
      expect(hashes.size).toBe(state.routeLedger.length)
      expect(state.routeLedger.every((entry) => entry.runtime === "native")).toBe(true)
      expect(state.routeLedger.every((entry) => /^[0-9a-f]{64}$/.test(entry.requestHash))).toBe(true)
      expect(state.routeLedger.every((entry) => entry.providerID === "opencode" && entry.modelID === "qwen3-coder-plus")).toBe(true)
      expect(state.overflowHashes.length).toBeGreaterThanOrEqual(1)
      // No-regression boundary: the replayed rebuild was admitted by the
      // Qwen gate, which bounds the estimate at 209,664.
      const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
      expect(ContextBudget.evaluate({ model: qwenModel(), cfg: base, estimate: 0, phase: "dispatch" }).budget).toBe(209_664)
    }),
    120_000,
  )
})
