import { describe, expect, test } from "bun:test"
import { SessionRecall } from "../src/session/enharden/recall"
import { SessionRecallTool } from "../src/tool/session-recall"

// FORK FEATURE (5) compaction-enhardening — recall filtering (F3 recoverability).
// Pure filterMatches is unit-tested here; the search() wrapper adds only the
// `seq < latest-compaction-boundary` SQL (mirrors history.ts messageRows).

const row = (seq: number, type: string, data: unknown) => ({ seq, type, data })
const opts = (over: Partial<Parameters<typeof SessionRecall.filterMatches>[1]> = {}) => ({
  query: "src/auth/login.ts",
  limit: 5,
  contextChars: 200,
  ...over,
})

describe("filterMatches", () => {
  const rows = [
    row(1, "assistant", { content: [{ name: "edit", state: { content: "patched src/auth/login.ts ok" } }] }),
    row(2, "assistant", { content: [{ name: "bash", state: { content: "ran tests, all green" } }] }),
    row(3, "user", { text: "please also touch src/auth/login.ts again" }),
  ]

  test("F3: a pre-compaction edit path is recoverable", () => {
    const r = SessionRecall.filterMatches(rows, opts())
    expect(r.total).toBe(2) // rows 1 and 3 mention the path
    expect(r.matches.length).toBe(2)
    expect(r.matches.some((m) => m.snippet.includes("src/auth/login.ts"))).toBe(true)
    expect(r.matches.map((m) => m.seq)).toEqual([1, 3])
  })

  test("tool filter narrows to a single tool", () => {
    const r = SessionRecall.filterMatches(rows, opts({ tool: "edit" }))
    expect(r.matches.map((m) => m.seq)).toEqual([1])
  })

  test("tool filter matches the name field, not tool-name words in content text", () => {
    // bash output mentions the word "edit" in its text, but no tool is named "edit"
    const noisy = [
      row(1, "assistant", { content: [{ name: "bash", state: { content: "please edit src/auth/login.ts later" } }] }),
    ]
    expect(SessionRecall.filterMatches(noisy, opts({ tool: "edit" })).matches.length).toBe(0)
    expect(SessionRecall.filterMatches(noisy, opts({ tool: "bash" })).matches.length).toBe(1)
  })

  test("no matches for an absent query", () => {
    const r = SessionRecall.filterMatches(rows, opts({ query: "nonexistent-token-xyz" }))
    expect(r.total).toBe(0)
    expect(r.matches.length).toBe(0)
    expect(r.truncated).toBe(false)
  })

  test("limit bounds returned matches and flags truncation", () => {
    const many = Array.from({ length: 10 }, (_, i) => row(i + 1, "user", { text: "match token here" }))
    const r = SessionRecall.filterMatches(many, opts({ query: "match token", limit: 3 }))
    expect(r.matches.length).toBe(3)
    expect(r.total).toBe(10)
    expect(r.truncated).toBe(true)
  })

  test("snippet windows around the match and respects the 8k ceiling", () => {
    const huge = "q".repeat(9000) + "NEEDLE" + "q".repeat(9000)
    const r = SessionRecall.filterMatches([row(1, "user", { text: huge })], opts({ query: "NEEDLE", contextChars: 400 }))
    expect(r.matches.length).toBe(1)
    expect(r.matches[0]!.snippet).toContain("NEEDLE")
    expect(r.matches[0]!.snippet.length).toBeLessThanOrEqual(8000)
  })

  test("query match is case-insensitive", () => {
    const r = SessionRecall.filterMatches([row(1, "user", { text: "See SRC/Auth/Login.TS" })], opts())
    expect(r.matches.length).toBe(1)
  })
})

describe("session_recall tool model output", () => {
  test("empty result explains no matches", () => {
    expect(SessionRecallTool.toModelOutput({ matches: [], total: 0, truncated: false })).toContain("No matches")
  })

  test("renders matches with seq and a more-matches footer", () => {
    const out = SessionRecallTool.toModelOutput({
      matches: [{ seq: 5, type: "assistant", snippet: "patched src/auth/login.ts" }],
      total: 3,
      truncated: true,
    })
    expect(out).toContain("seq 5")
    expect(out).toContain("src/auth/login.ts")
    expect(out).toContain("2 more match")
  })
})
