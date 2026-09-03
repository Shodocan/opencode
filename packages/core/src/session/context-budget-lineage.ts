export * as ContextBudgetLineage from "./context-budget-lineage"

import { and, asc, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Database } from "../database/database"
import { EventV2, InvalidDurableEventError, type Data } from "../event"
import { EventTable } from "../event/sql"
import { SessionEvent } from "./event"

// T06 — event-log-only context-budget lineage read/fold helper.
//
// ContextBudgetLineage is internal durable state: no table, migration, or
// materialized row. `latest` is a bounded read through the existing
// (aggregate_id, type, seq) index (ORDER BY seq DESC LIMIT 1); `fold` is the
// ordered cold-replay fold that validates the generation chain (each state
// expects the previous state's new generation). Both decode the serialized
// full state with the event's own schema and fail closed with a typed
// failure (never a defect) on corrupt or foreign state; an empty lineage
// yields undefined.

const definition = SessionEvent.ContextBudgetLineage
const storedType = EventV2.versionedType(definition.type, 1)
// The event's own data schema is the decode authority for the serialized
// full state; decodeUnknownOption infers the payload type from it.
type LineageState = Data<typeof definition>

export interface Interface {
  readonly latest: (sessionID: string) => Effect.Effect<LineageState | undefined, InvalidDurableEventError, never>
  readonly fold: (sessionID: string) => Effect.Effect<LineageState | undefined, InvalidDurableEventError, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ContextBudgetLineage") {}

const stateError = (message: string) => new InvalidDurableEventError({ type: definition.type, message })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const rows = (sessionID: string, newestFirst: boolean, limit?: number) => {
      const base = db
        .select()
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, storedType)))
        .orderBy(newestFirst ? desc(EventTable.seq) : asc(EventTable.seq))
      const query = limit === undefined ? base : base.limit(limit)
      return query.all().pipe(Effect.orDie)
    }

    const decode = (row: { seq: number; data: Record<string, unknown> }) =>
      Effect.succeed(Schema.decodeUnknownOption(definition.data)(row.data)).pipe(
        Effect.flatMap((value) =>
          Option.isSome(value)
            ? Effect.succeed(value.value)
            : Effect.fail(stateError(`context-budget lineage: undecodable full state at seq ${row.seq}`)),
        ),
      )

    const latest = (sessionID: string) =>
      Effect.gen(function* () {
        const list = yield* rows(sessionID, true, 1)
        const row = list[0]
        if (!row) return undefined
        return yield* decode(row)
      })

    const fold = (sessionID: string) =>
      Effect.gen(function* () {
        const all = yield* rows(sessionID, false)
        if (all.length === 0) return undefined
        let previous: LineageState | undefined
        for (const row of all) {
          const state = yield* decode(row)
          if (previous && state.expectedGeneration !== previous.newGeneration)
            return yield* Effect.fail(
              stateError(
                `context-budget lineage: broken generation chain at seq ${row.seq} (expected ${previous.newGeneration}, found ${state.expectedGeneration})`,
              ),
            )
          previous = state
        }
        return previous
      })

    return Service.of({ latest, fold })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
