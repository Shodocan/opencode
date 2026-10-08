import { afterEach, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { spawn, type ChildProcess } from "child_process"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/project-start-worker.ts")

const STARTS = 4
const DEADLINE = 45_000

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

function stop(child: ChildProcess) {
  children.delete(child)
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

afterEach(() => {
  for (const child of children) stop(child)
})

test.skipIf(process.platform === "win32")(
  "processes that start while the database write lock is held all start",
  async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "shared.sqlite")
    // The first start creates the database, alone.
    expect((await start({ file, directory: tmp.path }, tmp.path).finished).code).toBe(0)

    // Another process writes for far longer than a start waits for one
    // statement: every start meets the lock at its project row.
    const other = new BunDatabase(file)
    other.run("BEGIN IMMEDIATE")
    const starts = Array.from({ length: STARTS }, () => start({ file, directory: tmp.path, busyTimeout: 5 }, tmp.path))
    const timer = Promise.withResolvers<"timeout">()
    const timeout = setTimeout(() => timer.resolve("timeout"), DEADLINE)
    const results = await Promise.race([
      (async () => {
        await Promise.all(starts.map((item) => item.starting))
        await Bun.sleep(400)
        other.run("COMMIT")
        return Promise.all(starts.map((item) => item.finished))
      })(),
      timer.promise,
    ]).finally(() => {
      clearTimeout(timeout)
      for (const child of children) stop(child)
    })
    other.close()
    if (results === "timeout") throw new Error(`the starts did not finish within ${DEADLINE}ms`)

    expect(
      results.flatMap((result, index) =>
        result.code === 0 ? [] : [`start ${index}: ${result.stderr.replace(/\s+/g, " ").slice(0, 200)}`],
      ),
    ).toEqual([])
  },
  60_000,
)
