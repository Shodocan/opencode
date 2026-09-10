import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Exit } from "effect"
import { Session } from "../../src/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { BackgroundJob } from "../../src/background/job"
import { AppLayer } from "../../src/effect/app-runtime"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
for (const action of ["cancel", "remove"] as const) {
  it.instance(`native session ${action} joins a matching failed job's held cleanup before returning`, () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service
    const jobs = yield* BackgroundJob.Service
    const parent = yield* sessions.create({ title: "held cleanup parent" })
    const fail = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const returned = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const id = "held-cleanup-child"
    yield* jobs.start({ id, type: "task", metadata: { parentSessionId: parent.id },
      run: Deferred.await(fail).pipe(Effect.andThen(Effect.fail(new Error("settled child error")))) })
    yield* jobs.extend({ id, run: Effect.never.pipe(Effect.ensuring(
      Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release))),
    )) })
    yield* Effect.gen(function* () {
      yield* Deferred.succeed(fail, undefined)
      yield* awaitWithTimeout(Deferred.await(interrupted), "child cleanup never began")
      expect(yield* jobs.get(id)).toMatchObject({ status: "error" })
      const operation = action === "remove" ? sessions.remove(parent.id) : runState.cancel(parent.id)
      yield* Deferred.succeed(started, undefined).pipe(Effect.andThen(operation),
        Effect.andThen(Deferred.succeed(returned, undefined)), Effect.forkChild)
      yield* Deferred.await(started)
      // Both paths may touch the real session DB. Bound the observation while
      // keeping the finalizer held, rather than assuming one scheduler tick.
      const early = yield* Deferred.await(returned).pipe(Effect.timeoutOption(100))
      expect(early._tag, "a failed status does not prove that native child cleanup has completed").toBe("None")
      expect(Exit.isSuccess(yield* sessions.get(parent.id).pipe(Effect.exit)), "session row must survive until its cleanup is quiescent").toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(Deferred.await(returned), "native session operation did not finish after cleanup")
      expect(Exit.isSuccess(yield* sessions.get(parent.id).pipe(Effect.exit))).toBe(action !== "remove")
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  }))
}
