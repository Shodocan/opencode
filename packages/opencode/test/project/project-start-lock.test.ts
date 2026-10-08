import { afterEach, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { spawn, type ChildProcess } from "child_process"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/project-start-worker.ts")

const STARTS = 4
// The waits below add up to less than the 60s the runner gives the test.
const DEADLINE = 20_000

const children = new Set<ChildProcess>()

// Each child leads its own process group so nothing outlives the test.
function start(msg: unknown, dir: string) {
  const child = spawn(process.execPath, [worker, JSON.stringify(msg)], {
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
  const stderr: Buffer[] = []
  child.stderr?.on("data", (chunk) => stderr.push(chunk))
  return {
    // The process is about to write its project row.
    starting: new Promise<void>((resolve) => {
      child.stdout?.once("data", () => resolve())
      child.once("close", () => resolve())
    }),
    finished: new Promise<{ code: number | null; stderr: string }>((resolve) =>
      child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString() })),
    ),
  }
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

// Every wait has a limit: past it the children are killed and the test fails
// saying what it was waiting for.
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

afterEach(reap)

test.skipIf(process.platform === "win32")(
  "processes that start while the database write lock is held all start",
  async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "shared.sqlite")
    // The first start creates the database, alone.
    const first = await within(start({ file, directory: tmp.path }, tmp.path).finished, 15_000, "the first start")
    expect(first.code).toBe(0)

    // Another process writes for far longer than a start waits for one
    // statement: every start meets the lock at its project row.
    const other = new BunDatabase(file)
    // Closing the connection frees the lock whatever happens below, so no
    // start is left waiting for it.
    const results = await (async () => {
      other.run("BEGIN IMMEDIATE")
      const starts = Array.from({ length: STARTS }, () =>
        start({ file, directory: tmp.path, busyTimeout: 5 }, tmp.path),
      )
      await within(Promise.all(starts.map((item) => item.starting)), 15_000, "the starts reaching their first write")
      await Bun.sleep(400)
      other.run("COMMIT")
      return within(Promise.all(starts.map((item) => item.finished)), DEADLINE, "the starts")
    })().finally(async () => {
      other.close()
      await reap()
    })

    expect(
      results.flatMap((result, index) =>
        result.code === 0 ? [] : [`start ${index}: ${result.stderr.replace(/\s+/g, " ").slice(0, 200)}`],
      ),
    ).toEqual([])
  },
  60_000,
)
