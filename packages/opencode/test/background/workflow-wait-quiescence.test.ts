import { expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob } from "@/background/job"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(BackgroundJob.node))

const pendingFailure = Effect.gen(function* () {
  const jobs = yield* BackgroundJob.Service
  const fail = yield* Deferred.make<void>()
  const interrupted = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const id = "quiescence-compatibility"
  yield* jobs.start({ id, type: "test", run: Deferred.await(fail).pipe(Effect.andThen(Effect.fail(new Error("expected failure")))) })
  yield* jobs.extend({ id, run: Effect.never.pipe(Effect.ensuring(
    Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release))),
  )) })
  yield* Deferred.succeed(fail, undefined)
  yield* awaitWithTimeout(Deferred.await(interrupted), "extension finalizer never started")
  return { jobs, id, release }
})

it.instance("default wait reports settled failure while cleanup is pending and stale cleanup cannot settle its replacement", () => Effect.gen(function* () {
  const { jobs, id, release } = yield* pendingFailure
  yield* Effect.gen(function* () {
    const result = yield* jobs.wait({ id }).pipe(Effect.timeoutOption(100))
    expect(result._tag, "generic wait must permit the caller to release pending cleanup").toBe("Some")
    if (result._tag !== "Some") return
    expect(result.value).toMatchObject({ timedOut: false, info: { status: "error", error: "expected failure" } })
    yield* jobs.start({ id, type: "replacement", run: Effect.never })
    yield* Deferred.succeed(release, undefined)
    yield* Effect.yieldNow
    expect(yield* jobs.get(id)).toMatchObject({ type: "replacement", status: "running" })
    yield* jobs.cancel(id)
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
}))

it.instance("explicit quiescent wait cannot return before the old job's finalizer completes", () => Effect.gen(function* () {
  const { jobs, id, release } = yield* pendingFailure
  yield* Effect.gen(function* () {
    const returned = yield* Deferred.make<BackgroundJob.WaitResult>()
    const began = yield* Deferred.make<void>()
    const input = { id, quiescent: true }
    yield* Deferred.succeed(began, undefined).pipe(Effect.andThen(jobs.wait(input)),
      Effect.flatMap(value => Deferred.succeed(returned, value)), Effect.forkChild)
    yield* Deferred.await(began)
    yield* Effect.yieldNow
    expect(yield* Deferred.isDone(returned), "workflow quiescence must remain pending while cleanup is held").toBe(false)
    yield* Deferred.succeed(release, undefined)
    expect(yield* awaitWithTimeout(Deferred.await(returned), "quiescent wait never acknowledged released cleanup"))
      .toMatchObject({ timedOut: false, info: { status: "error", error: "expected failure" } })
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
}))

it.instance("explicit quiescent timeout preserves settled failure while reporting cleanup still pending", () => Effect.gen(function* () {
  const { jobs, id, release } = yield* pendingFailure
  yield* Effect.gen(function* () {
    const input = { id, quiescent: true, timeout: 0 }
    expect(yield* jobs.wait(input)).toMatchObject({ timedOut: true, info: { status: "error", error: "expected failure" } })
    yield* Deferred.succeed(release, undefined)
    const drained = { id, quiescent: true }
    expect(yield* awaitWithTimeout(jobs.wait(drained), "cleanup never drained"))
      .toMatchObject({ timedOut: false, info: { status: "error" } })
    expect(yield* jobs.wait(input)).toMatchObject({ timedOut: false, info: { status: "error" } })
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
}))
