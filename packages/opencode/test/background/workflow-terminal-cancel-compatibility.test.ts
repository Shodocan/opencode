import { expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob } from "@/background/job"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(BackgroundJob.node))

it.instance("generic cancel of an already failed job returns its terminal snapshot without waiting for caller-held cleanup", () => Effect.gen(function* () {
  const jobs = yield* BackgroundJob.Service
  const fail = yield* Deferred.make<void>()
  const interrupted = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const returned = yield* Deferred.make<BackgroundJob.Info | undefined>()
  const began = yield* Deferred.make<void>()
  const id = "terminal-cancel-compatibility"
  yield* jobs.start({ id, type: "fixture", run: Deferred.await(fail).pipe(Effect.andThen(Effect.fail(new Error("original failure")))) })
  yield* jobs.extend({ id, run: Effect.never.pipe(Effect.ensuring(
    Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release))),
  )) })
  yield* Effect.gen(function* () {
    yield* Deferred.succeed(fail, undefined)
    yield* awaitWithTimeout(Deferred.await(interrupted), "extension finalizer did not start")
    expect(yield* jobs.get(id)).toMatchObject({ status: "error", error: "original failure" })
    yield* Deferred.succeed(began, undefined).pipe(Effect.andThen(jobs.cancel(id)),
      Effect.flatMap(value => Deferred.succeed(returned, value)), Effect.forkChild)
    yield* Deferred.await(began)
    yield* Effect.yieldNow
    expect(yield* Deferred.isDone(returned), "terminal generic cancel must not depend on cleanup released by its caller").toBe(true)
    expect(yield* Deferred.await(returned)).toMatchObject({ status: "error", error: "original failure" })
    expect(yield* jobs.get(id)).toMatchObject({ status: "error", error: "original failure" })
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
}))

it.instance("explicit quiescent cancel joins its captured failed generation even when the ID is reused during cleanup", () => Effect.gen(function* () {
  const jobs = yield* BackgroundJob.Service
  const fail = yield* Deferred.make<void>()
  const interrupted = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const returned = yield* Deferred.make<BackgroundJob.Info | undefined>()
  const began = yield* Deferred.make<void>()
  const id = "terminal-cancel-reused"
  yield* jobs.start({ id, type: "old", run: Deferred.await(fail).pipe(Effect.andThen(Effect.fail(new Error("old failure")))) })
  yield* jobs.extend({ id, run: Effect.never.pipe(Effect.ensuring(
    Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release))),
  )) })
  yield* Effect.gen(function* () {
    yield* Deferred.succeed(fail, undefined)
    yield* awaitWithTimeout(Deferred.await(interrupted), "old cleanup did not start")
    yield* Deferred.succeed(began, undefined).pipe(Effect.andThen(jobs.cancel(id, { quiescent: true })),
      Effect.flatMap(value => Deferred.succeed(returned, value)), Effect.forkChild)
    yield* Deferred.await(began)
    yield* Effect.yieldNow
    expect(yield* Deferred.isDone(returned)).toBe(false)
    yield* jobs.start({ id, type: "replacement", run: Effect.never })
    yield* Deferred.succeed(release, undefined)
    expect(yield* awaitWithTimeout(Deferred.await(returned), "cancel joined a replacement instead of its captured generation"))
      .toMatchObject({ type: "old", status: "error", error: "old failure" })
    expect(yield* jobs.get(id)).toMatchObject({ type: "replacement", status: "running" })
    yield* jobs.cancel(id)
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
}))
