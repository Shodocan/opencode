import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

const InternalSessionEvent = SessionEvent as typeof SessionEvent & {
  InternalDurableDefinitions?: readonly { type: string; durable?: { version: number; aggregate: string } }[]
  CompactionFinalized?: { type: string; durable?: { version: number; aggregate: string } }
  ContextBudgetLineage?: { type: string; durable?: { version: number; aggregate: string } }
}

// T06 RED contract: the lineage event is the +2 internal durable entry. The
// sentinel keeps the failure behavioral (the missing event) rather than a
// load or environment error.
function lineageDefinition() {
  const definition = InternalSessionEvent.ContextBudgetLineage
  if (!definition) throw new Error("T06 RED: missing ContextBudgetLineage internal durable event")
  return definition
}

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    // Public counts measured on the authorized dirty baseline (post upstream
    // v1.17.11 schema reorg). T05 must leave these byte-identical: the
    // CompactionFinalized event is internal durable state, not public surface.
    // The storage-replay durable inventory (+1 internal) is sealed below.
    expect(EventManifest.ServerDefinitions.length).toBe(58)
    expect(EventManifest.Definitions.length).toBe(90)
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(90)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Definitions.slice(43, 46)).toEqual([
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })

  test("keeps internal durable events out of the public event inventories", () => {
    const internal = InternalSessionEvent.InternalDurableDefinitions
    const finalized = InternalSessionEvent.CompactionFinalized
    const lineage = lineageDefinition()

    // Exactly two internal durable events (the T05 +1 CompactionFinalized and
    // the T06 +2 ContextBudgetLineage): both live only in
    // InternalDurableDefinitions, never in the public inventories.
    expect(internal).toBeDefined()
    expect(finalized).toBeDefined()
    expect(internal).toContain(finalized)
    expect(internal).toContain(lineage)
    expect(internal).toHaveLength(2)
    expect(finalized).toMatchObject({ type: "session.next.compaction.finalized", durable: { aggregate: "sessionID", version: 1 } })
    expect(lineage).toMatchObject({ type: "session.next.context-budget.lineage", durable: { aggregate: "sessionID", version: 1 } })
    expect(EventManifest.Definitions.some((definition) => definition.type === finalized?.type)).toBe(false)
    expect(SessionEvent.Definitions.some((definition) => definition.type === finalized?.type)).toBe(false)
    expect(SessionEvent.DurableDefinitions.some((definition) => definition.type === finalized?.type)).toBe(false)
    expect(EventManifest.Definitions.some((definition) => definition.type === lineage.type)).toBe(false)
    expect(SessionEvent.Definitions.some((definition) => definition.type === lineage.type)).toBe(false)
    expect(SessionEvent.DurableDefinitions.some((definition) => definition.type === lineage.type)).toBe(false)
    // Public durable inventory is unchanged (28); the storage-replay manifest
    // gains exactly the two internal entries (35 public durable + 2 internal).
    expect(SessionEvent.DurableDefinitions).toHaveLength(28)
    expect(EventManifest.Durable.size).toBe(37)
    expect(EventManifest.Durable.has("session.next.compaction.finalized.1")).toBe(true)
    expect(EventManifest.Durable.has("session.next.context-budget.lineage.1")).toBe(true)
  })
})
