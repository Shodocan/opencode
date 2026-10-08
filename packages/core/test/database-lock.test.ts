import { describe, expect, setDefaultTimeout } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { Cause, Effect, Exit, Fiber, Predicate, Schema } from "effect"
import type * as Scope from "effect/Scope"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { Sqlite } from "@opencode-ai/core/database/sqlite"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const Locked = EventV2.define({
  type: "test.locked",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

const BUSY = "database is locked (SQLITE_BUSY) during BEGIN IMMEDIATE"

// No test here waits for a lock longer than 5s (the longest budget below), so
// 10s means a wait that did not end; the runner stops the test at 15s.
setDefaultTimeout(15_000)
const LIMIT = 10_000

// A file database opened by the product layer with a 1ms busy handler, plus a
// second connection that plays another OpenCode process holding the lock.
const contended = <A, E>(
  body: (other: BunDatabase) => Effect.Effect<A, E, Database.Service | EventV2.Service | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const file = path.join(tmp.path, "lock.sqlite")
    return yield* Effect.gen(function* () {
      yield* (yield* Database.Service).db.run("PRAGMA busy_timeout = 1")
      const other = yield* Effect.acquireRelease(
        Effect.sync(() => new BunDatabase(file)),
        (db) => Effect.sync(() => db.close()),
      )
      other.run("CREATE TABLE lock_probe (value INTEGER)")
      return yield* body(other).pipe(
        Effect.timeoutOrElse({
          duration: LIMIT,
          orElse: () =>
            Effect.die(new Error(`not finished after ${LIMIT}ms: a write is still waiting for the database lock`)),
        }),
      )
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [
          [Database.node, Database.layerFromPath(file)],
        ]),
      ),
    )
  })

const retry = { budget: 5_000, outcome: 5_000, abort: 5_000, busy: 1, base: 2, cap: 10 }
const fast = Effect.provideService(Database.LockRetry, retry)
const short = Effect.provideService(Database.LockRetry, { ...retry, budget: 60 })

const releaseAfter = (other: BunDatabase, millis: number) =>
  Effect.sleep(millis).pipe(Effect.andThen(Effect.sync(() => other.run("COMMIT"))), Effect.forkScoped)

const lockShaped = () =>
  new SqlError({
    reason: classifySqliteError(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 }), {
      message: "database is locked (SQLITE_BUSY) during COMMIT",
      operation: "execute",
    }),
  })

// Statements built by drizzle fail wrapped in its query error; transaction control fails bare.
const sqlError = (error: unknown) =>
  Predicate.hasProperty(error, "cause") && Cause.isCause(error.cause) ? Cause.squash(error.cause) : error

const events = (other: BunDatabase) =>
  other.query<{ seq: number }, []>("SELECT seq FROM event WHERE aggregate_id = 'one' ORDER BY seq").all()

describe("sqlite failure text", () => {
  it.live("bun driver keeps the SQLite code, message and statement of a lock failure", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        other.run("BEGIN IMMEDIATE")
        const error = yield* db.transaction(() => Effect.void, { behavior: "immediate" }).pipe(Effect.flip)

        expect(error.message).toBe(BUSY)
        expect(error.reason._tag).toBe("LockTimeoutError")
        expect(error.reason.cause).toMatchObject({ code: "SQLITE_BUSY", message: "database is locked" })
      }),
    ),
  )

  it.live("a deferred transaction that reads then writes fails at once with BUSY_SNAPSHOT", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // No busy handler helps a stale read snapshot: it never gets to wait.
        yield* db.run("PRAGMA busy_timeout = 5000")
        const started = Date.now()
        const error = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.all("SELECT value FROM lock_probe")
              other.run("INSERT INTO lock_probe (value) VALUES (1)")
              yield* tx.run("INSERT INTO lock_probe (value) VALUES (2)")
            }),
          )
          .pipe(Effect.flip, Effect.map(sqlError))

        expect(error).toBeInstanceOf(SqlError)
        expect(error instanceof SqlError && error.reason._tag).toBe("LockTimeoutError")
        expect(error instanceof Error && error.message).toBe("database is locked (SQLITE_BUSY_SNAPSHOT) during INSERT")
        expect(Date.now() - started).toBeLessThan(2_000)
        expect(other.query("SELECT value FROM lock_probe").all()).toEqual([{ value: 1 }])
      }),
    ),
  )

  it.live("node driver error shape is classified and described like the bun one", () =>
    Effect.sync(() => {
      const busy = Sqlite.failure(
        Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
          errstr: "database is locked",
        }),
        "begin immediate",
      )
      expect(busy.reason._tag).toBe("LockTimeoutError")
      expect(busy.message).toBe(BUSY)

      const snapshot = Sqlite.failure(
        Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 517 }),
        "\n  insert into part (id) values (?)",
      )
      expect(snapshot.reason._tag).toBe("LockTimeoutError")
      expect(snapshot.message).toBe("database is locked (SQLITE_BUSY_SNAPSHOT) during INSERT")

      const unique = Sqlite.failure(
        Object.assign(new Error("UNIQUE constraint failed: event.id"), { code: "ERR_SQLITE_ERROR", errcode: 2067 }),
        "insert into event (id) values (?)",
      )
      expect(unique.reason._tag).toBe("UniqueViolation")
      expect(unique.message).toBe("UNIQUE constraint failed: event.id (SQLITE_CONSTRAINT) during INSERT")
    }),
  )

  it.live("a failure without SQLite detail keeps the generic text", () =>
    Effect.sync(() => {
      expect(Sqlite.failure("boom", "select 1").message).toBe("Failed to execute statement during SELECT")
      expect(Sqlite.failure(new Error("no such table: nope"), "select * from nope").message).toBe(
        "no such table: nope during SELECT",
      )
    }),
  )

  it.live(
    "node driver keeps the SQLite code, message and statement of a lock failure",
    () =>
      Effect.gen(function* () {
        const node = Bun.which("node")
        if (!node) return
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const built = yield* Effect.promise(() =>
          Bun.build({
            entrypoints: [path.join(import.meta.dir, "fixture/sqlite-node-busy.ts")],
            outdir: tmp.path,
            target: "node",
            conditions: ["node"],
          }),
        )
        expect(built.success).toBe(true)
        const result = yield* Effect.promise(async () => {
          const proc = Bun.spawn([node, built.outputs[0].path, path.join(tmp.path, "node.sqlite")], {
            stdout: "pipe",
            stderr: "pipe",
            timeout: 30_000,
            killSignal: "SIGKILL",
          })
          const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ])
          return { stdout, stderr, code }
        })
        // node:sqlite needs Node 22.5+; an older runtime cannot load the driver at all.
        if (result.code !== 0 && result.stderr.includes("No such built-in module")) return

        expect(result.stderr).toBe("")
        expect(JSON.parse(result.stdout)).toEqual({ tag: "LockTimeoutError", message: BUSY })
      }),
    60_000,
  )
})

describe("Database.immediate", () => {
  it.live("retries BEGIN IMMEDIATE until another writer releases the lock", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        let runs = 0
        other.run("BEGIN IMMEDIATE")
        yield* releaseAfter(other, 120)
        const result = yield* Database.immediate(db, (tx) =>
          Effect.gen(function* () {
            runs++
            yield* tx.run("INSERT INTO lock_probe (value) VALUES (7)")
            return "written"
          }),
        ).pipe(fast)

        expect(result).toBe("written")
        expect(runs).toBe(1)
        expect(other.query("SELECT value FROM lock_probe").all()).toEqual([{ value: 7 }])
      }),
    ),
  )

  it.live("fails with a typed error once the retry budget is spent, having executed nothing", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        let runs = 0
        other.run("BEGIN IMMEDIATE")
        const error = yield* Database.immediate(db, (tx) =>
          Effect.gen(function* () {
            runs++
            yield* tx.run("INSERT INTO lock_probe (value) VALUES (7)")
          }),
        ).pipe(short, Effect.flip)
        other.run("COMMIT")

        expect(error).toBeInstanceOf(Database.LockedError)
        if (!(error instanceof Database.LockedError)) return
        expect(error._tag).toBe("DatabaseLockedError")
        expect(error.message).toBe(`${BUSY}; gave up waiting for the write lock`)
        expect(error.attempts).toBeGreaterThan(1)
        expect(error.waited).toBeGreaterThanOrEqual(60)
        expect(error.cause).toBeInstanceOf(SqlError)
        expect(runs).toBe(0)
        expect(other.query("SELECT value FROM lock_probe").all()).toEqual([])
      }),
    ),
  )

  it.live("does not retry a lock failure raised after the body started", () =>
    contended(() =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const failure = lockShaped()
        let failed = 0
        const error = yield* Database.immediate(db, (tx) =>
          Effect.gen(function* () {
            yield* tx.run("INSERT INTO lock_probe (value) VALUES (7)")
            failed++
            return yield* Effect.fail(failure)
          }),
        ).pipe(fast, Effect.flip)
        expect(error).toBe(failure)
        expect(failed).toBe(1)

        let died = 0
        const exit = yield* Database.immediate(db, () =>
          Effect.suspend(() => {
            died++
            return Effect.die(failure)
          }),
        ).pipe(fast, Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
        expect(died).toBe(1)
        expect(yield* db.all("SELECT value FROM lock_probe")).toEqual([])
      }),
    ),
  )

  it.live("does not retry a real BUSY_SNAPSHOT raised after the body started", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        let runs = 0
        const error = yield* Database.awaitLock((begun) =>
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* begun
              runs++
              yield* tx.all("SELECT value FROM lock_probe")
              other.run("INSERT INTO lock_probe (value) VALUES (1)")
              yield* tx.run("INSERT INTO lock_probe (value) VALUES (2)")
            }),
          ),
        ).pipe(fast, Effect.flip, Effect.map(sqlError))

        expect(error).toBeInstanceOf(SqlError)
        expect(error instanceof Error && error.message).toBe("database is locked (SQLITE_BUSY_SNAPSHOT) during INSERT")
        expect(runs).toBe(1)
        expect(other.query("SELECT value FROM lock_probe").all()).toEqual([{ value: 1 }])
      }),
    ),
  )

  it.live("fails at once on a failure that is not the lock, with its cause", () =>
    contended(() =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // A full disk: SQLite rolls the transaction back by itself, so the
        // ROLLBACK that follows fails too and must not hide the cause.
        const pages = yield* db.get<{ page_count: number }>("PRAGMA page_count")
        yield* db.run(`PRAGMA max_page_count = ${pages?.page_count}`)
        let runs = 0
        const started = Date.now()
        const full = yield* Database.immediate(db, (tx) =>
          Effect.suspend(() => {
            runs++
            return tx.run("INSERT INTO lock_probe (value) VALUES (zeroblob(4000000))")
          }),
        ).pipe(fast, Effect.flip, Effect.map(sqlError))

        expect(full instanceof Error && full.message).toBe("database or disk is full (SQLITE_FULL) during INSERT")
        expect(runs).toBe(1)

        // Before the transaction began, and still not the lock: no second try either.
        const readonly = new SqlError({
          reason: classifySqliteError(
            Object.assign(new Error("attempt to write a readonly database"), { code: "SQLITE_READONLY", errno: 8 }),
            { message: "attempt to write a readonly database (SQLITE_READONLY) during BEGIN IMMEDIATE" },
          ),
        })
        let attempts = 0
        const error = yield* Database.awaitLock(() =>
          Effect.suspend(() => {
            attempts++
            return Effect.fail(readonly)
          }),
        ).pipe(fast, Effect.flip)
        expect(error).toBe(readonly)
        expect(attempts).toBe(1)
        expect(Date.now() - started).toBeLessThan(1_000)
      }),
    ),
  )

  it.live("blocks the process for no longer than the busy window, and leaves the busy handler as it was", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run("PRAGMA busy_timeout = 4321")
        other.run("BEGIN IMMEDIATE")
        // A timer measures how long the process could not run at all.
        const stall = { last: performance.now(), longest: 0 }
        const probe = setInterval(() => {
          const now = performance.now()
          stall.longest = Math.max(stall.longest, now - stall.last)
          stall.last = now
        }, 5)
        const error = yield* Database.immediate(db, () => Effect.void).pipe(
          Effect.provideService(Database.LockRetry, { ...retry, budget: 600, busy: 40 }),
          Effect.flip,
        )
        clearInterval(probe)
        other.run("COMMIT")

        expect(error).toBeInstanceOf(Database.LockedError)
        expect(error instanceof Database.LockedError && error.attempts).toBeGreaterThan(5)
        expect(stall.longest).toBeLessThan(400)
        expect(yield* db.get("PRAGMA busy_timeout")).toEqual({ timeout: 4321 })
      }),
    ),
  )

  it.live("gives a region of writes one deadline that an inner region cannot extend", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const limits = Effect.provideService(Database.LockRetry, { ...retry, budget: 60, outcome: 5_000, abort: 150 })
        const write = Database.immediate(db, (tx) => tx.run("INSERT INTO lock_probe (value) VALUES (1)"))
        other.run("BEGIN IMMEDIATE")

        // The default budget would give up long before the lock is free.
        yield* releaseAfter(other, 300)
        yield* write.pipe(Database.lockWithin("outcome"), limits)
        expect(other.query("SELECT value FROM lock_probe").all()).toEqual([{ value: 1 }])

        other.run("BEGIN IMMEDIATE")
        const started = Date.now()
        const notices: Array<number | undefined> = []
        const exits = yield* Effect.forEach([1, 2, 3], () =>
          write.pipe(Database.lockWithin("outcome"), Effect.exit),
        ).pipe(
          Database.lockWithin("abort", (notice) => Effect.sync(() => void notices.push(notice.next))),
          limits,
        )
        const elapsed = Date.now() - started
        other.run("COMMIT")

        expect(
          exits.map((exit) => Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Database.LockedError),
        ).toEqual([true, true, true])
        // One deadline for the three writes, not one each, and not the outcome one.
        expect(elapsed).toBeGreaterThanOrEqual(140)
        expect(elapsed).toBeLessThan(450)
        expect(notices.length).toBeGreaterThan(0)
        expect(notices.every((next) => next !== undefined && next <= started + 150 + 50)).toBe(true)
      }),
    ),
  )

  it.live("tells an observer while it waits and once it has the lock", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const notices: Array<"waiting" | "acquired"> = []
        other.run("BEGIN IMMEDIATE")
        yield* releaseAfter(other, 80)
        yield* Database.immediate(db, () => Effect.void).pipe(
          Database.lockWithin("budget", (notice) =>
            Effect.sync(() => void notices.push(notice.next === undefined ? "acquired" : "waiting")),
          ),
          fast,
        )
        expect(notices.at(0)).toBe("waiting")
        expect(notices.at(-1)).toBe("acquired")
        expect(notices.filter((notice) => notice === "acquired")).toHaveLength(1)

        // An uncontended write tells nothing.
        notices.length = 0
        yield* Database.immediate(db, () => Effect.void).pipe(
          Database.lockWithin("budget", () => Effect.sync(() => void notices.push("waiting"))),
          fast,
        )
        expect(notices).toEqual([])
      }),
    ),
  )

  it.live("an observer that fails does not fail the write", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        other.run("BEGIN IMMEDIATE")
        yield* releaseAfter(other, 80)
        yield* Database.immediate(db, (tx) => tx.run("INSERT INTO lock_probe (value) VALUES (7)")).pipe(
          Database.lockWithin("budget", () => Effect.die(new Error("observer broke"))),
          fast,
        )
        expect(other.query("SELECT value FROM lock_probe").all()).toEqual([{ value: 7 }])
      }),
    ),
  )

  it.live("a fiber forked inside a region does not keep the region's deadline or observer", () =>
    contended((other) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const notices: Array<number> = []
        // The region is over long before the fiber it forked writes: with the
        // region's deadline that write would make one try and give up.
        const forked = yield* Database.immediate(db, (tx) => tx.run("INSERT INTO lock_probe (value) VALUES (9)")).pipe(
          Effect.delay(60),
          Effect.forkScoped,
          Database.lockWithin("abort", (notice) => Effect.sync(() => void notices.push(notice.attempts))),
          Effect.provideService(Database.LockRetry, { ...retry, abort: 20 }),
        )
        other.run("BEGIN IMMEDIATE")
        yield* releaseAfter(other, 200)
        yield* Fiber.join(forked)

        expect(other.query("SELECT value FROM lock_probe").all()).toEqual([{ value: 9 }])
        expect(notices).toEqual([])
      }),
    ),
  )
})

describe("EventV2 under write-lock contention", () => {
  it.live("publishes once after waiting for the lock and keeps the sequence dense", () =>
    contended((other) =>
      Effect.gen(function* () {
        const service = yield* EventV2.Service
        other.run("BEGIN IMMEDIATE")
        yield* releaseAfter(other, 120)
        const first = yield* service.publish(Locked, { id: "one", text: "first" }).pipe(fast)
        const second = yield* service.publish(Locked, { id: "one", text: "second" }).pipe(fast)

        expect(first.durable?.seq).toBe(0)
        expect(second.durable?.seq).toBe(1)
        expect(events(other)).toEqual([{ seq: 0 }, { seq: 1 }])
      }),
    ),
  )

  it.live("writes of one process to one aggregate commit in the order they were made", () =>
    contended((other) =>
      Effect.gen(function* () {
        const service = yield* EventV2.Service
        other.run("BEGIN IMMEDIATE")
        yield* releaseAfter(other, 150)
        // Each write is a full snapshot upserted by id (a tool part going from
        // running to completed): an older one committing last would win.
        const writers = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, index) => index),
          (index) =>
            service.publish(Locked, { id: "one", text: String(index) }).pipe(
              fast,
              Effect.forkScoped,
              Effect.tap(() => Effect.sleep(2)),
            ),
        )
        yield* Fiber.joinAll(writers)

        expect(
          other
            .query<{ data: string }, []>("SELECT data FROM event WHERE aggregate_id = 'one' ORDER BY seq")
            .all()
            .map((row) => (JSON.parse(row.data) as { text: string }).text),
        ).toEqual(Array.from({ length: 12 }, (_, index) => String(index)))
      }),
    ),
  )

  it.live("a write queued behind an earlier one of its aggregate gives up at its own deadline", () =>
    contended((other) =>
      Effect.gen(function* () {
        const service = yield* EventV2.Service
        other.run("BEGIN IMMEDIATE")
        const earlier = yield* service.publish(Locked, { id: "one", text: "earlier" }).pipe(fast, Effect.forkScoped)
        yield* Effect.sleep(20)
        const started = Date.now()
        const exit = yield* service.publish(Locked, { id: "one", text: "later" }).pipe(short, Effect.exit)
        // Another aggregate is not held up by that queue: it only waits for the lock itself.
        const apart = yield* service.publish(Locked, { id: "two", text: "apart" }).pipe(short, Effect.exit)
        const elapsed = Date.now() - started
        other.run("COMMIT")
        yield* Fiber.join(earlier)

        const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(defect).toBeInstanceOf(Database.LockedError)
        expect(defect instanceof Error ? defect.message : "").toBe(
          "an earlier write of this process is still waiting for the database; gave up waiting for the write lock",
        )
        const other2 = Exit.isFailure(apart) ? Cause.squash(apart.cause) : undefined
        expect(other2 instanceof Error ? other2.message : "").toBe(`${BUSY}; gave up waiting for the write lock`)
        expect(elapsed).toBeLessThan(1_000)
        expect(events(other)).toEqual([{ seq: 0 }])
      }),
    ),
  )

  it.live("dies with the typed lock error after the budget and writes nothing", () =>
    contended((other) =>
      Effect.gen(function* () {
        const service = yield* EventV2.Service
        other.run("BEGIN IMMEDIATE")
        const exit = yield* service.publish(Locked, { id: "one", text: "lost" }).pipe(short, Effect.exit)
        other.run("COMMIT")

        const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(defect).toBeInstanceOf(Database.LockedError)
        expect(defect instanceof Error ? defect.message : "").toBe(`${BUSY}; gave up waiting for the write lock`)
        expect(events(other)).toEqual([])

        // Nothing was half-written: the next publish takes the first sequence number.
        const next = yield* service.publish(Locked, { id: "one", text: "kept" }).pipe(fast)
        expect(next.durable?.seq).toBe(0)
        expect(events(other)).toEqual([{ seq: 0 }])
      }),
    ),
  )

  it.live("does not retry a lock failure raised inside the transaction body", () =>
    contended((other) =>
      Effect.gen(function* () {
        const service = yield* EventV2.Service
        const failure = lockShaped()
        let commits = 0
        const exit = yield* service
          .publish(
            Locked,
            { id: "one", text: "rolled back" },
            {
              commit: () =>
                Effect.suspend(() => {
                  commits++
                  return Effect.die(failure)
                }),
            },
          )
          .pipe(fast, Effect.exit)

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
        expect(commits).toBe(1)
        expect(events(other)).toEqual([])
      }),
    ),
  )
})
