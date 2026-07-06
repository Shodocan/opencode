// FORK FEATURE (12) volatile-injection — see FORK_CHANGES.md.
//
// A part flagged `volatile: true` is sent to the LLM on the turn that owns it
// and then stripped from every other turn's context so long-running sessions
// don't accumulate injected context (Hindsight memory, plugin retrievals, etc).
// The parts stay in the DB so the TUI transcript still shows them.
//
// Two strip rules, applied at different call sites:
//
// 1. `filterVolatile` — generation path. Keep volatile parts that belong to the
//    active turn (the most recent user message), drop volatile parts from every
//    other message. Keyed on turn ownership, not the AI-SDK tool-loop step, so it
//    is invariant to tool-loop iterations: mid-turn tool calls keep the current
//    turn's Tier-2 retrievals, prior turns' Tier-2 is gone.
//
// 2. `stripAllVolatile` — compaction/summarization and sub-agent/task input.
//    Strip every volatile part regardless of turn, so ephemeral retrievals can
//    never launder into a permanent summary or inherit into a child agent.

import type { SessionV1 } from "@opencode-ai/core/v1/session"

type VolatilePart = { volatile?: boolean; messageID?: string }
type MessageWithParts = { info: { id: string }; parts: ReadonlyArray<VolatilePart> }

// Keep volatile parts that belong to the active turn, drop the rest.
// `activeUserId` is the id of the most recent user message in the list.
export function filterVolatile<T extends SessionV1.WithParts>(messages: readonly T[], activeUserId: string): T[] {
  return messages.map((m) =>
    m.info.id === activeUserId
      ? m
      : { ...m, parts: m.parts.filter((p) => !(p as VolatilePart).volatile) as T["parts"] },
  )
}

// Strip every volatile part, regardless of which turn it belongs to.
// Use at compaction/summarization and sub-agent/task input so ephemeral
// context never becomes a permanent summary or inherits into a child.
export function stripAllVolatile<T extends SessionV1.WithParts>(messages: readonly T[]): T[] {
  return messages.map((m) => ({ ...m, parts: m.parts.filter((p) => !(p as VolatilePart).volatile) as T["parts"] }))
}

// Exported for tests and callers that already hold the active user id.
export function activeUserIdOf<T extends { info: { role: string; id: string } }>(messages: readonly T[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") return messages[i].info.id
  }
  return undefined
}

// Internal-only type guard helper to satisfy TS without leaking the cast shape.
export type { MessageWithParts }