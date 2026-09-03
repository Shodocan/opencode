import { asc, eq } from "drizzle-orm"
import { describe, expect } from "bun:test"
import { Context, Effect, Exit, Cause, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import path from "path"

// ─── The lineage surface under test ──────────────────────────────────────────
//
// ContextBudgetLineage is event-log only: no table, migration, or
// materialized row. The internal durable event is registered in
// SessionEvent.InternalDurableDefinitions and the read/fold helper queries
// the latest event with the existing (aggregate_id,type,seq) index
// (ORDER BY seq DESC LIMIT 1), validates/folds the serialized full state,
// and folds ordered events on cold replay — failing closed on corrupt state.
//
// Namespace access keeps RED behavioral (asserting an absent export/event
// instead of failing at module resolution): each sentinel below is the
// expected pre-T06 failure reason.

const LINEAGE_TYPE = "session.next.context-budget.lineage"
const LINEAGE_V1 = `${LINEAGE_TYPE}.1`

type LineageDefinition = {
  readonly type: string
  readonly durable?: { readonly version: number; readonly aggregate: string }
  readonly data: unknown
}

const InternalSessionEvent = SessionEvent as typeof SessionEvent & {
  readonly InternalDurableDefinitions?: readonly LineageDefinition[]
  readonly ContextBudgetLineage?: LineageDefinition
}

function lineageDefinition() {
  const definition = InternalSessionEvent.ContextBudgetLineage
  if (!definition) throw new Error("T06 RED: missing ContextBudgetLineage internal durable event")
  const internal = InternalSessionEvent.InternalDurableDefinitions
  if (!internal?.includes(definition)) {
    throw new Error("T06 RED: ContextBudgetLineage is not registered in SessionEvent.InternalDurableDefinitions")
  }
  return definition
}

type RouteEntry = {
  readonly providerID: string
  readonly modelID: string
  readonly runtime: string
  readonly requestHash: string
  readonly outcome: string
}

type LineageState = {
  readonly sessionID: string
  readonly userMessageID: string
  readonly expectedGeneration: number
  readonly newGeneration: number
  readonly compaction_count: number
  readonly routeLedger: readonly RouteEntry[]
  readonly overflowHashes: readonly string[]
  readonly preDispatch: {
    readonly providerID: string
    readonly modelID: string
    readonly runtime: string
    readonly requestHash: string
    readonly projection: unknown
  }
  readonly watermark: { readonly outputSeq: number }
}

type LineageService = {
  readonly latest: (sessionID: string) => Effect.Effect<LineageState | undefined, unknown, never>
  readonly fold: (sessionID: string) => Effect.Effect<LineageState | undefined, unknown, never>
}

type LineageHelper = {
  readonly Service: unknown
  readonly layer: unknown
  readonly node: unknown
}

// Guarded dynamic import: the module is a T06 deliverable, so a pre-T06 tree
// must fail with the helper sentinel, not with a module-resolution error.
const LINEAGE_MODULE = "@opencode-ai/core/session/context-budget-lineage"

// A variable import is untyped and settles on a normal promise: a pre-T06
// tree rejects (module absent) and resolves to undefined instead of failing
// the test file at load time.
const lineageModule = import(LINEAGE_MODULE).catch(() => undefined)

const loadHelper = Effect.fn("test.loadLineageHelper")(function* () {
  const loaded = (yield* Effect.promise(() => lineageModule)) as
    | { readonly ContextBudgetLineage?: LineageHelper }
    | undefined
  const helper = loaded?.ContextBudgetLineage
  if (!helper?.Service || !helper.node) {
    return yield* Effect.fail(new Error("T06 RED: missing core context-budget-lineage read/fold helper"))
  }
  return helper
})

const svcOf = (helper: LineageHelper) => helper.Service as Context.Service<object, LineageService>

const SESSION_ID = SessionV2.ID.make("ses_t06lineage")

let seq = 0
function lineageData(suffix: string, expected: number, generated: number): Record<string, unknown> {
  seq += 1
  return {
    timestamp: 1_700_000_000_000 + seq,
    sessionID: SESSION_ID,
    userMessageID: `msg_t06lineage_${suffix}`,
    expectedGeneration: expected,
    newGeneration: generated,
    compaction_count: generated === 0 ? 0 : 1,
    routeLedger: [
      {
        providerID: "qwen",
        modelID: "qwen3-coder-plus",
        runtime: "ai-sdk",
        requestHash: `${seq % 2 === 0 ? "ab" : "cd"}`.repeat(32),
        outcome: "admitted",
      },
    ],
    overflowHashes: [],
    preDispatch: {
      providerID: "qwen",
      modelID: "qwen3-coder-plus",
      runtime: "ai-sdk",
      requestHash: "ef".repeat(32),
      projection: { system: ["QCB-SYSTEM"], messages: [`QCB-TURN-${suffix}`] },
    },
    watermark: { outputSeq: expected },
  }
}

// Codec-agnostic identity of a decoded full state (timestamps may normalize).
function pick(state: Record<string, unknown>) {
  return JSON.stringify({
    sessionID: state.sessionID,
    userMessageID: state.userMessageID,
    expectedGeneration: state.expectedGeneration,
    newGeneration: state.newGeneration,
    compaction_count: state.compaction_count,
    routeLedger: state.routeLedger,
    overflowHashes: state.overflowHashes,
    preDispatch: state.preDispatch,
    watermark: state.watermark,
  })
}

function seedSession(sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "lineage",
        directory: "/project",
        title: "lineage",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function serialized(rows: readonly { id: EventV2.ID; aggregate_id: string; seq: number; type: string; data: Record<string, unknown> }[]) {
  return rows.map((row) => ({
    id: row.id,
    aggregateID: row.aggregate_id,
    seq: row.seq,
    type: row.type,
    data: row.data,
  }))
}

// The lineage service key is owned by the T06 module and typed structurally
// here through a dummy `object` identifier (see svcOf). Layers that satisfy
// the read therefore provide `object` as their requirement.
function targetLayer(database: Layer.Layer<Database.Service>, helper: LineageHelper) {
  const lineage = helper.node as LayerNode.Node<object, never>
  // fresh: the outer test layer already instantiated the shared Database layer
  // in this run's memo map; without fresh the override would be memoized away.
  return Layer.fresh(
    AppNodeBuilder.build(LayerNode.group([Database.node, lineage, EventV2.node]), [
      [Database.node, database],
    ]),
  )
}

// The helper's node rebuilt with its default (global) dependencies: the
// structural `object` stand-in keeps the read's requirement typed.
const defaultLayerOf = (helper: LineageHelper) =>
  AppNodeBuilder.build(helper.node as LayerNode.Node<object, never>)

function typedFailure(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  // Fail-closed means a typed failure, never a defect (crash/decode throw).
  expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false)
}

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

describe("ContextBudgetLineage", () => {
  it.effect("registers the versioned internal durable event and stores it under the versioned type", () =>
    Effect.gen(function* () {
      const definition = lineageDefinition()
      expect(definition.type).toBe(LINEAGE_TYPE)
      expect(definition.durable).toEqual({ aggregate: "sessionID", version: 1 })
      yield* seedSession(SESSION_ID)
      const events = yield* EventV2.Service
      const data = lineageData("published", 0, 1)
      yield* events.publish(definition as never, data as never, { id: EventV2.ID.make("evt_t06lineage_published") })
      const { db } = yield* Database.Service
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, SESSION_ID))
        .all()
        .pipe(Effect.orDie)
      // One versioned durable event (type stored as `<type>.<version>`).
      expect(rows).toHaveLength(1)
      expect(rows[0]!.type).toBe(LINEAGE_V1)
      // The stored payload is a decodable full state.
      const decoded = Schema.decodeUnknownSync(definition.data as never)(rows[0]!.data)
      expect(pick(decoded as Record<string, unknown>)).toBe(pick(data))
    }),
  )

  it.effect("latest reads the newest indexed lineage state and fold agrees with it", () =>
    Effect.gen(function* () {
      const definition = lineageDefinition()
      const helper = yield* loadHelper()
      yield* seedSession(SESSION_ID)
      const events = yield* EventV2.Service
      const chain = [lineageData("gen1", 0, 1), lineageData("gen2", 1, 2), lineageData("gen3", 2, 3)]
      for (const [index, data] of chain.entries()) {
        yield* events.publish(definition as never, data as never, {
          id: EventV2.ID.make(`evt_t06lineage_chain_${index}`),
        })
      }
      const read = Effect.gen(function* () {
        const svc = yield* svcOf(helper)
        const latest = yield* svc.latest(SESSION_ID)
        const folded = yield* svc.fold(SESSION_ID)
        return { latest, folded }
      }).pipe(Effect.provide(defaultLayerOf(helper)))
      const { latest, folded } = yield* read
      // Bounded read returns the newest full state (generation 3), not the
      // first or an unrelated event.
      expect(latest).toBeDefined()
      expect(pick(latest as Record<string, unknown>)).toBe(pick(chain[2]!))
      expect(pick(folded as Record<string, unknown>)).toBe(pick(chain[2]!))
    }),
  )

  it.effect("fold detects a broken generation chain while latest stays a bounded read", () =>
    Effect.gen(function* () {
      const definition = lineageDefinition()
      const helper = yield* loadHelper()
      yield* seedSession(SESSION_ID)
      const events = yield* EventV2.Service
      // A competing writer rewrites a lower generation at a higher seq: the
      // latest row still decodes (bounded read) but the ordered fold must
      // fail closed (replay conflict).
      yield* events.publish(definition as never, lineageData("first", 0, 1) as never, {
        id: EventV2.ID.make("evt_t06lineage_conflict_first"),
      })
      yield* events.publish(definition as never, lineageData("conflict", 0, 1) as never, {
        id: EventV2.ID.make("evt_t06lineage_conflict_second"),
      })
      const read = Effect.gen(function* () {
        const svc = yield* svcOf(helper)
        const latest = yield* svc.latest(SESSION_ID).pipe(Effect.exit)
        const folded = yield* svc.fold(SESSION_ID).pipe(Effect.exit)
        return { latest, folded }
      }).pipe(Effect.provide(defaultLayerOf(helper)))
      const { latest, folded } = yield* read
      expect(Exit.isSuccess(latest)).toBe(true)
      if (Exit.isSuccess(latest)) {
        expect((latest.value as LineageState).newGeneration).toBe(1)
      }
      typedFailure(folded)
    }),
  )

  it.effect("rejects a corrupt latest lineage row as a typed failure, not a defect", () =>
    Effect.gen(function* () {
      const definition = lineageDefinition()
      const helper = yield* loadHelper()
      yield* seedSession(SESSION_ID)
      const { db } = yield* Database.Service
      // Direct storage of an undecodable full state: the counter is out of
      // the one-shot 0/1 range and the watermark is missing entirely.
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: SESSION_ID, seq: 1 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const corrupt = lineageData("corrupt", 0, 1)
      ;(corrupt as { compaction_count: number }).compaction_count = 7
      delete (corrupt as Record<string, unknown>).watermark
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_t06lineage_corrupt"),
          aggregate_id: SESSION_ID,
          seq: 1,
          type: LINEAGE_V1,
          data: corrupt,
        })
        .run()
        .pipe(Effect.orDie)
      const read = Effect.gen(function* () {
        const svc = yield* svcOf(helper)
        const latest = yield* svc.latest(SESSION_ID).pipe(Effect.exit)
        const folded = yield* svc.fold(SESSION_ID).pipe(Effect.exit)
        return { latest, folded }
      }).pipe(Effect.provide(defaultLayerOf(helper)))
      const { latest, folded } = yield* read
      typedFailure(latest)
      typedFailure(folded)
    }),
  )

  it.effect("returns empty for a session without any lineage event", () =>
    Effect.gen(function* () {
      const helper = yield* loadHelper()
      yield* seedSession(SESSION_ID)
      const read = Effect.gen(function* () {
        const svc = yield* svcOf(helper)
        const latest = yield* svc.latest(SESSION_ID)
        const folded = yield* svc.fold(SESSION_ID)
        return { latest, folded }
      }).pipe(Effect.provide(defaultLayerOf(helper)))
      const { latest, folded } = yield* read
      expect(latest).toBeUndefined()
      expect(folded).toBeUndefined()
    }),
  )

  it.effect("cold-replays ordered lineage into a fresh database idempotently and folds to the same state", () =>
    Effect.gen(function* () {
      const definition = lineageDefinition()
      const helper = yield* loadHelper()
      yield* seedSession(SESSION_ID)
      const sourceEvents = yield* EventV2.Service
      const chain = [lineageData("cold1", 0, 1), lineageData("cold2", 1, 2), lineageData("cold3", 2, 3)]
      for (const [index, data] of chain.entries()) {
        yield* sourceEvents.publish(definition as never, data as never, {
          id: EventV2.ID.make(`evt_t06lineage_cold_${index}`),
        })
      }
      const sourceDB = yield* Database.Service
      const sourceRows = yield* sourceDB.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, SESSION_ID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const database = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))

      yield* Effect.gen(function* () {
        yield* seedSession(SESSION_ID)
        const events = yield* EventV2.Service
        const serializedEvents = serialized(sourceRows)
        yield* events.replayAll(serializedEvents)
        const svc = yield* svcOf(helper)
        const folded = yield* svc.fold(SESSION_ID)
        // The cold fold reaches the same full state as the source chain.
        expect(pick(folded as Record<string, unknown>)).toBe(pick(chain[2]!))
        const { db } = yield* Database.Service
        const firstSnapshot = JSON.stringify({
          events: yield* db.select().from(EventTable).all(),
        })
        // Replaying the same ordered events again is idempotent: the event
        // rows and the folded state are unchanged.
        yield* events.replayAll(serializedEvents)
        const secondSnapshot = JSON.stringify({
          events: yield* (yield* Database.Service).db.select().from(EventTable).all(),
        })
        expect(secondSnapshot).toBe(firstSnapshot)
        const refolded = yield* svc.fold(SESSION_ID)
        expect(pick(refolded as Record<string, unknown>)).toBe(pick(chain[2]!))
      }).pipe(Effect.provide(targetLayer(database, helper)))
    }),
  )
})
