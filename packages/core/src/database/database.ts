export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Sqlite } from "./sqlite"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Random, Schema, Semaphore } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>
type Transaction = Parameters<Parameters<DatabaseShape["transaction"]>[0]>[0]

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run(`PRAGMA busy_timeout = ${Sqlite.BUSY_TIMEOUT}`)
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

/**
 * How a write waits for the SQLite write lock, in milliseconds. Every process
 * of a host shares one database file and the busy handler polls it without a
 * queue, so a burst of writers starves some of them past `busy_timeout`.
 *
 * - `budget`: how long a write keeps trying before it fails. Rides out a burst
 *   of about a minute.
 * - `outcome`: the same for a write that records work already done and kept
 *   nowhere else (`lockWithin("outcome")`). Several bursts in a row; past it
 *   the database is not coming back on its own.
 * - `abort`: the same for the writes of an aborted or failed turn
 *   (`lockWithin("abort")`), so stopping stays as quick as it was.
 * - `busy`: the busy handler of one `BEGIN IMMEDIATE`. The handler sleeps
 *   inside a synchronous call, freezing the whole process, so it is kept short
 *   and the rest of the wait is spent in `base`..`cap` jittered pauses during
 *   which the process runs.
 */
export const LockRetry = Context.Reference<{
  readonly budget: number
  readonly outcome: number
  readonly abort: number
  readonly busy: number
  readonly base: number
  readonly cap: number
}>("@opencode/v2/storage/DatabaseLockRetry", {
  defaultValue: () => ({ budget: 60_000, outcome: 300_000, abort: 5_000, busy: 250, base: 25, cap: 250 }),
})

/**
 * Told while a write waits for the lock, about once a second (`next` is when
 * it tries again), and once more when it has the lock after all.
 */
export type LockNotice = (notice: {
  readonly attempts: number
  readonly waited: number
  readonly next?: number
}) => Effect.Effect<void>

// The time by which the writes of a region must have the lock. Both references
// name the fiber that set them: a fiber forked inside inherits the context,
// outlives the region and must not keep its deadline or pass for nested.
const LockRegion = Context.Reference<
  { readonly fiber: number; readonly deadline: number; readonly notice?: LockNotice } | undefined
>("@opencode/v2/storage/DatabaseLockRegion", { defaultValue: () => undefined })

// The fiber that is inside a write transaction: a nested write joins it.
const Writing = Context.Reference<number | undefined>("@opencode/v2/storage/DatabaseWriting", {
  defaultValue: () => undefined,
})

/**
 * Gives every write of `effect` one shared deadline for the lock instead of
 * the default budget each. A region inside another can only shorten it.
 */
export const lockWithin =
  (kind: "budget" | "outcome" | "abort", notice?: LockNotice) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withFiber((fiber) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + (yield* LockRetry)[kind]
        const outer = yield* LockRegion
        const inherited = outer?.fiber === fiber.id ? outer : undefined
        return yield* effect.pipe(
          Effect.provideService(LockRegion, {
            fiber: fiber.id,
            deadline: inherited ? Math.min(inherited.deadline, deadline) : deadline,
            notice: notice ?? inherited?.notice,
          }),
        )
      }),
    )

/**
 * The write lock was not taken in time. No statement of the transaction ran,
 * so nothing was written and the same write can be made again.
 */
export class LockedError extends Schema.TaggedErrorClass<LockedError>()("DatabaseLockedError", {
  message: Schema.String,
  attempts: Schema.Number,
  waited: Schema.Number,
  cause: Schema.optional(Schema.Defect()),
}) {}

const GAVE_UP = "gave up waiting for the write lock"

// Writers of this process waiting for the lock, by `order` key.
const writers = new Map<string, { readonly turn: Semaphore.Semaphore; users: number }>()

/**
 * Runs a write transaction, starting it again while it cannot take the write
 * lock. `attempt` must run `begun` as the first step of the transaction body:
 * a lock failure before that point came from `BEGIN`, which executed nothing,
 * so starting again cannot write anything twice. A failure after that point is
 * returned as it is and never retried, whatever it is.
 *
 * The connection is free between two attempts, so a later write of the process
 * could otherwise commit before an earlier one that is still waiting. Writes
 * with the same `order` key take the lock in the order they were made.
 */
export function awaitLock<A, E, R>(
  attempt: (begun: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  order?: string,
): Effect.Effect<A, E | LockedError, R> {
  return Effect.withFiber((fiber) =>
    Effect.gen(function* () {
      if ((yield* Writing) === fiber.id) return yield* attempt(Effect.void)
      const retry = yield* LockRetry
      const outer = yield* LockRegion
      const region = outer?.fiber === fiber.id ? outer : undefined
      const notice = region?.notice
      const since = yield* Clock.currentTimeMillis
      const deadline = region?.deadline ?? since + retry.budget

      const gaveUp = (attempts: number, waited: number, cause?: SqlError) =>
        Effect.logError("database write lock not acquired", { attempts, waited, error: cause?.message }).pipe(
          Effect.andThen(
            Effect.fail(
              new LockedError({
                message: `${cause?.message ?? "an earlier write of this process is still waiting for the database"}; ${GAVE_UP}`,
                attempts,
                waited,
                cause,
              }),
            ),
          ),
        )

      const told = { at: 0, logged: false }
      // The observer only watches: whatever it does, the write goes on.
      const tell = (value: Parameters<LockNotice>[0]) =>
        notice === undefined
          ? Effect.void
          : notice(value).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("database write lock observer failed", { cause }),
              ),
            )
      const run = (attempts: number): Effect.Effect<A, E | LockedError, R> =>
        Effect.gen(function* () {
          const body = { begun: false }
          const left = deadline - (yield* Clock.currentTimeMillis)
          const exit = yield* attempt(Effect.sync(() => void (body.begun = true))).pipe(
            // Past the deadline one try is still made, without waiting: a free lock costs nothing.
            Effect.provideService(Sqlite.BeginBusyTimeout, Math.max(0, Math.min(retry.busy, left))),
            Effect.provideService(Writing, fiber.id),
            Effect.exit,
          )
          const now = yield* Clock.currentTimeMillis
          if (Exit.isSuccess(exit)) {
            if (attempts === 1) return exit.value
            yield* Effect.logWarning("database write lock contended", { attempts, waited: now - since })
            if (told.at > 0) yield* tell({ attempts, waited: now - since })
            return exit.value
          }
          const locked = body.begun ? undefined : lockFailure(exit.cause)
          if (!locked) return yield* Effect.failCause(exit.cause)
          if (now >= deadline) return yield* gaveUp(attempts, now - since, locked)
          // Jitter spreads the writers that woke together.
          const pause = Math.min(retry.cap, retry.base * 2 ** (attempts - 1))
          const next = Math.min(deadline, now + pause / 2 + ((yield* Random.next) * pause) / 2)
          // Said once: a process that waits is otherwise silent until it gets through or gives up.
          if (!told.logged && now - since >= 1_000) {
            told.logged = true
            yield* Effect.logWarning("database write lock busy, still waiting", { attempts, waited: now - since })
          }
          if (notice && now - told.at >= 1_000) {
            told.at = now
            yield* tell({ attempts, waited: now - since, next })
          }
          yield* Effect.sleep(next - now)
          return yield* run(attempts + 1)
        })

      if (order === undefined) return yield* run(1)
      const entry = writers.get(order) ?? { turn: Semaphore.makeUnsafe(1), users: 0 }
      return yield* Effect.uninterruptibleMask((restore) => {
        writers.set(order, entry)
        entry.users++
        // The turn can be granted in the instant its wait times out: it is
        // given back whenever it was taken, whatever the wait reported.
        const turn = { taken: false }
        // Waiting for the turn counts against the same deadline as waiting for the lock.
        return restore(
          Effect.uninterruptibleMask((allow) =>
            Effect.andThen(
              allow(entry.turn.take(1)),
              Effect.sync(() => void (turn.taken = true)),
            ),
          ),
        ).pipe(
          Effect.timeoutOption(Math.max(1, deadline - since)),
          Effect.flatMap((taken) =>
            Option.isSome(taken)
              ? restore(run(1))
              : Effect.flatMap(Clock.currentTimeMillis, (now) => gaveUp(0, now - since)),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              if (--entry.users === 0) writers.delete(order)
              return turn.taken ? entry.turn.release(1) : Effect.void
            }),
          ),
        )
      })
    }),
  )
}

/** A transaction that takes the write lock at its start and waits for it. */
export function immediate<A, E, R>(
  db: DatabaseShape,
  body: (tx: Transaction) => Effect.Effect<A, E, R>,
  order?: string,
) {
  return awaitLock(
    (begun) =>
      db.transaction(
        (tx) =>
          Effect.andThen(
            begun,
            Effect.suspend(() => body(tx)),
          ),
        { behavior: "immediate" },
      ),
    order,
  )
}

function lockFailure(cause: Cause.Cause<unknown>) {
  if (Cause.hasInterrupts(cause)) return undefined
  const error = Cause.squash(cause)
  return error instanceof SqlError && error.reason._tag === "LockTimeoutError" ? error : undefined
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
