export * as CompactionTiering from "./tiering"

// FORK FEATURE (5) compaction-enhardening — see FORK_CHANGES.md.
// Tool-output tiering for the compaction SUMMARY HEAD only. The live `recent`
// window is never tiered (it keeps the legacy `truncate`). Goal: preserve
// structural fidelity (F2) of irreplaceable outputs (mutation diffs, file reads)
// in the summary input, while shrinking low-value chatter. Every elided/dropped
// output names `session_recall` so the model knows the detail is recoverable (F3).

export type Tier = "verbatim" | "summarize" | "drop"
export type Fallback = (value: string) => string

// verbatim ≈ 2× legacy truncate (2000); NOT 16k — a large verbatim cap would
// inflate the unbounded summary head and trip compaction's "summary prompt too
// big → refuse" guard on small-context models. `global` bounds the joined head.
export const TIER_CAPS = { verbatim: 4_000, summarize: 1_600, global: 16_000 } as const

export const DEFAULT_TIERS: Record<string, Tier> = {
  // mutation diffs + file/structure reads are irreplaceable -> keep verbatim
  edit: "verbatim",
  write: "verbatim",
  apply_patch: "verbatim",
  patch: "verbatim",
  read: "verbatim",
  lsp: "verbatim",
  glob: "verbatim",
  skill: "verbatim",
  // reproducible / re-runnable -> summarize
  bash: "summarize",
  shell: "summarize",
  grep: "summarize",
  webfetch: "summarize",
  websearch: "summarize",
  task: "summarize",
  list: "summarize",
  // ephemeral status -> drop
  todowrite: "drop",
  question: "drop",
}

// Kill-switch + optional override, both parsed ONCE at module load (never inside
// the per-tool-result hot path — a bad env value must not throw during compaction).
export const ENHARDEN_ENABLED = process.env["OPENCODE_COMPACTION_ENHARDEN"] !== "0"

const TIERS: Record<string, Tier> = (() => {
  const raw = process.env["OPENCODE_COMPACTION_TIERS"]
  if (!raw) return DEFAULT_TIERS
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return { ...DEFAULT_TIERS, ...(parsed as Record<string, Tier>) }
  } catch {
    // malformed override -> fall back to defaults, never throw
  }
  return DEFAULT_TIERS
})()

const RECOVER = "recover via `session_recall`"

// Head+tail anchored truncation (legacy `truncate` keeps head only); keeps the
// end of a diff/file/output, which is where the actionable result usually is.
const anchor = (content: string, cap: number): string => {
  if (content.length <= cap) return content
  const half = Math.max(1, Math.floor((cap - 80) / 2))
  const elided = content.length - 2 * half
  return `${content.slice(0, half)}\n[… ${elided} chars elided — ${RECOVER} …]\n${content.slice(-half)}`
}

// Tier a single completed tool-result's serialized content for the summary head.
// Unknown tools fall through to the legacy fallback (byte-identical behavior).
export const tierToolOutput = (name: string, content: string, fallback: Fallback): string => {
  const tier = TIERS[name]
  if (!tier) return fallback(content)
  if (tier === "drop") return `[${name} output omitted — ${RECOVER}]`
  if (tier === "summarize") return anchor(content, TIER_CAPS.summarize)
  return anchor(content, TIER_CAPS.verbatim)
}

// Bound the joined head (keep the newest content; the previous anchored summary
// already carries older context). Prevents head inflation past the refusal gate.
export const capHead = (head: string): string =>
  head.length <= TIER_CAPS.global ? head : `[… older context elided — ${RECOVER} …]\n${head.slice(-TIER_CAPS.global)}`
