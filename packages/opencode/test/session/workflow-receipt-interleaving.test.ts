import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "../../src/session/session"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppLayer } from "../../src/effect/app-runtime"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const events = yield* EventV2Bridge.Service
  const parent = yield* sessions.create({ title: "interleaving parent" })
  const child = yield* sessions.createTaskChild({ parentID: parent.id, title: "interleaving child", agent: "general", permission: [], metadata: {
    "opencode.task.origin": { version: 1, parentSessionID: parent.id, tool: "task", callID: "first-call" },
  } })
  const first: Session.TaskTerminal = { version: 1, parentSessionID: parent.id, childSessionID: child.id, callID: "first-call",
    model: { providerID: "test", id: "test-model" }, completedAt: 100, status: "cancelled", localQuiescence: true, remoteOutcome: "unknown" }
  return { sessions, events, child, first }
})

// Each snapshot was read by another host before the newer receipt committed.
// Publishing that delayed native update exercises the shared database projection;
// a process-local semaphore cannot serialize separate hosts or delayed events.
it.instance("delayed ordinary session snapshot cannot erase a committed native receipt", () => Effect.gen(function* () {
  const { sessions, events, child, first } = yield* setup
  const stale = yield* sessions.get(child.id)
  yield* sessions.setTaskTerminal(first)
  yield* events.publish(SessionV1.Event.Updated, { sessionID: child.id, info: { ...stale, title: "other host title" } })
  const actual = yield* sessions.get(child.id)
  expect(actual.title).toBe("other host title")
  expect(actual.metadata?.["opencode.task.terminals"]).toEqual({ "first-call": first })
  expect(actual.metadata?.["opencode.task.terminal"]).toEqual(first)
  expect(actual.metadata?.["opencode.task.origin"]).toEqual(child.metadata?.["opencode.task.origin"])
}))

it.instance("interleaved native terminal snapshots preserve both invocation receipts", () => Effect.gen(function* () {
  const { sessions, events, child, first } = yield* setup
  yield* sessions.setTaskTerminal(first)
  const stale = yield* sessions.get(child.id)
  const second: Session.TaskTerminal = { ...first, callID: "second-call", completedAt: 101 }
  yield* sessions.setTaskTerminal(second)
  yield* events.publish(SessionV1.Event.Updated, { sessionID: child.id, info: { ...stale, title: "delayed first receipt" } })
  const actual = yield* sessions.get(child.id)
  expect(actual.metadata?.["opencode.task.terminals"]).toEqual({ "first-call": first, "second-call": second })
  expect(actual.metadata?.["opencode.task.terminal"]).toEqual(second)
}))

it.instance("a conflicting terminal receipt cannot replace the first durable proof for its native call", () => Effect.gen(function* () {
  const { sessions, child, first } = yield* setup
  yield* sessions.setTaskTerminal(first)
  const conflicting: Session.TaskTerminal = { ...first, completedAt: 101, status: "completed", remoteOutcome: "completed" }
  // Rejection is acceptable; acknowledgement must never rewrite the proof.
  yield* Effect.exit(sessions.setTaskTerminal(conflicting))
  const actual = yield* sessions.get(child.id)
  expect(actual.metadata?.["opencode.task.terminals"]).toEqual({ "first-call": first })
  expect(actual.metadata?.["opencode.task.terminal"]).toEqual(first)
}))

it.instance("delayed metadata cannot replace native child provenance while preserving ordinary updates", () => Effect.gen(function* () {
  const { sessions, events, child } = yield* setup
  const stale = yield* sessions.get(child.id)
  const wrong = { ...stale, metadata: { ...stale.metadata, "opencode.task.origin": {
    version: 1, parentSessionID: "different-parent", tool: "task", callID: "different-call",
  } } }
  yield* Effect.exit(events.publish(SessionV1.Event.Updated, { sessionID: child.id, info: wrong }))
  expect((yield* sessions.get(child.id)).metadata?.["opencode.task.origin"]).toEqual(child.metadata?.["opencode.task.origin"])
}))

it.instance("an identical native terminal receipt remains safe to repeat", () => Effect.gen(function* () {
  const { sessions, child, first } = yield* setup
  yield* sessions.setTaskTerminal(first)
  yield* sessions.setTaskTerminal(structuredClone(first))
  const actual = yield* sessions.get(child.id)
  expect(actual.metadata?.["opencode.task.terminals"]).toEqual({ "first-call": first })
  expect(actual.metadata?.["opencode.task.terminal"]).toEqual(first)
}))
