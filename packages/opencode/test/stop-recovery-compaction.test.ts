import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "../src/session/compaction"

// FORK FEATURE (9) stop-recovery — B3: stop_recovery_continue excluded from
// compaction turn accounting exactly like compaction_continue. The predicate
// only inspects `info.role` and `parts[].{type,synthetic,metadata}`, so we
// construct minimal fixture objects via `as never` casts.

function userMsg(parts: Array<Record<string, unknown>>): never {
  return {
    info: { id: "msg_test", role: "user", sessionID: "ses_test", time: { created: 0 } },
    parts,
  } as never
}

describe("compaction exclusion predicate (FORK FEATURE 9, B3)", () => {
  test("compaction_continue user message is a continuation", () => {
    const msg = userMsg([{ type: "text", synthetic: true, text: "c", metadata: { compaction_continue: true } }])
    expect(SessionCompaction.__test.isCompactionContinuation(msg)).toBe(true)
    expect(SessionCompaction.__test.isSyntheticContinuation(msg)).toBe(true)
  })

  test("stop_recovery_continue user message is a synthetic continuation but NOT compaction", () => {
    const msg = userMsg([
      {
        type: "text",
        synthetic: true,
        text: "c",
        metadata: { stop_recovery_continue: true, stop_recovery: { trigger: "length", attempt: 1 } },
      },
    ])
    expect(SessionCompaction.__test.isCompactionContinuation(msg)).toBe(false)
    expect(SessionCompaction.__test.isStopRecoveryContinuation(msg)).toBe(true)
    expect(SessionCompaction.__test.isSyntheticContinuation(msg)).toBe(true)
  })

  test("plain real user message is NOT a continuation", () => {
    const msg = userMsg([{ type: "text", text: "hello" }])
    expect(SessionCompaction.__test.isSyntheticContinuation(msg)).toBe(false)
    expect(SessionCompaction.__test.isCompactionContinuation(msg)).toBe(false)
    expect(SessionCompaction.__test.isStopRecoveryContinuation(msg)).toBe(false)
  })

  test("assistant message is never a continuation (role guard)", () => {
    const msg = {
      info: { role: "assistant", id: "msg_a", sessionID: "ses_test", time: { created: 0 } },
      parts: [{ type: "text", synthetic: true, text: "c", metadata: { stop_recovery_continue: true } }],
    } as never
    expect(SessionCompaction.__test.isSyntheticContinuation(msg)).toBe(false)
  })
})