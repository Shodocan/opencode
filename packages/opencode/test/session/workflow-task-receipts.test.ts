import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "../../src/session/session"
import { AppLayer } from "../../src/effect/app-runtime"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)

it.instance("concurrent native receipts and ordinary metadata/title updates preserve every invocation", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "receipt parent" })
  const child = yield* sessions.createTaskChild({ parentID: parent.id, title: "receipt child", agent: "general", permission: [], metadata: {
    "opencode.task.origin": { version: 1, parentSessionID: parent.id, tool: "task", callID: "first-call" },
  } })
  const first: Session.TaskTerminal = {
    version: 1, parentSessionID: parent.id, childSessionID: child.id, callID: "first-call",
    model: { providerID: "test", id: "test-model" }, completedAt: 100,
    status: "cancelled", localQuiescence: true, remoteOutcome: "unknown",
  }
  const second: Session.TaskTerminal = { ...first, callID: "queued-call", completedAt: 101 }
  yield* Effect.all([
    sessions.setTaskTerminal(first),
    sessions.setTaskTerminal(second),
    sessions.setTitle({ sessionID: child.id, title: "concurrent title" }),
    sessions.setMetadata({ sessionID: child.id, metadata: { ordinary_marker: "preserve me" } }),
  ], { concurrency: "unbounded" })
  const persisted = yield* sessions.get(child.id)
  expect(persisted.metadata?.["opencode.task.terminals"]).toEqual({ "first-call": first, "queued-call": second })
  expect(persisted.metadata?.["opencode.task.terminal"]).toEqual(expect.objectContaining({ localQuiescence: true }))
  expect(persisted.metadata?.["opencode.task.origin"]).toEqual(child.metadata?.["opencode.task.origin"])
  expect(persisted.metadata?.ordinary_marker).toBe("preserve me")
  expect(persisted.title).toBe("concurrent title")
  yield* sessions.setMetadata({ sessionID: child.id, metadata: {
    "opencode.task.terminals": { forged: { status: "completed" } },
    "opencode.task.terminal": { status: "forged" },
    public_update: true,
  } })
  const protectedState = yield* sessions.get(child.id)
  expect(protectedState.metadata?.["opencode.task.terminals"]).toEqual({ "first-call": first, "queued-call": second })
  expect(protectedState.metadata?.["opencode.task.terminal"]).toEqual(persisted.metadata?.["opencode.task.terminal"])
  expect(protectedState.metadata?.public_update).toBe(true)
}))

it.instance("public metadata cannot introduce forged per-call terminal receipts on an ordinary session", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "ordinary session", metadata: {
    "opencode.task.terminals": { forged: { status: "completed" } }, ordinary: true,
  } })
  expect(session.metadata?.["opencode.task.terminals"]).toBeUndefined()
  yield* sessions.setMetadata({ sessionID: session.id, metadata: {
    "opencode.task.terminals": { forged: { status: "cancelled" } }, ordinary: true,
  } })
  const persisted = yield* sessions.get(session.id)
  expect(persisted.metadata?.["opencode.task.terminals"]).toBeUndefined()
  expect(persisted.metadata?.ordinary).toBe(true)
}))
