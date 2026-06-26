import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CompactionTiering } from "../src/session/enharden/tiering"

// FORK FEATURE (5) compaction-enhardening — unit tests for head-only tool tiering.

const legacy = (v: string) => (v.length > 2000 ? v.slice(0, 2000) + "…(truncated)" : v)

describe("tierToolOutput", () => {
  test("unknown tool falls through to the legacy fallback (byte-identical)", () => {
    const big = "x".repeat(5000)
    expect(CompactionTiering.tierToolOutput("some_custom_mcp_tool", big, legacy)).toBe(legacy(big))
    const small = "hello"
    expect(CompactionTiering.tierToolOutput("some_custom_mcp_tool", small, legacy)).toBe(small)
  })

  test("verbatim keeps short content unchanged", () => {
    const content = "diff line\n".repeat(10)
    expect(CompactionTiering.tierToolOutput("edit", content, legacy)).toBe(content)
  })

  test("verbatim anchors head+tail and names session_recall, bounded by cap", () => {
    const content = "START" + "m".repeat(10_000) + "END"
    const out = CompactionTiering.tierToolOutput("edit", content, legacy)
    expect(out.startsWith("START")).toBe(true)
    expect(out.endsWith("END")).toBe(true) // tail preserved (legacy truncate would drop it)
    expect(out).toContain("session_recall")
    expect(out.length).toBeLessThanOrEqual(CompactionTiering.TIER_CAPS.verbatim + 120)
  })

  test("summarize uses the smaller cap", () => {
    const content = "S" + "z".repeat(10_000) + "E"
    const out = CompactionTiering.tierToolOutput("bash", content, legacy)
    expect(out.length).toBeLessThanOrEqual(CompactionTiering.TIER_CAPS.summarize + 120)
    expect(out).toContain("session_recall")
  })

  test("drop replaces with a recover marker", () => {
    const out = CompactionTiering.tierToolOutput("todowrite", "a".repeat(3000), legacy)
    expect(out).toBe("[todowrite output omitted — recover via `session_recall`]")
  })

  test("verbatim cap exceeds legacy (preserves more diff fidelity)", () => {
    expect(CompactionTiering.TIER_CAPS.verbatim).toBeGreaterThan(2000)
    expect(CompactionTiering.TIER_CAPS.verbatim).toBeLessThanOrEqual(4000) // but bounded vs the refusal gate
  })

  test("default tiers cover mutation/read as verbatim, status as drop", () => {
    expect(CompactionTiering.DEFAULT_TIERS["edit"]).toBe("verbatim")
    expect(CompactionTiering.DEFAULT_TIERS["read"]).toBe("verbatim")
    expect(CompactionTiering.DEFAULT_TIERS["bash"]).toBe("summarize")
    expect(CompactionTiering.DEFAULT_TIERS["todowrite"]).toBe("drop")
  })
})

describe("capHead", () => {
  test("passes through head under the global ceiling", () => {
    const head = "y".repeat(1000)
    expect(CompactionTiering.capHead(head)).toBe(head)
  })

  test("bounds an oversized head to the global ceiling (keeps newest)", () => {
    const head = "OLD" + "h".repeat(50_000) + "NEWEST"
    const out = CompactionTiering.capHead(head)
    expect(out.length).toBeLessThanOrEqual(CompactionTiering.TIER_CAPS.global + 80)
    expect(out.endsWith("NEWEST")).toBe(true) // newest head content survives
    expect(out).toContain("session_recall")
  })
})

// Merge tripwire: red-fails if a future upstream merge silently drops the
// head-only tiering wiring from compaction.ts.
describe("merge tripwire", () => {
  const src = readFileSync(new URL("../src/session/compaction.ts", import.meta.url), "utf8")
  test("compaction.ts still wires head-only tiering", () => {
    expect(src).toContain("CompactionTiering.tierToolOutput")
    expect(src).toContain("serialize(item.entry.message, tier)") // head re-serialized with tier
    expect(src).toContain("CompactionTiering.capHead")
  })
})
