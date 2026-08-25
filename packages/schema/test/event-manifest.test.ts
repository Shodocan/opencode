import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions.length).toBe(60) // +1 fork: session.next.goal.changed
    expect(EventManifest.Definitions.length).toBe(92) // +1 fork: session.next.goal.changed
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
    expect(EventManifest.Latest.size).toBe(92) // +1 fork: session.next.goal.changed
    expect(EventManifest.Durable.size).toBe(37) // +1 fork: session.next.goal.changed
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
    // FORK FEATURE (13) autonomy-stack: session.next.goal.changed is appended to the end of
    // SessionEvent.Definitions, which sits immediately before the SessionV1 live events in the
    // composed manifest -- so these three shift by exactly 1 (44..46 upstream -> 45..47 here).
    expect(EventManifest.Definitions.slice(45, 48)).toEqual([
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
