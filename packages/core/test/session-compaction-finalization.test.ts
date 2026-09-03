import { describe, expect } from "bun:test"
import * as path from "path"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

// T05 RED contract: the event is internal durable state, while its projector
// writes the complete final checkpoint directly and atomically.
const InternalSessionEvent = SessionEvent as typeof SessionEvent & {
  readonly InternalDurableDefinitions?: readonly [{ readonly type: string; readonly durable?: unknown }, ...unknown[]]
  readonly CompactionFinalized?: {
    readonly type: string
    readonly durable?: { readonly version: number; readonly aggregate: string }
  }
}

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const timestamp = DateTime.makeUnsafe(1)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

function finalizedDefinition() {
  const definition = InternalSessionEvent.CompactionFinalized
  if (!definition) throw new Error("T05 RED: missing CompactionFinalized internal durable event")
  return definition
}

function eventData(suffix: string) {
  const user = SessionMessage.User.make({
    id: SessionMessage.ID.make(`msg_compaction_${suffix}_user`),
    type: "user",
    text: "compact this",
    time: { created: timestamp },
  })
  const assistant = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(`msg_compaction_${suffix}_assistant`),
    type: "assistant",
    agent: "compaction",
    model,
    content: [SessionMessage.AssistantText.make({ type: "text", id: `text_${suffix}`, text: "anchored summary" })],
    finish: "stop",
    cost: 1,
    tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 4, write: 5 } },
    time: { created: timestamp, completed: DateTime.makeUnsafe(2) },
  })
  const marker = SessionMessage.Compaction.make({
    id: SessionMessage.ID.make(`msg_compaction_${suffix}_marker`),
    type: "compaction",
    reason: "auto",
    summary: "anchored summary",
    recent: "recent text",
    time: { created: timestamp },
  })

  return {
    sessionID: SessionV2.ID.make(`ses_compaction_${suffix}`),
    timestamp,
    compaction: { message: user, marker, assistant, parts: assistant.content },
    recent: "recent text",
    usage: { cost: 1, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 4, write: 5 } } },
    before: { estimate: 100, budget: 200 },
    after: { estimate: 50, budget: 200 },
  }
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
        slug: "compaction",
        directory: "/project",
        title: "compaction",
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

function targetLayer(database: Layer.Layer<Database.Service>) {
  // fresh: the outer test layer already instantiated the shared Database layer
  // in this run's memo map; without fresh the override would be memoized away.
  return Layer.fresh(
    AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
      [Database.node, database],
    ]),
  )
}

function messageSnapshot() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionMessageTable)
      .orderBy(asc(SessionMessageTable.seq), asc(SessionMessageTable.id))
      .all()
      .pipe(Effect.orDie)
  })
}

describe("CompactionFinalized", () => {
  it.effect("projects complete state once and notifies/autocontinues after commit", () =>
    Effect.gen(function* () {
      const finalized = finalizedDefinition()
      expect(InternalSessionEvent.InternalDurableDefinitions).toContain(finalized)
      expect(finalized.durable).toEqual({ aggregate: "sessionID", version: 1 })
      const data = eventData("published")
      const { db } = yield* Database.Service
      yield* seedSession(data.sessionID)
      const events = yield* EventV2.Service
      const order: string[] = []
      let visibleAfterCommit = false
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== finalized.type) return Effect.void
        order.push("notification")
        return Effect.gen(function* () {
          const rows = yield* messageSnapshot()
          visibleAfterCommit = rows.length === 3
          order.push("autocontinue")
        }).pipe(Effect.provideService(Database.Service, { db }))
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const first = (yield* events.publish(finalized as never, data as never, {
        id: EventV2.ID.make("evt_compaction_finalized_published"),
        commit: () => Effect.sync(() => order.push("commit")),
      })) as { type: string; durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number } }
      expect(first.type).toBe(finalized.type)
      expect(first.durable).toMatchObject({ aggregateID: data.sessionID, version: finalized.durable?.version })
      expect(order).toEqual(["commit", "notification", "autocontinue"])
      expect(visibleAfterCommit).toBe(true)

      const rows = yield* messageSnapshot()
      const messages = rows.map((row) => Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }))
      expect(new Set(rows.map((row) => row.id))).toEqual(
        new Set([
          data.compaction.message.id,
          data.compaction.marker.id,
          data.compaction.assistant.id,
        ]),
      )
      expect(messages.find((message) => message.type === "user")).toMatchObject({ text: "compact this" })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "anchored summary",
        recent: "recent text",
      })
      expect(messages.find((message) => message.type === "assistant")).toMatchObject({
        id: data.compaction.assistant.id,
        content: [{ type: "text", id: "text_published", text: "anchored summary" }],
        finish: "stop",
      })

      const eventRows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, data.sessionID)).all()
      // One versioned durable event (type stored as `<type>.<version>`).
      expect(eventRows).toHaveLength(1)
      expect(eventRows[0]!.type).toBe("session.next.compaction.finalized.1")
      const snapshot = JSON.stringify({ messages: rows, events: eventRows })
      yield* events.replay(serialized(eventRows)[0]!)
      expect(JSON.stringify({ messages: yield* messageSnapshot(), events: yield* db.select().from(EventTable).all() })).toBe(
        snapshot,
      )
      expect(order).toEqual(["commit", "notification", "autocontinue"])
    }),
  )

  it.effect("cold-replays the finalization into a fresh database without duplicate rows", () =>
    Effect.gen(function* () {
      const finalized = finalizedDefinition()
      const data = eventData("cold")
      const sourceDB = yield* Database.Service
      yield* seedSession(data.sessionID)
      const sourceEvents = yield* EventV2.Service
      yield* sourceEvents.publish(finalized as never, data as never, {
        id: EventV2.ID.make("evt_compaction_finalized_cold"),
      })
      const sourceRows = yield* sourceDB.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, data.sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const sourceMessages = yield* messageSnapshot()
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const database = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))

      yield* Effect.gen(function* () {
        yield* seedSession(data.sessionID)
        const events = yield* EventV2.Service
        const serializedEvents = serialized(sourceRows)
        yield* events.replayAll(serializedEvents)
        expect(yield* messageSnapshot()).toEqual(sourceMessages)
        const firstSnapshot = JSON.stringify({
          events: yield* (yield* Database.Service).db.select().from(EventTable).all(),
          messages: yield* messageSnapshot(),
        })

        yield* events.replayAll(serializedEvents)
        expect(
          JSON.stringify({
            events: yield* (yield* Database.Service).db.select().from(EventTable).all(),
            messages: yield* messageSnapshot(),
          }),
        ).toBe(firstSnapshot)
      }).pipe(Effect.provide(targetLayer(database)))
    }),
  )

  it.effect("rolls back rows and the event when the finalization commit hook fails", () =>
    Effect.gen(function* () {
      const finalized = finalizedDefinition()
      const data = eventData("rollback")
      yield* seedSession(data.sessionID)
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const exit = yield* events
        .publish(finalized as never, data as never, {
          id: EventV2.ID.make("evt_compaction_finalized_rollback"),
          commit: () => Effect.die("finalization commit failed"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("finalization commit failed")
      expect(yield* db.select().from(SessionMessageTable).all()).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, data.sessionID)).all()).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, data.sessionID)).all()).toEqual([])
    }),
  )
})
