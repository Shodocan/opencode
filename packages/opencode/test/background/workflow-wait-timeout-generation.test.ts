import { expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob } from "@/background/job"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(BackgroundJob.node))
for (const reuse of [false, true]) {
  it.instance(`positive quiescent timeout returns its settled captured generation${reuse ? " after ID reuse" : ""}`, () => Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const fail = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const returned = yield* Deferred.make<BackgroundJob.WaitResult>()
    const began = yield* Deferred.make<void>()
    const id = "wait-timeout-generation"
    yield* jobs.start({ id, type: "old", run: Deferred.await(fail).pipe(Effect.andThen(Effect.fail(new Error("old failure")))) })
    yield* jobs.extend({ id, run: Effect.never.pipe(Effect.ensuring(
      Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release))),
    )) })
    yield* Effect.gen(function* () {
      const input = { id, quiescent: true, timeout: 100 }
      yield* Deferred.succeed(began, undefined).pipe(Effect.andThen(jobs.wait(input)),
        Effect.flatMap(value => Deferred.succeed(returned, value)), Effect.forkChild)
      yield* Deferred.await(began)
      yield* Effect.yieldNow
      yield* Deferred.succeed(fail, undefined)
      yield* awaitWithTimeout(Deferred.await(interrupted), "held cleanup never began")
      if (reuse) yield* jobs.start({ id, type: "replacement", run: Effect.never })
      expect(yield* awaitWithTimeout(Deferred.await(returned), "positive timeout did not return"))
        .toMatchObject({ timedOut: true, info: { type: "old", status: "error", error: "old failure" } })
      if (reuse) {
        expect(yield* jobs.get(id)).toMatchObject({ type: "replacement", status: "running" })
        yield* jobs.cancel(id)
      }
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  }))
}
