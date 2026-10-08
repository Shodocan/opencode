import { afterEach, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import { Database as BunDatabase } from "bun:sqlite"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

const root = path.join(import.meta.dir, "..")
const worker = path.join(import.meta.dir, "fixture/database-contention-worker.ts")
const holder = path.join(import.meta.dir, "fixture/database-lock-holder.ts")

const WORKERS = 6
const EVENTS = 25
// Far below the time the holder keeps the lock, as is the busy window of a
// retried BEGIN: without the retry a worker that meets the holder fails, as a
// fleet process does after 5s.
const BUSY_TIMEOUT = 5
const DEADLINE = 45_000

const children = new Set<ChildProcess>()

// Each child leads its own process group so nothing outlives the test.
function start(script: string, msg: unknown, dir: string) {
  const child = spawn(process.execPath, [script, JSON.stringify(msg)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_DB: ":memory:",
      XDG_DATA_HOME: dir,
      XDG_CACHE_HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_STATE_HOME: dir,
    },
  })
  children.add(child)
  return child
}

// Kills the process group of the child and waits until the child is gone.
function stop(child: ChildProcess) {
  children.delete(child)
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve()
  const gone = new Promise<void>((resolve) => child.once("close", () => resolve()))
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
  return gone
}

const reap = () => Promise.all(Array.from(children, stop))

// Every wait of these tests has a limit: past it the children are killed and
// the test fails saying what it was waiting for.
async function within<T>(wait: Promise<T>, millis: number, what: string) {
  const timer = Promise.withResolvers<never>()
  const timeout = setTimeout(() => timer.reject(new Error(`${what} did not finish within ${millis}ms`)), millis)
  try {
    return await Promise.race([wait, timer.promise])
  } catch (error) {
    await reap()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function finished(child: ChildProcess) {
  const stderr: Buffer[] = []
  child.stderr?.on("data", (chunk) => stderr.push(chunk))
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal, stderr: Buffer.concat(stderr).toString() })),
  )
}

function held(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve())
    child.once("close", () => reject(new Error("lock holder exited before taking the lock")))
  })
}

// Creates the database in a process that ends before anything else opens the
// file. Closing a connection in this process only takes effect once its cached
// statements are collected, and until then it keeps its share of the file
// locks, which a holder of every lock would wait for.
async function create(file: string, dir: string) {
  const result = await within(
    finished(start(worker, { file, worker: 0, events: 0 }, dir)),
    20_000,
    "the process creating the database",
  )
  if (result.code !== 0) throw new Error(`could not create the database: ${result.stderr.slice(0, 200)}`)
}

afterEach(reap)

test.skipIf(process.platform === "win32")(
  "processes sharing one database file publish every event once under write-lock contention",
  async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "shared.sqlite")
    await create(file, tmp.path)

    const lock = start(holder, { file, cycles: 4, holdMs: 600, gapMs: 30 }, tmp.path)
    const released = finished(lock)
    await within(held(lock), 10_000, "the lock holder taking the lock")
    const workers = Array.from({ length: WORKERS }, (_, index) =>
      finished(start(worker, { file, worker: index, events: EVENTS, busyTimeout: BUSY_TIMEOUT }, tmp.path)),
    )

    const results = await within(Promise.all([released, ...workers]), DEADLINE, "the contention run").finally(reap)

    expect(
      results.flatMap((result, index) =>
        result.code === 0
          ? []
          : [`${index === 0 ? "holder" : `worker ${index - 1}`}: ${result.stderr.replace(/\s+/g, " ").slice(0, 200)}`],
      ),
    ).toEqual([])

    const db = new BunDatabase(file, { readonly: true })
    const rows = db
      .query<
        { id: string; seq: number; data: string },
        []
      >("SELECT id, seq, data FROM event WHERE aggregate_id = 'shared' ORDER BY seq")
      .all()
    const latest = db.query<{ seq: number }, []>("SELECT seq FROM event_sequence WHERE aggregate_id = 'shared'").get()
    db.close()

    const total = WORKERS * EVENTS
    // No gap and no duplicate in the sequence, and no event written twice.
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: total }, (_, index) => index))
    expect(new Set(rows.map((row) => row.id)).size).toBe(total)
    expect(latest?.seq).toBe(total - 1)
    const texts = rows.map((row) => (JSON.parse(row.data) as { text: string }).text)
    expect(texts.toSorted()).toEqual(
      Array.from({ length: WORKERS }, (_, index) => Array.from({ length: EVENTS }, (_, event) => `${index}:${event}`))
        .flat()
        .toSorted(),
    )
    // Each process still sees its own events committed in the order it published them.
    for (const index of Array.from({ length: WORKERS }, (_, index) => index)) {
      expect(texts.filter((text) => text.startsWith(`${index}:`))).toEqual(
        Array.from({ length: EVENTS }, (_, event) => `${index}:${event}`),
      )
    }
  },
  60_000,
)

test.skipIf(process.platform === "win32")(
  "a process that starts while every lock of the file is held waits instead of failing to open it",
  async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "shared.sqlite")
    await create(file, tmp.path)

    // What a checkpoint or a recovery by another process does for a moment. A
    // connection opens without a busy handler, so its first statement failed.
    const lock = start(holder, { file, cycles: 1, holdMs: 400, gapMs: 0, exclusive: true }, tmp.path)
    const released = finished(lock)
    await within(held(lock), 10_000, "the lock holder taking every lock")
    const started = Date.now()
    await within(
      Effect.runPromise(Layer.build(Database.layerFromPath(file)).pipe(Effect.scoped)),
      15_000,
      "opening the database while every lock is held",
    )

    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect((await within(released, 10_000, "the lock holder exiting")).code).toBe(0)
  },
  30_000,
)

test.skipIf(process.platform === "win32")(
  "a process waiting for the write lock exits at once on SIGTERM and leaves nothing half-written",
  async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "shared.sqlite")
    await create(file, tmp.path)

    const lock = start(holder, { file, cycles: 1, holdMs: 20_000, gapMs: 0 }, tmp.path)
    const released = finished(lock)
    await within(held(lock), 10_000, "the lock holder taking the lock")
    const waiting = start(worker, { file, worker: 0, events: EVENTS }, tmp.path)
    const exited = finished(waiting)
    // Long enough for the worker to be in its lock wait, far short of its budget.
    await Bun.sleep(1_500)
    expect(waiting.exitCode).toBeNull()
    const signalled = Date.now()
    waiting.kill("SIGTERM")
    const result = await within(exited, 10_000, "the waiting process exiting on SIGTERM")

    expect(result.signal).toBe("SIGTERM")
    expect(Date.now() - signalled).toBeLessThan(2_000)
    await stop(lock)
    await within(released, 10_000, "the lock holder exiting")
    const db = new BunDatabase(file)
    expect(db.query("SELECT count(*) AS count FROM event WHERE aggregate_id = 'shared'").get()).toEqual({ count: 0 })
    db.run("CREATE TABLE still_writable (value INTEGER)")
    db.close()
  },
  30_000,
)
