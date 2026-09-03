import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { describe, expect } from "bun:test"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
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
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ContextBudget } from "../../src/session/overflow"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

// ─── T06 RED contract ────────────────────────────────────────────────────────
//
// T06 replaces prior-usage admission with one durable-lineage
// compact/rebuild cycle per oversized request. The expected pre-T06 failure
// reasons (sentinels) are:
//   (a) missing ContextBudgetLineage internal durable event
//   (b) missing core context-budget-lineage read/fold helper
//   (c) missing awaited final-pre-network lineage seam callback
//   (d) missing durable-lineage one-shot compact/rebuild orchestration
// Every test below fails with one of these sentinels on pre-T06 source —
// never with a load, syntax, or environment error.

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
    readonly runtime: string
    readonly requestHash: string
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
  // seq-ordered (the (aggregate_id,type,seq) index serves the latest read).
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

// CAS pre-pollution: a durable lineage event at a generation the loop can
// never reach, written directly to the event log (no T06 surface needed).
// The row lands at the true tail of the aggregate's sequence and advances
// event_sequence with it, so the session's next legitimate publish continues
// at poison + 1 — no (aggregate_id, seq) collision, no replay gap.
function lineagePoison(sessionID: SessionID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ seq: EventSequenceTable.seq })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    const seq = (rows[0]?.seq ?? -1) + 1
    yield* db
      .insert(EventSequenceTable)
      .values([{ aggregate_id: sessionID, seq }])
      .onConflictDoUpdate({ target: EventSequenceTable.aggregate_id, set: { seq } })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values({
        id: EventV2.ID.make("evt_t06lineage_cas_pollution"),
        aggregate_id: sessionID,
        seq,
        type: LINEAGE_V1,
        data: {
          timestamp: 1_700_000_000_000,
          sessionID,
          userMessageID: "msg_t06lineage_pollution",
          expectedGeneration: 98,
          newGeneration: 99,
          compaction_count: 1,
          routeLedger: [],
          overflowHashes: [],
          preDispatch: {
            providerID: "qwen",
            modelID: "qwen3-coder-plus",
            runtime: "ai-sdk",
            requestHash: "0".repeat(64),
            projection: {},
          },
          watermark: { outputSeq: 0 },
        },
      })
      .run()
      .pipe(Effect.orDie)
  })
}

// ─── Harness (mirrors prompt.test.ts) ───────────────────────────────────────

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
      startAuth: () => Effect.die("unexpected MCP auth in qcb tests"),
      authenticate: () => Effect.die("unexpected MCP auth in qcb tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in qcb tests"),
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

// Node-graph harness (mirrors prompt.test.ts): the declared node deps pull in
// every service the old defaultLayer mergeAll provided; the test doubles
// replace their nodes. The RuntimeFlags replacement reaches the whole graph,
// so experimentalNativeLlm actually selects the native runtime (same seam as
// the recorded precedent — the old LLM.defaultLayer resolved the flags from
// the environment instead).
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

function makePrompt(input?: { native?: boolean }) {
  const flags = RuntimeFlags.layer({ experimentalEventSystem: true, experimentalNativeLlm: input?.native ?? false })
  return LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, flags],
  ] as const)
}

function makeHttp(input?: { native?: boolean }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const itNative = testEffect(makeHttp({ native: true }))

// ─── Config + fixture helpers ───────────────────────────────────────────────

// Qwen-shaped route per the spec: 262,144 context, 32,000 output.
const QCB_LIMIT = { context: 262_144, output: 32_000 } as const

function qwenProviderCfg(url: string, providerID: "qwen" | "openai" | "opencode", compaction?: ConfigV1.Info["compaction"]) {
  return {
    provider: {
      [providerID]: {
        name: providerID === "openai" ? "OpenAI" : "Qwen",
        id: providerID,
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
            limit: { ...QCB_LIMIT },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "fixture-qcb-key", baseURL: url },
      },
    },
    ...(compaction ? { compaction } : {}),
  } as Partial<ConfigV1.Info>
}

const qwenCfg = (url: string, compaction?: ConfigV1.Info["compaction"]) => qwenProviderCfg(url, "qwen", compaction)

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }))
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Qwen-shaped model fixture for the structural budget proofs (T01 surface).
function qwenModel() {
  return {
    id: "qwen-max",
    providerID: "qwen",
    name: "Qwen Max",
    limit: { context: QCB_LIMIT.context, input: undefined as unknown as number, output: QCB_LIMIT.output },
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

// The TestLLMServer service shape (the key is the class; the service
// interface is not exported as a namespace member).
type LLMOps = Context.Service.Shape<typeof TestLLMServer>

// Two ~80k-char turns (~40k tokens): initially fitting, and large enough that
// the final preflight overflow is boundary-independent (E = B0 + 40k + |U|/4
// crosses 209,664 for any B0, while every history request stays admitted).
const HISTORY_MARKERS = ["QCB-HIST-1", "QCB-HIST-2"] as const

function buildHistory(prompt: SessionPrompt.Interface, llm: LLMOps, sessionID: SessionID) {
  return Effect.gen(function* () {
    for (const marker of HISTORY_MARKERS) {
      yield* prompt.prompt({
        sessionID,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: marker + "H".repeat(79_990) }],
      })
      // Explicit finish_reason: since upstream #43892 a turn whose recorded
      // finish is "unknown" (a stream with no finish_reason) no longer ends
      // the loop — it re-dispatches. .stop() keeps each history turn a single
      // transport call on both runtimes.
      yield* llm.push(reply().text(`history reply ${marker}`).stop())
      yield* prompt.loop({ sessionID })
    }
  })
}

const maxTokens = (body: Record<string, unknown>) => (body.max_tokens ?? body.max_completion_tokens) as number

const FINAL_SMALL = "QCB-FINAL" + "f".repeat(400)

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("T06 durable-lineage one-shot context-budget repair", () => {
  it.instance("one-shot cycle: initially fitting session overflows late, compacts once, rebuilds once, and admits once (AI SDK)", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(qwenCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "QCB one-shot",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* buildHistory(prompt, llm, chat.id)
      expect(yield* llm.hits).toHaveLength(2)
      // The final request fits at preflight and is rejected by the provider
      // (reactive overflow): the one-shot cycle must run exactly once.
      // The compaction reply intentionally has no finish_reason: the summary
      // turn must not terminate the loop before the rebuild dispatch. The
      // rebuild reply stops cleanly (.stop()), ending the session exactly
      // after the one-shot cycle.
      yield* llm.error(413, { error: { message: "request entity too large" } })
      yield* llm.push(reply().text("ok"))
      yield* llm.push(reply().text("rebuild ok").stop())
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: FINAL_SMALL }] })
      const result = yield* prompt.loop({ sessionID: chat.id })

      const rows = yield* lineageRows(chat.id)
      if (rows.length === 0) throw new Error("T06 RED: missing durable-lineage one-shot compact/rebuild orchestration")

      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
      const hits = yield* llm.hits
      // history×2, overflow trigger, one compaction, one rebuild — no
      // duplicate transport and no second repair.
      expect(hits).toHaveLength(5)
      expect(maxTokens(hits[3]!.body)).toBe(4_096)
      expect(maxTokens(hits[4]!.body)).toBe(32_000)
      const seen = new Set(hits.map((hit) => JSON.stringify(hit.body)))
      expect(seen.size).toBe(5)
      // The rebuild dropped the compacted history but kept the latest turn.
      expect(JSON.stringify(hits[2]!.body)).toContain("QCB-HIST-1")
      expect(JSON.stringify(hits[2]!.body)).toContain("QCB-FINAL")
      expect(JSON.stringify(hits[4]!.body)).not.toContain("QCB-HIST-1")
      expect(JSON.stringify(hits[4]!.body)).toContain("QCB-FINAL")
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
      const state = decodeLineage(rows)
      expect(state.newGeneration).toBeGreaterThanOrEqual(1)
      expect(state.expectedGeneration).toBeGreaterThanOrEqual(0)
      expect(state.compaction_count).toBe(1)
      expect(state.routeLedger.length).toBeGreaterThanOrEqual(3)
      const hashes = new Set(state.routeLedger.map((entry) => entry.requestHash))
      expect(hashes.size).toBe(state.routeLedger.length)
      expect(state.routeLedger.every((entry) => /^[0-9a-f]{64}$/.test(entry.requestHash))).toBe(true)
      expect(state.routeLedger.some((entry) => entry.outcome === "overflow")).toBe(true)
      expect(state.routeLedger.some((entry) => entry.outcome === "admitted")).toBe(true)
      expect(state.routeLedger.every((entry) => entry.providerID === "qwen" && entry.modelID === "qwen3-coder-plus")).toBe(true)
      expect(state.overflowHashes.length).toBeGreaterThanOrEqual(1)
      expect(state.preDispatch.runtime).toBe("ai-sdk")
      expect(state.preDispatch.requestHash).toMatch(/^[0-9a-f]{64}$/)
      expect(state.watermark.outputSeq).toBeGreaterThanOrEqual(0)
    }),
    120_000,
  )

  itNative.instance("the same one-shot cycle completes on the native runtime", () =>
    Effect.gen(function* () {
      // Fixture/transport assumptions for the native runtime:
      // - the opencode-managed OpenAI-compatible route + explicitly pinned
      //   model sidesteps any openai-provider model hooking, so the session
      //   model resolves to the QCB-shaped fixture model;
      // - every reply carries an explicit finish_reason (.stop()); since
      //   upstream #43892 a turn recorded with an "unknown" finish (a stream
      //   without finish_reason) no longer ends the loop, so explicit stops
      //   keep each history turn a single transport call on both runtimes;
      // - native overflow is reactive at step-finish: the final turn is
      //   admitted preflight (E <= 209,664) and the provider-reported usage
      //   total (240,050) crosses the model's legacy usable boundary
      //   (262,144 - 32,000 = 230,144), driving the one-shot cycle.
      const { llm } = yield* useServerConfig((url) => ({
        ...qwenProviderCfg(url, "opencode"),
        model: "opencode/qwen3-coder-plus",
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "QCB native",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      for (const marker of HISTORY_MARKERS) {
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: marker + "H".repeat(79_990) }],
        })
        yield* llm.push(reply().text(`history reply ${marker}`).usage({ input: 20_000, output: 50 }).stop())
        yield* prompt.loop({ sessionID: chat.id })
      }
      expect(yield* llm.hits).toHaveLength(2)
      // Initially fitting, overflows late: final turn (usage overflow),
      // one compaction, one rebuild — no duplicate transport, no second repair.
      yield* llm.push(reply().text("ok").usage({ input: 240_000, output: 50 }).stop())
      yield* llm.push(reply().text("ok").usage({ input: 500, output: 200 }).stop())
      yield* llm.push(reply().text("rebuild ok").usage({ input: 500, output: 50 }).stop())
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: FINAL_SMALL }] })
      const result = yield* prompt.loop({ sessionID: chat.id })

      const rows = yield* lineageRows(chat.id)
      if (rows.length === 0) throw new Error("T06 RED: missing durable-lineage one-shot compact/rebuild orchestration")

      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
      const hits = yield* llm.hits
      expect(hits).toHaveLength(5)
      expect(maxTokens(hits[3]!.body)).toBe(4_096)
      expect(maxTokens(hits[4]!.body)).toBe(32_000)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.filter((message) => message.parts.some((part) => part.type === "compaction"))).toHaveLength(1)
      const state = decodeLineage(rows)
      expect(state.compaction_count).toBe(1)
      expect(state.preDispatch.runtime).toBe("native")
      expect(state.routeLedger.some((entry) => entry.runtime === "native")).toBe(true)
    }),
    120_000,
  )

  it.instance("CAS conflict against a newer indexed lineage aborts before any provider call", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(qwenCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "QCB CAS",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // A competing writer advanced the lineage far beyond the generation the
      // loop expects: the CAS must fail and zero native/streamText/HTTP/
      // provider calls may happen.
      yield* lineagePoison(chat.id)
      yield* llm.push(reply().text("must never be consumed"))
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "QCB-CAS question" }] })
      const result = yield* prompt.loop({ sessionID: chat.id })

      const calls = yield* llm.calls
      if (calls > 0) throw new Error("T06 RED: missing awaited final-pre-network lineage seam callback")
      expect(calls).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.error).toBeDefined()
    }),
    120_000,
  )

  it.instance("terminal: an oversized rebuild cannot fit, so the repair stops without a rebuild dispatch", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(qwenCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "QCB terminal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* buildHistory(prompt, llm, chat.id)
      yield* llm.push(reply().text("ok"))
      // ~950k chars (~237.5k tokens): the preflight is oversized and the
      // latest turn alone exceeds the compaction request budget, so the
      // bounded planner fails closed (latest-turn-too-large) before any
      // compaction or rebuild dispatch.
      const huge = "QCB-TERMINAL" + "T".repeat(949_990)
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: huge }] })
      const result = yield* prompt.loop({ sessionID: chat.id })

      const rows = yield* lineageRows(chat.id)
      if (rows.length === 0) throw new Error("T06 RED: missing durable-lineage one-shot compact/rebuild orchestration")

      const hits = yield* llm.hits
      // history×2 only: no compaction, no rebuild, no duplicate dispatch.
      expect(hits).toHaveLength(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        // Terminal budget failures surface as the public overflow error at
        // the session boundary (internal-only names never reach message info).
        expect(result.info.error).toBeDefined()
        expect(result.info.error?.name).toBe("ContextOverflowError")
      }
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
      const state = decodeLineage(rows)
      expect(state.overflowHashes.length).toBeGreaterThanOrEqual(1)
      expect(state.routeLedger.length).toBeGreaterThanOrEqual(1)
      expect(state.routeLedger.every((entry) => /^[0-9a-f]{64}$/.test(entry.requestHash))).toBe(true)
    }),
    120_000,
  )

  it.instance("auto:false: overflow stops without compaction or extra provider calls and records the overflow", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => qwenCfg(url, { auto: false }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "QCB auto off",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* buildHistory(prompt, llm, chat.id)
      yield* llm.error(413, { error: { message: "request entity too large" } })
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: FINAL_SMALL }] })
      const result = yield* prompt.loop({ sessionID: chat.id })

      const hits = yield* llm.hits
      if (hits.length > 3) throw new Error("T06 RED: missing durable-lineage one-shot compact/rebuild orchestration")
      // history×2 + the single rejected overflow trigger: no compaction and
      // no rebuild provider call.
      expect(hits).toHaveLength(3)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.error).toBeDefined()
      const rows = yield* lineageRows(chat.id)
      if (rows.length === 0) throw new Error("T06 RED: missing durable-lineage one-shot compact/rebuild orchestration")
      const state = decodeLineage(rows)
      expect(state.compaction_count).toBe(0)
      expect(state.overflowHashes.length).toBeGreaterThanOrEqual(1)
    }),
    120_000,
  )

  it.instance("bound proofs: Qwen budget 209664, summary 4096, rebuild 32000, reserve 12000", () =>
    Effect.gen(function* () {
      const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
      const model = qwenModel()
      // Structural: the Qwen boundary algebra. The 12,000 reserve sits inside
      // the formula; the 32,000 output + 20,480 headroom term dominates it,
      // so B = 262,144 - 52,480 = 209,664 and 209,664 admits / 209,665 rejects.
      const evaluation = ContextBudget.evaluate({ model, cfg: base, estimate: 0, phase: "dispatch" })
      expect(evaluation.budget).toBe(209_664)
      expect(ContextBudget.evaluate({ model, cfg: base, estimate: 209_664, phase: "dispatch" }).admitted).toBe(true)
      expect(ContextBudget.evaluate({ model, cfg: base, estimate: 209_665, phase: "dispatch" }).admitted).toBe(false)
      const reserved = { ...base, compaction: { ...base.compaction, reserved: 12_000 } }
      expect(ContextBudget.evaluate({ model, cfg: reserved, estimate: 0, phase: "dispatch" }).budget).toBe(209_664)

      // Behavioral: the one-shot repair requests respect the 4,096 summary
      // and 32,000 rebuild allowances; the admitted rebuild proves
      // E <= 209,664 under the gate.
      const { llm } = yield* useServerConfig(qwenCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "QCB bounds",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* buildHistory(prompt, llm, chat.id)
      yield* llm.error(413, { error: { message: "request entity too large" } })
      yield* llm.push(reply().text("ok"))
      // .stop(): the rebuilt turn must end the loop cleanly (upstream #43892
      // keeps the loop running on an "unknown" recorded finish).
      yield* llm.push(reply().text("rebuild ok").stop())
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: FINAL_SMALL }] })
      const result = yield* prompt.loop({ sessionID: chat.id })

      const rows = yield* lineageRows(chat.id)
      if (rows.length === 0) throw new Error("T06 RED: missing durable-lineage one-shot compact/rebuild orchestration")

      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
      const hits = yield* llm.hits
      expect(hits).toHaveLength(5)
      expect(maxTokens(hits[3]!.body)).toBe(4_096)
      expect(maxTokens(hits[4]!.body)).toBe(32_000)
      const state = decodeLineage(rows)
      expect(state.compaction_count).toBe(1)
    }),
    120_000,
  )
})


