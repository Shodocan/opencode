import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../../src/database/sqlite.node"

// Bundled for Node by database-lock.test.ts: the node driver cannot load under Bun.
const file = process.argv[2]

const error = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql.unsafe("PRAGMA busy_timeout = 1")
    const other = new DatabaseSync(file)
    other.exec("BEGIN IMMEDIATE")
    const error = yield* sql.unsafe("begin immediate").pipe(Effect.flip)
    other.exec("ROLLBACK")
    other.close()
    return error
  }).pipe(Effect.provide(layer({ filename: file }))),
)

process.stdout.write(JSON.stringify({ tag: error.reason._tag, message: error.message }))
