/**
 * T03 acceptance tests — Pure bounded compaction planner.
 *
 * Authoritative sources:
 *   - specs/qwen-context-budget.md (compaction request safety, bounded chunking)
 *   - specs/qwen-context-budget-plan.md T03 (pure bounded compaction planner)
 *   - specs/qwen-context-budget-choices.md (QCB-003..006)
 *
 * Scope (T03 test_touch_set — this file only; source_touch_set is src/session/compaction.ts):
 *   - A pure, NONPERSISTENT, synchronous planner: no durable writes, no
 *     provider calls, no mutation of the input transcript objects.
 *   - Media parts become deterministic placeholders inside chunk projections;
 *     the LATEST turn keeps media verbatim (it rides intact, unprojected).
 *   - Historical tool output inside chunk projections is capped at 2,000
 *     characters; durable rows are never altered.
 *   - The latest user turn (user through the next user boundary) is preserved
 *     INTACT and lives outside every chunk. Tail settings (`tail_turns`) are
 *     MAXIMA, not requirements.
 *   - Older history is grouped only on complete user-turn boundaries; tool
 *     calls are never separated from their turns/results; only an
 *     individually oversized text part may be split, and split pieces carry
 *     role/order metadata (see the split contract below).
 *   - At most four chunks (`MAX_CHUNK_COUNT = 4`); a fifth required chunk
 *     fails terminally with reason `chunk-limit`.
 *   - Every proposed request (`CompactionPlannerProposal`) is admitted through
 *     ContextBudget.evaluate with phase "compaction" and the 4,096 compaction
 *     output allowance, and its `requestEstimate` includes the fixed
 *     transformed compaction overhead, the latest intact tail, and a
 *     conservative worst-case prior rolling summary reserve pinned to
 *     4,096 * 4 = 16,384 characters (`SUMMARY_RESERVE_CHARS`) plus canonical
 *     message-wrapper overhead measured by the same projection. A proposal
 *     whose estimate only fits with an empty prior summary is never planned.
 *   - Fixed overhead and latest-turn admission are evaluated BEFORE any chunk
 *     planning; those failures reason `fixed-overhead` /
 *     `latest-turn-too-large` (and, being pre-call, no chunk is proposed —
 *     execution-level zero-call proof belongs to T05).
 *   - Boundaries and hashes are deterministic: identical input, identical
 *     chunk boundaries, identical requestHash values.
 *
 * Planner contract assumed by these tests (exported from src/session/compaction.ts):
 *
 *   export const CompactionPlanner = {
 *     SUMMARY_RESERVE_CHARS: 16_384,   // 4,096 summary tokens * 4 chars/token
 *     SUMMARY_OUTPUT_TOKENS: 4_096,
 *     MAX_CHUNK_COUNT: 4,
 *     TOOL_OUTPUT_MAX_CHARS: 2_000,
 *     plan(input: {
 *       messages: readonly SessionV1.WithParts[]
 *       model: Provider.Model
 *       cfg: ConfigV1.Info
 *       requestHash?: string
 *     }): CompactionPlannerPlan
 *     splitOversized(input: {
 *       message: SessionV1.WithParts
 *       partIndex: number
 *       limitChars: number
 *     }): { leading: unknown; trailing: unknown } | undefined
 *   }
 *
 *   CompactionPlannerPlan    = { chunks, latestTurn, proposals }
 *   CompactionPlannerChunk   = { index: number, messages: SessionV1.WithParts[] }
 *   CompactionPlannerProposal= {
 *     chunk: CompactionPlannerChunk,
 *     request: unknown,          // exact proposed compaction request projection:
 *                                // fixed overhead + prior-summary reserve + next
 *                                // chunk + latest intact tail, data-only
 *     requestEstimate: number,   // ContextBudget.estimate of that request
 *                                // INCLUDING the 16,384-char reserve + wrappers
 *     requestHash: string,       // deterministic sha-256 hex
 *     admitted: boolean,         // ContextBudget.evaluate(..., outputTokens: 4_096,
 *                                // phase "compaction") admission for this proposal
 *   }
 *
 *   splitOversized returns undefined unless the single text part alone
 *   exceeds `limitChars`; its two pieces remain text-part-shaped values whose
 *   serialized form carries split role/order metadata: string `role`, numeric
 *   `index` (0-based piece order) and `total` under a `split` key, and the
 *   pieces' text concatenates back to the original part text in order.
 *
 * Not in this touch set: rolling-summary execution, atomic finalization,
 * persistence/replay (T05), final-payload LLM seam admission (T04), lineage
 * (T06). No execution cases are asserted here — T05 owns them.
 */

import { describe, expect, mock, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import * as Compaction from "../../src/session/compaction"
import * as Overflow from "../../src/session/overflow"
import { it } from "../lib/effect"

// ─── The planner surface under test ──────────────────────────────────────────
//
// Namespace access keeps RED behavioral (asserting an absent export) instead
// of failing at module resolution — the same pattern as the accepted T01
// overflow.test.ts.

type PlannerChunk = { readonly index: number; readonly messages: readonly SessionV1.WithParts[] }

type PlannerProposal = {
  readonly chunk: PlannerChunk
  readonly request: unknown
  readonly requestEstimate: number
  readonly requestHash: string
  readonly admitted: boolean
}

type PlannerPlan = {
  readonly chunks: readonly PlannerChunk[]
  readonly latestTurn: readonly SessionV1.WithParts[]
  readonly proposals: readonly PlannerProposal[]
}

type CompactionPlannerNamespace = {
  readonly SUMMARY_RESERVE_CHARS: number
  readonly SUMMARY_OUTPUT_TOKENS: number
  readonly MAX_CHUNK_COUNT: number
  readonly TOOL_OUTPUT_MAX_CHARS: number
  plan(input: {
    messages: readonly SessionV1.WithParts[]
    model: Provider.Model
    cfg: ConfigV1.Info
    requestHash?: string
  }): PlannerPlan
  splitOversized(input: {
    message: SessionV1.WithParts
    partIndex: number
    limitChars: number
  }): { leading: Record<string, unknown>; trailing: Record<string, unknown> } | undefined
}

function planner(): CompactionPlannerNamespace {
  const ns = (Compaction as unknown as { CompactionPlanner?: CompactionPlannerNamespace }).CompactionPlanner
  expect(ns).toBeDefined()
  return ns!
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const sessionID = "ses_compaction-budget" as SessionID

function createModel(opts: { context: number; output: number; input?: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, input: opts.input, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const qwen = () => createModel({ context: 262_144, output: 32_000 })

function cfg(compaction?: ConfigV1.Info["compaction"]): ConfigV1.Info {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return { ...base, compaction }
}

// The per-request compaction budget for a route: ContextBudget.evaluate with
// the 4,096 compaction output allowance (QCB-003). Computed from the T01
// evaluator — this test never duplicates the algebra.
function compactionBudget(model: Provider.Model, config: ConfigV1.Info): number {
  return Overflow.ContextBudget.evaluate({
    model,
    cfg: config,
    estimate: 0,
    phase: "compaction",
    outputTokens: planner().SUMMARY_OUTPUT_TOKENS,
  }).budget
}

let seq = 0
function userID(): SessionV1.User["id"] {
  seq += 1
  return MessageID.make("msg_user-" + String(seq).padStart(4, "0"))
}
function assistantID(): SessionV1.Assistant["id"] {
  seq += 1
  return MessageID.make("msg_asst-" + String(seq).padStart(4, "0"))
}
function partID(): SessionV1.Part["id"] {
  seq += 1
  return PartID.make("prt_part-" + String(seq).padStart(4, "0"))
}

const MODEL_REF = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function userMessage(overrides: { text?: string; parts?: SessionV1.Part[] }): SessionV1.WithParts {
  const info: SessionV1.User = {
    id: userID(),
    sessionID,
    role: "user",
    time: { created: Date.now() + seq },
    agent: "build",
    model: { ...MODEL_REF },
  }
  const parts: SessionV1.Part[] =
    overrides.parts ??
    [{ id: partID(), sessionID, messageID: info.id, type: "text", text: overrides.text ?? "user text" }]
  return { info, parts }
}

function assistantMessage(overrides: { text?: string; parts?: SessionV1.Part[] }): SessionV1.WithParts {
  const id = assistantID()
  const info: SessionV1.Assistant = {
    id,
    sessionID,
    role: "assistant",
    parentID: userID(),
    time: { created: Date.now() + seq },
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL_REF.modelID,
    providerID: MODEL_REF.providerID,
  }
  const parts: SessionV1.Part[] =
    overrides.parts ??
    [{ id: partID(), sessionID, messageID: id, type: "text", text: overrides.text ?? "assistant text" }]
  return { info, parts }
}

function toolPart(callID: string, tool: string, output: string): SessionV1.ToolPart {
  return {
    id: partID(),
    sessionID,
    messageID: "pending" as SessionV1.ToolPart["messageID"],
    type: "tool",
    callID,
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: "tool " + callID,
      metadata: {},
      time: { start: Date.now(), end: Date.now() + 1 },
    },
  }
}

function filePart(filename: string): SessionV1.FilePart {
  return {
    id: partID(),
    sessionID,
    messageID: "pending" as SessionV1.FilePart["messageID"],
    type: "file",
    mime: "image/png",
    filename,
    url: "data:image/png;base64,AAAAAAAA",
  }
}

// Complete user turns: [user, assistant?, tools...] ending before the next user message.
function turn(user: SessionV1.WithParts, rest: SessionV1.WithParts[]): SessionV1.WithParts[] {
  return [user, ...rest]
}

function impossibleReason(caught: unknown): Record<string, unknown> {
  expect(Overflow.CompactionImpossibleError.isInstance(caught)).toBe(true)
  const data = (caught as { data?: Record<string, unknown> }).data
  expect(data).toBeObject()
  return data!
}

// ─── Media placeholders and historical tool output cap ───────────────────────

describe("CompactionPlanner — safe chunk projections", () => {
  test("media parts become deterministic placeholders in chunks while the latest turn keeps media intact", () => {
    const P = planner()
    const u1 = userMessage({ text: "older question" })
    const a1 = assistantMessage({})
    const u2 = userMessage({
      parts: [
        { id: partID(), sessionID, messageID: "pending" as SessionV1.TextPart["messageID"], type: "text", text: "see attachment" },
        filePart("chart.png"),
      ],
    })
    const latest = userMessage({
      parts: [
        { id: partID(), sessionID, messageID: "pending" as SessionV1.TextPart["messageID"], type: "text", text: "latest with media" },
        filePart("latest.png"),
      ],
    })
    const messages = [...turn(u1, [a1]), ...turn(u2, []), ...turn(latest, [])]

    const plan = P.plan({ messages, model: qwen(), cfg: cfg() })
    const chunked = JSON.stringify(plan.chunks)
    // No raw data URI ever enters a chunk projection.
    expect(chunked).not.toContain("data:image/png;base64")
    expect(chunked).toContain("chart.png")
    // The latest turn rides intact: its media is NOT replaced.
    expect(JSON.stringify(plan.latestTurn)).toContain("data:image/png;base64,AAAAAAAA")
    expect(JSON.stringify(plan.latestTurn)).toContain("latest.png")

    // Deterministic placeholder: identical input produces an identical plan.
    const plan2 = P.plan({ messages, model: qwen(), cfg: cfg() })
    expect(JSON.stringify(plan2.chunks)).toBe(chunked)

    // Nonpersistent: durable input objects are never mutated.
    expect(JSON.stringify(u2.parts[1])).toContain("data:image/png;base64,AAAAAAAA")
    expect(JSON.stringify(latest.parts[1])).toContain("data:image/png;base64,AAAAAAAA")
  })

  test("historical tool output is capped at 2,000 characters in chunks; latest turn output stays intact", () => {
    const P = planner()
    const big = "X".repeat(50_000)
    const u1 = userMessage({ text: "run the tool" })
    const a1 = assistantMessage({ parts: [toolPart("call-1", "reader", big)] })
    const latestUser = userMessage({ text: "latest question" })
    const latestAssistant = assistantMessage({ parts: [toolPart("call-latest", "reader", big)] })
    const messages = [...turn(u1, [a1]), ...turn(latestUser, [latestAssistant])]

    const plan = P.plan({ messages, model: qwen(), cfg: cfg() })
    const chunked = JSON.stringify(plan.chunks)
    expect(chunked).not.toContain(big)
    expect(P.TOOL_OUTPUT_MAX_CHARS).toBe(2_000)
    // The latest turn is intact: its (hypothetical) tool output is not capped.
    expect(JSON.stringify(plan.latestTurn)).toContain(big)
    // Durable rows untouched.
    const a1ToolState = (a1.parts[0] as SessionV1.ToolPart).state as { status: string; output: string }
    const latestToolState = (latestAssistant.parts[0] as SessionV1.ToolPart).state as typeof a1ToolState
    expect(a1ToolState.status).toBe("completed")
    expect(a1ToolState.output).toBe(big)
    expect(latestToolState.output).toBe(big)
  })
})

// ─── Latest turn intact and tail maxima ──────────────────────────────────────

describe("CompactionPlanner — latest user turn intact, tail settings are maxima", () => {
  test("the latest user turn rides intact outside every chunk; planned coverage is complete and disjoint", () => {
    const P = planner()
    const u1 = userMessage({ text: "old one" })
    const a1 = assistantMessage({})
    const u2 = userMessage({ text: "old two" })
    const a2 = assistantMessage({})
    const latestUser = userMessage({ text: "LATEST-UNIQUE-MARKER" })
    const latestAsst = assistantMessage({ text: "LATEST-ANSWER-MARKER" })
    const messages = [...turn(u1, [a1]), ...turn(u2, [a2]), ...turn(latestUser, [latestAsst])]

    const plan = P.plan({ messages, model: qwen(), cfg: cfg({ tail_turns: 1 }) })

    // Latest turn group is exactly [latestUser, latestAsst], verbatim order.
    expect(plan.latestTurn.map((m) => m.info.id)).toEqual([latestUser.info.id, latestAsst.info.id])
    expect(JSON.stringify(plan.latestTurn)).toContain("LATEST-UNIQUE-MARKER")
    expect(JSON.stringify(plan.latestTurn)).toContain("LATEST-ANSWER-MARKER")

    // Complete and disjoint coverage of the transcript.
    const chunkMessages = plan.chunks.flatMap((chunk) => chunk.messages)
    expect(chunkMessages.length + plan.latestTurn.length).toBe(messages.length)
    expect(new Set(chunkMessages.map((m) => m.info.id)).has(latestUser.info.id)).toBe(false)
    expect(chunkMessages.every((m) => m.info.role === "user" || m.info.role === "assistant" || true)).toBe(true)
  })

  test("tail_turns is a maximum: older turns remain eligible for chunking and every prior user turn is covered", () => {
    const P = planner()
    const users = ["u1", "u2", "u3", "u4"].map((t) => userMessage({ text: t }))
    const assts = users.map(() => assistantMessage({}))
    const latestUser = userMessage({ text: "latest" })
    const messages: SessionV1.WithParts[] = [
      ...turn(users[0]!, [assts[0]!]),
      ...turn(users[1]!, [assts[1]!]),
      ...turn(users[2]!, [assts[2]!]),
      ...turn(users[3]!, [assts[3]!]),
      ...turn(latestUser, []),
    ]

    const plan = P.plan({ messages, model: qwen(), cfg: cfg({ tail_turns: 3 }) })
    // The latest turn is never chunked, regardless of tail settings.
    for (const id of plan.latestTurn.map((m) => m.info.id as string)) {
      expect(plan.chunks.some((chunk) => chunk.messages.some((m) => m.info.id === id))).toBe(false)
    }
    // Every user turn before the latest one is covered exactly once (tail
    // settings are maxima — the planner may chunk fewer, never more).
    const priorUserIDs = messages
      .filter((m) => m.info.role === "user" && m.info.id !== latestUser.info.id)
      .map((m) => m.info.id as string)
    const chunkedUserIDs = plan.chunks.flatMap((chunk) =>
      chunk.messages.filter((m) => m.info.role === "user").map((m) => m.info.id as string),
    )
    expect(chunkedUserIDs.toSorted()).toEqual(priorUserIDs.toSorted())
  })
})

// ─── Complete user-turn grouping and tool-pair integrity ─────────────────────

describe("CompactionPlanner — complete user-turn grouping, tool pairs, oversized text splitting", () => {
  test("chunk boundaries fall only on complete user turns; a turn's tool-bearing assistant never splits off", () => {
    const P = planner()
    const u1 = userMessage({ text: "first" })
    const a1 = assistantMessage({
      parts: [toolPart("c1-a", "search", "ok-1"), toolPart("c1-b", "read", "ok-2")],
    })
    const u2 = userMessage({ text: "second" })
    const a2 = assistantMessage({ parts: [toolPart("c2-a", "edit", "ok-3")] })
    const messages = [...turn(u1, [a1]), ...turn(u2, [a2]), ...turn(userMessage({ text: "third" }), [])]

    const plan = P.plan({ messages, model: qwen(), cfg: cfg() })
    expect(plan.chunks.length).toBeGreaterThanOrEqual(1)
    for (const chunk of plan.chunks) {
      // A chunk always begins at a user message: complete-turn grouping.
      expect(chunk.messages[0]!.info.role).toBe("user")
      const ids = new Set(chunk.messages.map((m) => m.info.id as string))
      // User/assistant co-membership: a turn is never split across chunks.
      expect(ids.has(u1.info.id)).toBe(ids.has(a1.info.id))
      expect(ids.has(u2.info.id)).toBe(ids.has(a2.info.id))
    }
  })

  test("only an individually oversized text part is split, with role/order metadata and lossless pieces", () => {
    const P = planner()
    const original = "P".repeat(3_000_000)
    const holder = assistantMessage({ parts: [{ id: partID(), sessionID, messageID: "pending" as SessionV1.TextPart["messageID"], type: "text", text: original }] })

    // Below the limit: not oversized, no split.
    expect(
      P.splitOversized({ message: holder, partIndex: 0, limitChars: 4_000_000 }),
    ).toBeUndefined()

    // Above the limit: two ordered text pieces that rebuild the original.
    const split = P.splitOversized({ message: holder, partIndex: 0, limitChars: 1_000_000 })
    expect(split).toBeDefined()
    const pieces = [split!.leading, split!.trailing]
    for (const piece of pieces) {
      expect((piece as Record<string, unknown>).type).toBe("text")
      const splitMeta = (piece as Record<string, unknown>).split as Record<string, unknown> | undefined
      expect(splitMeta).toBeObject()
      expect(typeof splitMeta!.role).toBe("string")
      expect((splitMeta!.role as string).length).toBeGreaterThan(0)
      expect(typeof splitMeta!.index).toBe("number")
      expect(splitMeta!.total).toBe(2)
    }
    expect(((pieces[0] as Record<string, unknown>).split as Record<string, unknown>).index).toBe(0)
    expect(((pieces[1] as Record<string, unknown>).split as Record<string, unknown>).index).toBe(1)
    expect(
      (pieces[0] as { text: string }).text + (pieces[1] as { text: string }).text,
    ).toBe(original)
      // The durable part is untouched.
    expect((holder.parts[0] as SessionV1.TextPart).text).toBe(original)
  })

  test("an oversized old-turn text is split across chunks without throwing, within four chunks, all admitted", () => {
    const P = planner()
    const huge = "Q".repeat(1_500_000) // 375,000 tokens: exceeds any single chunk's allowance
    const u1 = userMessage({ text: "digest this" })
    const hugeAssistant = assistantMessage({
      parts: [{ id: partID(), sessionID, messageID: "pending" as SessionV1.TextPart["messageID"], type: "text", text: huge }],
    })
    const u2 = userMessage({ text: "second" })
    const latest = userMessage({ text: "latest" })
    const messages = [...turn(u1, [hugeAssistant]), ...turn(u2, []), ...turn(latest, [])]

    const plan = P.plan({ messages, model: qwen(), cfg: cfg() })
    expect(plan.chunks.length).toBeGreaterThanOrEqual(2)
    expect(plan.chunks.length).toBeLessThanOrEqual(P.MAX_CHUNK_COUNT)
    expect(plan.proposals.length).toBe(plan.chunks.length)
    // The full oversized text survives across the pieces.
    expect(JSON.stringify(plan.chunks).split(huge.slice(0, 100_000)).length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Per-chunk ContextBudget admission ───────────────────────────────────────

describe("CompactionPlanner — per-chunk ContextBudget admission with reserve", () => {
  test("pins summary reserve 16,384 chars, 4,096 summary tokens, four-chunk maximum, 2,000 tool cap", () => {
    const P = planner()
    expect(P.SUMMARY_RESERVE_CHARS).toBe(4_096 * 4)
    expect(P.SUMMARY_OUTPUT_TOKENS).toBe(4_096)
    expect(P.MAX_CHUNK_COUNT).toBe(4)
    expect(P.TOOL_OUTPUT_MAX_CHARS).toBe(2_000)
  })

  test("every proposal is admitted with a materially non-empty prior-summary reserve and deterministic ids", () => {
    const P = planner()
    const u1 = userMessage({ text: "one " + "a".repeat(3_000) })
    const a1 = assistantMessage({})
    const u2 = userMessage({ text: "two " + "b".repeat(3_000) })
    const a2 = assistantMessage({})
    const latest = turn(userMessage({ text: "latest" }), [])
    const messages = [...turn(u1, [a1]), ...turn(u2, [a2]), ...latest]
    const config = cfg()
    const budget = compactionBudget(qwen(), config)
    expect(budget).toBe(237_568) // Qwen route with the 4,096 compaction allowance

    const plan = P.plan({ messages, model: qwen(), cfg: config, requestHash: "seed" })
    expect(plan.proposals.length).toBe(plan.chunks.length)
    expect(plan.proposals.length).toBeGreaterThanOrEqual(1)
    for (const [i, proposal] of plan.proposals.entries()) {
      expect(proposal.chunk.index).toBe(i)
      // The estimate counts the serialized proposal PLUS the worst-case
      // 16,384-character prior-summary reserve (admission may never assume an
      // empty prior summary).
      const materialized = Math.ceil((JSON.stringify(proposal.request).length + P.SUMMARY_RESERVE_CHARS) / 4)
      expect(proposal.requestEstimate).toBeGreaterThanOrEqual(materialized)
      // The proposal is admitted against the compaction-phase budget.
      expect(proposal.requestEstimate).toBeLessThanOrEqual(budget)
      expect(proposal.admitted).toBe(true)
      // Deterministic sha-256 hex request hash.
      expect(proposal.requestHash).toMatch(/^[0-9a-f]{64}$/)
    }

    // Deterministic boundaries and hashes across repeated planning.
    const plan2 = P.plan({ messages, model: qwen(), cfg: config, requestHash: "seed" })
    expect(plan2.chunks.map((chunk) => chunk.messages.map((m) => m.info.id))).toEqual(
      plan.chunks.map((chunk) => chunk.messages.map((m) => m.info.id)),
    )
    expect(plan2.proposals.map((p) => p.requestHash)).toEqual(plan.proposals.map((p) => p.requestHash))
  })

  test("a history that only fits when the prior summary is empty is never packed into a single chunk", () => {
    const P = planner()
    // Two old turns of 472,000 chars each: one chunk = 944,000 chars
    // (236,000 tokens) + the 16,384-char reserve (4,096 tokens) = 240,096
    // tokens > the 237,568-token compaction budget, even with zero wrapper
    // overhead. A reserve-honoring planner must split; a planner that only
    // fits when the summary is empty would attempt one chunk.
    const half = "c".repeat(472_000)
    const u1 = userMessage({ parts: [{ id: partID(), sessionID, messageID: "pending" as SessionV1.TextPart["messageID"], type: "text", text: half }] })
    const a1 = assistantMessage({})
    const u2 = userMessage({ parts: [{ id: partID(), sessionID, messageID: "pending" as SessionV1.TextPart["messageID"], type: "text", text: half }] })
    const a2 = assistantMessage({})
    const messages = [...turn(u1, [a1]), ...turn(u2, [a2]), ...turn(userMessage({ text: "latest" }), [])]

    const plan = P.plan({ messages, model: qwen(), cfg: cfg() })
    expect(plan.chunks.length).toBeGreaterThanOrEqual(2)
    expect(plan.chunks.length).toBeLessThanOrEqual(P.MAX_CHUNK_COUNT)

    const budget = compactionBudget(qwen(), cfg())
    for (const proposal of plan.proposals) {
      const withReserve = Math.ceil((JSON.stringify(proposal.request).length + P.SUMMARY_RESERVE_CHARS) / 4)
      expect(proposal.requestEstimate).toBeGreaterThanOrEqual(withReserve)
      expect(proposal.requestEstimate).toBeLessThanOrEqual(budget)
      expect(proposal.admitted).toBe(true)
    }
  })

  test("a fifth chunk requirement fails terminally with reason chunk-limit", () => {
    const P = planner()
    // Nine turns of ~85,000 tokens each: at most two fit per chunk (three
    // would be 255,000 tokens + reserve > 237,568 with any overhead), so
    // covering them needs at least five chunks — one past the limit.
    const body = "d".repeat(340_000)
    const messages: SessionV1.WithParts[] = []
    for (let i = 0; i < 9; i++) {
      messages.push(...turn(userMessage({ parts: [{ id: partID(), sessionID, messageID: "pending" as SessionV1.TextPart["messageID"], type: "text", text: body }] }), [assistantMessage({})]))
    }
    messages.push(...turn(userMessage({ text: "latest" }), []))

    let caught: unknown
    try {
      P.plan({ messages, model: qwen(), cfg: cfg() })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const data = impossibleReason(caught)
    expect(data.reason).toBe("chunk-limit")
  })
})

// ─── Pre-call rejections: fixed overhead and latest turn ─────────────────────

describe("CompactionPlanner - pre-call rejections before any chunk planning", () => {
  test("a route whose compaction budget is zero fails with fixed-overhead and proposes nothing", () => {
    const P = planner()
    // Compaction budget = 24,576 - max(20,000, 4,096 + 20,480) = 0: not even
    // the fixed transformed overhead fits, so nothing may be planned or sent.
    const model = createModel({ context: 24_576, output: 32_000 })
    expect(compactionBudget(model, cfg())).toBe(0)
    const messages = [
      ...turn(userMessage({ text: "old" }), [assistantMessage({})]),
      ...turn(userMessage({ text: "latest" }), []),
    ]

    let caught: unknown
    try {
      P.plan({ messages, model, cfg: cfg() })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const data = impossibleReason(caught)
    expect(data.reason).toBe("fixed-overhead")
    expect(data.phase).toBe("compaction")
  })

  test("a latest turn that cannot fit intact fails with latest-turn-too-large and proposes nothing", () => {
    const P = planner()
    // 1,200,000 chars = 300,000 tokens: alone exceeds the 237,568-token
    // compaction budget, so the intact latest turn can never be admitted.
    const giant = "e".repeat(1_200_000)
    const messages = [
      ...turn(userMessage({ text: "old" }), [assistantMessage({})]),
      ...turn(userMessage({ parts: [{ id: partID(), sessionID, messageID: "pending" as SessionV1.TextPart["messageID"], type: "text", text: giant }] }), []),
    ]

    let caught: unknown
    try {
      P.plan({ messages, model: qwen(), cfg: cfg() })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const data = impossibleReason(caught)
    expect(data.reason).toBe("latest-turn-too-large")
    expect(data.phase).toBe("compaction")
  })
})

// T05 expected RED: the current source exports the bounded planner, but no
// rolling executor. Keep this namespace access guarded so the failure is the
// missing behavior rather than a module-resolution or syntax failure.
type RollingRequest = {
  readonly previousSummary?: string
  readonly chunk: PlannerChunk
  readonly latestTurn: readonly SessionV1.WithParts[]
}

type RollingResult = {
  readonly status: "completed" | "mid-execution-over-budget" | "no-reduction" | "post-compaction-over-budget"
  readonly summary?: string
  readonly calls: number
  readonly admissions: readonly { readonly estimate: number; readonly budget: number; readonly admitted: boolean }[]
  readonly before: { readonly estimate: number; readonly budget: number }
  readonly after?: { readonly estimate: number; readonly budget: number }
  readonly persisted: boolean
}

type RollingExecutorNamespace = {
  run(input: {
    readonly plan: PlannerPlan
    readonly model: Provider.Model
    readonly cfg: ConfigV1.Info
    readonly previousSummary?: string
    readonly summarize: (request: RollingRequest) => Effect.Effect<{ readonly text: string }>
    readonly persist?: (result: RollingResult) => Effect.Effect<void>
    readonly signal?: AbortSignal
  }): Effect.Effect<RollingResult, unknown>
}

function rollingExecutor(): RollingExecutorNamespace {
  const ns = (Compaction as unknown as { CompactionExecutor?: RollingExecutorNamespace }).CompactionExecutor
  if (!ns) throw new Error("T05 RED: missing CompactionExecutor rolling-summary execution boundary")
  return ns
}

function rollingPlan(count: number): PlannerPlan {
  const chunks = Array.from({ length: count }, (_, index) => ({
    index,
    messages: [userMessage({ text: `rolling-chunk-${index}` })],
  }))
  return {
    chunks,
    latestTurn: [userMessage({ text: "rolling-latest" })],
    proposals: chunks.map((chunk) => ({
      chunk,
      request: { phase: "compaction", chunkIndex: chunk.index },
      requestEstimate: 1,
      requestHash: "0".repeat(64),
      admitted: true,
    })),
  }
}

describe("CompactionExecutor - bounded rolling summaries", () => {
  it.effect("uses the prior summary plus each next chunk and fresh budget admission for one-to-four calls", () => {
    const executor = rollingExecutor()
    const requests: RollingRequest[] = []
    return Effect.gen(function* () {
      const result = yield* executor.run({
        plan: rollingPlan(3),
        model: qwen(),
        cfg: cfg(),
        previousSummary: "seed-summary",
        summarize: (request) =>
          Effect.sync(() => {
            requests.push(request)
            return { text: `summary-${request.chunk.index}` }
          }),
      })

      expect(result.status).toBe("completed")
      expect(result.calls).toBe(3)
      expect(requests).toHaveLength(3)
      expect(JSON.stringify(requests[0])).toContain("seed-summary")
      expect(JSON.stringify(requests[0])).toContain("rolling-chunk-0")
      expect(JSON.stringify(requests[1])).toContain("summary-0")
      expect(JSON.stringify(requests[1])).toContain("rolling-chunk-1")
      expect(JSON.stringify(requests[2])).toContain("summary-1")
      expect(JSON.stringify(requests[2])).toContain("rolling-chunk-2")
      expect(result.admissions).toHaveLength(3)
      expect(result.admissions.every((admission) => admission.admitted)).toBe(true)
      expect(result.after?.estimate).toBeLessThan(result.before.estimate)
      expect(result.after?.estimate).toBeLessThanOrEqual(result.after?.budget ?? -1)
      expect(result.persisted).toBe(true)
    })
  })

  it.effect("stops at the first over-budget rolling request and never calls a later chunk", () => {
    const executor = rollingExecutor()
    const requests: RollingRequest[] = []
    const persist = mockPersist()
    return Effect.gen(function* () {
      const result = yield* executor.run({
        plan: rollingPlan(4),
        model: qwen(),
        cfg: cfg(),
        summarize: (request) =>
          Effect.sync(() => {
            requests.push(request)
            return { text: request.chunk.index === 0 ? "x".repeat(17_000) : `summary-${request.chunk.index}` }
          }),
        persist,
      })

      expect(result.status).toBe("mid-execution-over-budget")
      expect(result.calls).toBe(1)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.chunk.index).toBe(0)
      expect(persist).not.toHaveBeenCalled()
      expect(result.persisted).toBe(false)
    })
  })

  it.effect("keeps failed execution nonpersistent when interrupted before finalization", () => {
    const executor = rollingExecutor()
    const persist = mockPersist()
    const controller = new AbortController()
    controller.abort()

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        executor.run({
          plan: rollingPlan(1),
          model: qwen(),
          cfg: cfg(),
          signal: controller.signal,
          summarize: () => Effect.succeed({ text: "summary" }),
          persist,
        }),
      )

      expect(String(exit)).toContain("Failure")
      expect(persist).not.toHaveBeenCalled()
    })
  })

  it.effect("rejects a non-reducing or still-over-budget final projection without persistence", () => {
    const executor = rollingExecutor()
    const persist = mockPersist()
    return Effect.gen(function* () {
      // The rolling summary (4,000 chars = 1,000 tokens) is far larger than
      // the one chunk it replaces (15 chars), so the rebuilt final projection
      // cannot be smaller than the pre-compaction estimate: the execution must
      // terminate on the E_after < E_before requirement without persisting.
      const result = yield* executor.run({
        plan: rollingPlan(1),
        model: qwen(),
        cfg: cfg(),
        summarize: () => Effect.succeed({ text: "s".repeat(4_000) }),
        persist,
      })

      expect(result.status).toBe("no-reduction")
      expect(result.persisted).toBe(false)
      expect(persist).not.toHaveBeenCalled()
    })
  })
})

function mockPersist() {
  return mock(() => Effect.void)
}
