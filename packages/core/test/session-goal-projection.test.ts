import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionGoalTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

// FORK FEATURE (13) autonomy-stack / L4 — session_goal projection (spec D-2, D-7..D-10).

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_goal_projection_test")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .run()
  return db
})

const base = {
  sessionID,
  goalID: "gol_1",
  objective: "ship the autonomy stack",
  maxRounds: 10,
  maxTokens: 100_000,
}

describe("session_goal projection", () => {
  it.effect("materialises a goal snapshot into session_goal (D-7)", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Goal.Changed, {
        ...base,
        timestamp: DateTime.makeUnsafe(1),
        revision: 1,
        phase: "active",
        roundsStarted: 0,
        tokensUsed: 0,
      })
      const row = yield* db.select().from(SessionGoalTable).get()
      expect(row).toMatchObject({
        session_id: sessionID,
        goal_id: "gol_1",
        revision: 1,
        phase: "active",
        max_rounds: 10,
        max_tokens: 100_000,
        rounds_started: 0,
        tokens_used: 0,
        blocked_code: null,
        blocked_message: null,
      })
    }),
  )

  it.effect("the upsert is TOTAL — a later snapshot replaces, never merges (D-2)", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Goal.Changed, {
        ...base,
        timestamp: DateTime.makeUnsafe(1),
        revision: 1,
        phase: "active",
        roundsStarted: 0,
        tokensUsed: 0,
      })
      yield* events.publish(SessionEvent.Goal.Changed, {
        ...base,
        timestamp: DateTime.makeUnsafe(2),
        revision: 2,
        phase: "blocked",
        roundsStarted: 4,
        tokensUsed: 55_000,
        blocked: { code: "round_budget_exceeded", message: "Goal stopped: round budget of 10 reached." },
      })
      const rows = yield* db.select().from(SessionGoalTable).all()
      expect(rows).toHaveLength(1) // upsert on session_id, not a second row
      expect(rows[0]).toMatchObject({
        revision: 2,
        phase: "blocked",
        rounds_started: 4,
        tokens_used: 55_000,
        blocked_code: "round_budget_exceeded",
      })
    }),
  )

  it.effect("clears blocked fields when a later snapshot is not blocked", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Goal.Changed, {
        ...base,
        timestamp: DateTime.makeUnsafe(1),
        revision: 1,
        phase: "blocked",
        roundsStarted: 1,
        tokensUsed: 10,
        blocked: { code: "halted", message: "stop-recovery halted the turn" },
      })
      expect((yield* db.select().from(SessionGoalTable).get())?.blocked_code).toBe("halted")
      // resume -> active, blocked must not linger (this is why the upsert is total)
      yield* events.publish(SessionEvent.Goal.Changed, {
        ...base,
        timestamp: DateTime.makeUnsafe(2),
        revision: 2,
        phase: "active",
        roundsStarted: 1,
        tokensUsed: 10,
      })
      const row = yield* db.select().from(SessionGoalTable).get()
      expect(row?.phase).toBe("active")
      expect(row?.blocked_code).toBeNull()
      expect(row?.blocked_message).toBeNull()
    }),
  )

  it.effect("carries every blocked.code the closed enum allows (D-2 / (P15))", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const events = yield* EventV2.Service
      const codes = ["round_budget_exceeded", "token_budget_exceeded", "halted", "model_reported"] as const
      let revision = 0
      for (const code of codes) {
        revision += 1
        yield* events.publish(SessionEvent.Goal.Changed, {
          ...base,
          timestamp: DateTime.makeUnsafe(revision),
          revision,
          phase: "blocked",
          roundsStarted: revision,
          tokensUsed: 0,
          blocked: { code, message: `blocked: ${code}` },
        })
        expect((yield* db.select().from(SessionGoalTable).get())?.blocked_code).toBe(code)
      }
    }),
  )

  it.effect("the projected row carries no activation column (D-6)", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Goal.Changed, {
        ...base,
        timestamp: DateTime.makeUnsafe(1),
        revision: 1,
        phase: "active",
        roundsStarted: 0,
        tokensUsed: 0,
      })
      const row = yield* db.select().from(SessionGoalTable).get()
      const keys = Object.keys(row ?? {})
      expect(keys).not.toContain("armed")
      expect(keys).not.toContain("activation")
      expect(keys).not.toContain("disarm_reason")
    }),
  )
})
