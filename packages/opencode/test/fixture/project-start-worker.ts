import { Cause, Effect, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@/project/project"

// One OpenCode process starting in a directory: what every start writes to the
// database shared by the host.
type Msg = {
  file: string
  directory: string
  // Shortens the connection's busy handler so a short hold stands for the five
  // seconds of a starved host. Unset, the product's applies.
  busyTimeout?: number
}

const msg: Msg = JSON.parse(process.argv[2])

const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    if (msg.busyTimeout !== undefined) yield* db.run(`PRAGMA busy_timeout = ${msg.busyTimeout}`)
    const project = yield* Project.Service
    process.stdout.write("starting\n")
    yield* project.fromDirectory(msg.directory)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, CrossSpawnSpawner.node]), [
        [Database.node, Database.layerFromPath(msg.file)],
      ]),
    ),
  ),
)

if (Exit.isFailure(exit)) {
  const error = Cause.squash(exit.cause)
  // The cause first, on one line: it is what a failing run shows.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${Cause.pretty(exit.cause)}`)
  process.exit(1)
}
process.exit(0)
