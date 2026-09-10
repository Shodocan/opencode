import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppLayer } from "../../src/effect/app-runtime"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Independent author oracle: docs/workflow-targeted-status-expected-red.md.
afterEach(disposeAllInstances)
const it = testEffectShared(Layer.mergeAll(AppLayer, httpApiLayer))
const create = Effect.fn("TargetedStatus.create")(function* (directory: string) {
  const response = yield* requestInDirectory("/session", directory, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "targeted status fixture" }) })
  expect(response.status).toBe(200)
  const value = yield* response.json
  expect(value).toHaveProperty("id")
  return SessionID.make((value as { id: string }).id)
})

it.instance("targeted status explicitly reports a known idle session while sparse status remains empty", () => Effect.gen(function* () {
  const fixture = yield* TestInstance
  const id = yield* create(fixture.directory)
  const sparse = yield* requestInDirectory("/session/status", fixture.directory)
  expect(sparse.status).toBe(200)
  expect(yield* sparse.json).toEqual({})
  const targeted = yield* requestInDirectory("/session/status?sessionID=" + id, fixture.directory)
  expect(targeted.status).toBe(200)
  expect(yield* targeted.json).toEqual({ [id]: { type: "idle" } })
}))

it.instance("targeted status cannot fabricate idle for a nonexistent session", () => Effect.gen(function* () {
  const fixture = yield* TestInstance
  const targeted = yield* requestInDirectory("/session/status?sessionID=" + SessionID.make("ses_missing_status_fixture"), fixture.directory)
  expect(targeted.status).toBe(404)
  expect(yield* targeted.json).toMatchObject({ name: "NotFoundError" })
}))

it.instance("targeted status rejects an existing session owned by another native instance", () => Effect.gen(function* () {
  const fixture = yield* TestInstance
  const foreign = yield* tmpdirScoped({ git: true })
  const id = yield* create(foreign)
  const targeted = yield* requestInDirectory("/session/status?sessionID=" + id, fixture.directory)
  expect(targeted.status).toBe(404)
  expect(yield* targeted.json).toMatchObject({ name: "NotFoundError" })
}))

it.instance("targeted status reads current busy and retry states and returns only the requested session", () => Effect.gen(function* () {
  const fixture = yield* TestInstance
  const status = yield* SessionStatus.Service
  const id = yield* create(fixture.directory)
  const other = yield* create(fixture.directory)
  yield* status.set(other, { type: "busy" })
  const transitions: SessionStatus.Info[] = [{ type: "busy" }, { type: "retry", attempt: 2, message: "retrying", next: Date.now() + 1000 }]
  for (const state of transitions) {
    yield* status.set(id, state)
    const targeted = yield* requestInDirectory("/session/status?sessionID=" + id, fixture.directory)
    expect(targeted.status).toBe(200)
    expect(yield* targeted.json).toEqual({ [id]: state })
  }
}))
