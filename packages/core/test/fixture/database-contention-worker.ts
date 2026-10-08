import { Cause, Effect, Exit, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"

// One OpenCode process of a host: its own single connection to the shared
// database file, publishing durable events to one aggregate.
type Msg = {
  file: string
  worker: number
  events: number
  // Shortens the connection's busy handler so a few processes reproduce what
  // tens of them do against five seconds. Unset, the product's applies.
  busyTimeout?: number
  // Overrides of the product's lock wait and a pause between two publishes, for measurements.
  retry?: { budget?: number; busy?: number; base?: number; cap?: number }
  pause?: number
}

const msg: Msg = JSON.parse(process.argv[2])

const Contended = EventV2.define({
  type: "test.contended",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

// Longest time the event loop could not run: what a frozen process looks like.
const stall = { last: performance.now(), longest: 0, slowest: 0 }
const probe = setInterval(() => {
  const now = performance.now()
  stall.longest = Math.max(stall.longest, now - stall.last - 5)
  stall.last = now
}, 5)

const started = performance.now()
const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    if (msg.busyTimeout !== undefined) yield* db.run(`PRAGMA busy_timeout = ${msg.busyTimeout}`)
    const events = yield* EventV2.Service
    const retry = { ...(yield* Database.LockRetry), ...msg.retry }
    yield* Effect.forEach(
      Array.from({ length: msg.events }, (_, index) => index),
      (index) =>
        Effect.suspend(() => {
          const began = performance.now()
          return events.publish(Contended, { id: "shared", text: `${msg.worker}:${index}` }).pipe(
            Effect.tap(() => Effect.sync(() => (stall.slowest = Math.max(stall.slowest, performance.now() - began)))),
            Effect.andThen(msg.pause === undefined ? Effect.void : Effect.sleep(msg.pause)),
          )
        }),
      { discard: true },
    ).pipe(Effect.provideService(Database.LockRetry, retry))
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [
        [Database.node, Database.layerFromPath(msg.file)],
      ]),
    ),
  ),
)
clearInterval(probe)

if (Exit.isFailure(exit)) {
  const error = Cause.squash(exit.cause)
  // The cause first, on one line: it is what a failing run shows.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${Cause.pretty(exit.cause)}`)
  process.exit(1)
}
process.stdout.write(
  JSON.stringify({
    ms: Math.round(performance.now() - started),
    stall: Math.round(stall.longest),
    slowest: Math.round(stall.slowest),
  }),
)
