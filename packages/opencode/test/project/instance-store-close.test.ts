import { afterEach, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

// Closing must not take longer than this. It is not a matter of speed: without
// the fix the close waits for a load that can no longer finish, for ever.
const BOUND = "3 seconds"

// An instance store whose bootstrap says when it started and then never ends,
// as a real bootstrap that is still starting its services.
const loading = Effect.fnUntraced(function* () {
  const started = yield* Deferred.make<void>()
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(
    LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(
          InstanceBootstrap.Service,
          InstanceBootstrap.Service.of({
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      ],
    ]),
    scope,
  )
  return { started, scope, store: Context.get(context, InstanceStore.Service) }
})

// The close runs in its own fiber: a close that never ends cannot be
// interrupted, so the test waits for it from outside and gives up at the bound.
const close = Effect.fnUntraced(function* (scope: Scope.Closeable) {
  const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkDetach)
  return yield* Fiber.await(closing).pipe(Effect.timeoutOption(BOUND))
})

test("closing the instance store while an instance is still loading completes", async () => {
  await using tmp = await tmpdir({ git: true })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { started, scope, store } = yield* loading()
      const load = yield* store.load({ directory: tmp.path }).pipe(Effect.exit, Effect.forkDetach)
      yield* Deferred.await(started)

      const closed = yield* close(scope)
      // Whoever waited for the instance is told that it will not come.
      const waiter = yield* Fiber.await(load).pipe(Effect.flatten, Effect.timeoutOption(BOUND))
      return { closed: Option.isSome(closed), waiter: Option.map(waiter, Exit.isFailure) }
    }),
  )

  expect(result.closed).toBe(true)
  expect(result.waiter).toEqual(Option.some(true))
}, 20_000)

test("closing the instance store while a reload waits for a load completes", async () => {
  await using tmp = await tmpdir({ git: true })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { started, scope, store } = yield* loading()
      yield* store.load({ directory: tmp.path }).pipe(Effect.exit, Effect.forkDetach)
      yield* Deferred.await(started)
      // The reload waits for the load before it starts its own.
      const reload = yield* store.reload({ directory: tmp.path }).pipe(Effect.exit, Effect.forkDetach)
      yield* Effect.sleep("50 millis")

      const closed = yield* close(scope)
      const waiter = yield* Fiber.await(reload).pipe(Effect.flatten, Effect.timeoutOption(BOUND))
      return { closed: Option.isSome(closed), waiter: Option.map(waiter, Exit.isFailure) }
    }),
  )

  expect(result.closed).toBe(true)
  expect(result.waiter).toEqual(Option.some(true))
}, 20_000)

test("an instance whose load was cut by the close releases what it had started", async () => {
  await using tmp = await tmpdir({ git: true })
  const disposed: string[] = []
  const off = registerDisposer(async (directory) => void disposed.push(directory))
  try {
    const closed = await Effect.runPromise(
      Effect.gen(function* () {
        const { started, scope, store } = yield* loading()
        yield* store.load({ directory: tmp.path }).pipe(Effect.exit, Effect.forkDetach)
        yield* Deferred.await(started)
        return Option.isSome(yield* close(scope))
      }),
    )

    expect(closed).toBe(true)
    // The bootstrap had begun: services may hold watchers, child processes or
    // handles for this directory, and nothing else will ever dispose them.
    expect(disposed).toEqual([tmp.path])
  } finally {
    off()
  }
}, 20_000)

test("closing the instance store disposes a loaded instance and one that is loading", async () => {
  await using loaded = await tmpdir({ git: true })
  await using pending = await tmpdir({ git: true })
  const disposed: string[] = []
  const off = registerDisposer(async (directory) => void disposed.push(directory))
  try {
    const closed = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const scope = yield* Scope.make()
        // The first bootstrap ends, the second one never does.
        const runs = { count: 0 }
        const context = yield* Layer.buildWithScope(
          LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
            [
              InstanceStore.bootstrapNode,
              Layer.succeed(
                InstanceBootstrap.Service,
                InstanceBootstrap.Service.of({
                  run: Effect.suspend(() =>
                    runs.count++ === 0
                      ? Effect.void
                      : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                  ),
                }),
              ),
            ],
          ]),
          scope,
        )
        const store = Context.get(context, InstanceStore.Service)
        yield* store.load({ directory: loaded.path })
        yield* store.load({ directory: pending.path }).pipe(Effect.exit, Effect.forkDetach)
        yield* Deferred.await(started)
        return Option.isSome(yield* close(scope))
      }),
    )

    expect(closed).toBe(true)
    expect(disposed.toSorted()).toEqual([loaded.path, pending.path].toSorted())
  } finally {
    off()
  }
}, 20_000)

test("closing the instance store over a reload of a load that is still bootstrapping leaves no service started after the last disposal", async () => {
  await using tmp = await tmpdir({ git: true })
  // "start" is a service the bootstrap brings up, "dispose" a disposer run.
  const events: string[] = []
  const off = registerDisposer(async () => void events.push("dispose"))
  try {
    const closed = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(
          LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
            [
              InstanceStore.bootstrapNode,
              Layer.succeed(
                InstanceBootstrap.Service,
                InstanceBootstrap.Service.of({
                  // A bootstrap that is still starting services while it is cut.
                  run: Effect.sync(() => events.push("start")).pipe(
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Effect.sleep("200 millis").pipe(Effect.andThen(Effect.sync(() => events.push("start")))),
                    ),
                  ),
                }),
              ),
            ],
          ]),
          scope,
        )
        const store = Context.get(context, InstanceStore.Service)
        yield* store.load({ directory: tmp.path }).pipe(Effect.exit, Effect.forkDetach)
        yield* Deferred.await(started)
        // The reload replaces the entry of the load, which keeps bootstrapping.
        yield* store.reload({ directory: tmp.path }).pipe(Effect.exit, Effect.forkDetach)
        yield* Effect.sleep("50 millis")
        return Option.isSome(yield* close(scope))
      }),
    )

    expect(closed).toBe(true)
    expect(events).toContain("dispose")
    expect(events.lastIndexOf("start")).toBeLessThan(events.lastIndexOf("dispose"))
  } finally {
    off()
  }
}, 20_000)
