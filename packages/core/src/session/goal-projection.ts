export * as SessionGoalProjection from "./goal-projection"

import { Effect } from "effect"
import type { Database } from "../database/database"
import type { SessionEvent } from "./event"
import { SessionGoalTable } from "./sql"

type DatabaseService = Database.Interface["db"]

// FORK FEATURE (13) autonomy-stack / L4 — the session_goal projection.
//
// Lives in its own module deliberately, for two reasons:
//   1. `goal.ts` is the PURE fold (no Effect, no I/O, no clock). A db-touching
//      upsert there would break the property that makes budget accounting
//      auditable -- the domain records state and cannot decide to spend.
//   2. `projector.ts` is a hot file (26 commits/6mo). Keeping the body here
//      means the hot file gains only the registration, not the logic.
//
// The upsert is TOTAL rather than a merge: every goal event carries the
// complete post-mutation snapshot (D-2), so the row is simply replaced. That is
// what makes the projection incapable of drifting from the event log.
export function project(db: DatabaseService, event: SessionEvent.Goal.Changed) {
  const row = {
    session_id: event.data.sessionID,
    goal_id: event.data.goalID,
    revision: event.data.revision,
    objective: event.data.objective,
    phase: event.data.phase,
    max_rounds: event.data.maxRounds,
    max_tokens: event.data.maxTokens,
    rounds_started: event.data.roundsStarted,
    tokens_used: event.data.tokensUsed,
    blocked_code: event.data.blocked?.code ?? null,
    blocked_message: event.data.blocked?.message ?? null,
  }
  return db
    .insert(SessionGoalTable)
    .values(row)
    .onConflictDoUpdate({ target: SessionGoalTable.session_id, set: row })
    .run()
    .pipe(Effect.orDie)
}
