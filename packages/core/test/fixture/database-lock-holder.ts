import { Database } from "bun:sqlite"

// A writer that keeps the write lock for far longer than the workers' busy
// handler waits, the way a starved host does under a resume burst.
type Msg = {
  file: string
  cycles: number
  holdMs: number
  gapMs: number
  // Holds every lock of the file, as a checkpoint or a recovery does for a moment.
  exclusive?: boolean
}

const msg: Msg = JSON.parse(process.argv[2])
const db = new Database(msg.file)
db.run("PRAGMA busy_timeout = 5000")
if (msg.exclusive) db.run("PRAGMA locking_mode = EXCLUSIVE")

for (const cycle of Array.from({ length: msg.cycles }, (_, index) => index)) {
  db.run("BEGIN IMMEDIATE")
  if (cycle === 0) process.stdout.write("held\n")
  await Bun.sleep(msg.holdMs)
  db.run("COMMIT")
  await Bun.sleep(msg.gapMs)
}
db.close()
