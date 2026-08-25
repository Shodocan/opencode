import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionGoalTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionGoalShell } from "../src/session/goal-service"
import { SessionID } from "../src/session/schema"
import { testEffect } from "./lib/effect"

// FORK FEATURE (13) autonomy-stack / L4 — goal verb acceptance tests (S-1a..S-1d).

const it = testEffect(LayerNode.compile(LayerNode.group([SessionGoalShell.node, Database.node, SessionProjector.node])))
const sessionID = SessionID.make("ses_goal_verbs")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/p"), sandboxes: [] }).run()
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: "s", directory: "/p", title: "t", version: "v" })
    .run()
  SessionGoalShell.clearActivations()
  return { db, goal: yield* SessionGoalShell.Service }
})

const rowOf = (db: any) => (db.select().from(SessionGoalTable).get() as Effect.Effect<any, never, never>)

describe("S-1a create", () => {
  it.effect("opens an active goal at revision 1, armed", () =>
    Effect.gen(function* () {
      const { db, goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it", maxRounds: 5, maxTokens: 1000 })
      const row = yield* rowOf(db)
      expect(row).toMatchObject({ revision: 1, phase: "active", max_rounds: 5, max_tokens: 1000, rounds_started: 0 })
      expect(SessionGoalShell.activationFor(sessionID).armed).toBe(true)
    }),
  )
})

describe("S-1b complete", () => {
  it.effect("marks the goal complete and clears any blocked reason", () =>
    Effect.gen(function* () {
      const { db, goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it" })
      yield* goal.block(sessionID, "model_reported", "stuck")
      yield* goal.complete(sessionID)
      const row = yield* rowOf(db)
      expect(row?.phase).toBe("complete")
      expect(row?.blocked_code).toBeNull()
    }),
  )
})

describe("S-1c report-blocked (P15)", () => {
  it.effect("writes model_reported, never a budget or halt code", () =>
    Effect.gen(function* () {
      const { db, goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it" })
      yield* goal.block(sessionID, "model_reported", "cannot proceed: no credentials")
      const row = yield* rowOf(db)
      expect(row?.blocked_code).toBe("model_reported")
      expect(row?.blocked_message).toContain("credentials")
      expect(row?.phase).toBe("blocked")
    }),
  )
})

describe("S-1d resume — the (P7) precondition enforces frozen C3", () => {
  it.effect("re-arms an active goal that was abort-disarmed", () =>
    Effect.gen(function* () {
      const { goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it" })
      yield* goal.disarm(sessionID, "abort")
      expect(SessionGoalShell.activationFor(sessionID).armed).toBe(false)
      expect(yield* goal.resume(sessionID)).toBe(true)
      expect(SessionGoalShell.activationFor(sessionID).armed).toBe(true)
    }),
  )

  it.effect("is REJECTED on a halt-blocked goal and re-arms nothing", () =>
    Effect.gen(function* () {
      const { goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it" })
      yield* goal.block(sessionID, "halted", "stop-recovery halted the turn")
      yield* goal.disarm(sessionID, "abort")
      expect(yield* goal.resume(sessionID)).toBe(false)
      expect(SessionGoalShell.activationFor(sessionID).armed).toBe(false)
    }),
  )

  it.effect("is REJECTED on a budget-blocked goal (raising a cap is OQ7, not resume)", () =>
    Effect.gen(function* () {
      const { goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it" })
      yield* goal.block(sessionID, "round_budget_exceeded", "round budget reached")
      expect(yield* goal.resume(sessionID)).toBe(false)
    }),
  )

  it.effect("is REJECTED on a completed goal", () =>
    Effect.gen(function* () {
      const { goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it" })
      yield* goal.complete(sessionID)
      expect(yield* goal.resume(sessionID)).toBe(false)
    }),
  )
})

describe("E-13 / D-6 — rounds and activation", () => {
  it.effect("startRound increments rounds_started and bumps revision", () =>
    Effect.gen(function* () {
      const { db, goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it" })
      yield* goal.startRound(sessionID)
      yield* goal.startRound(sessionID)
      const row = yield* rowOf(db)
      expect(row?.rounds_started).toBe(2)
      expect(row?.revision).toBe(3)
    }),
  )

  it.effect("a fresh process reads an active goal as disarmed/load (D-6)", () =>
    Effect.gen(function* () {
      const { goal } = yield* seed
      yield* goal.create(sessionID, { objective: "ship it" })
      SessionGoalShell.clearActivations() // simulate a restart
      const projection = yield* goal.read(sessionID)
      expect(projection?.snapshot.phase).toBe("active")
      expect(projection?.activation.armed).toBe(false)
      expect(projection?.activation.disarmReason).toBe("load")
    }),
  )
})
