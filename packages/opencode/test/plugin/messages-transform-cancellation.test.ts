import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { createServer } from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Hooks } from "@opencode-ai/plugin"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const name = "experimental.chat.messages.transform"
type Output = Parameters<NonNullable<Hooks[typeof name]>>[1]

// Load a real local plugin. Its only export is the legacy plugin factory;
// fixture-owned callbacks are attached before the loader invokes that factory.
function withHooks<A, E, R>(self: (hooks: Hooks, following: Hooks) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, "plugin.ts")
    const url = pathToFileURL(file).href
    yield* Effect.promise(() =>
      Bun.write(
        file,
        [
          "const hooks = {}; const plugin = async () => hooks; plugin.hooks = hooks; export default plugin",
          "const following = {}; export const next = async () => following; next.hooks = following",
        ].join("\n"),
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(instance.directory, "opencode.json"), JSON.stringify({ plugin: [url] })),
    )
    const mod = yield* Effect.promise(
      () =>
        import(url) as Promise<{
          default: { hooks: Hooks }
          next: { hooks: Hooks }
        }>,
    )
    return yield* self(mod.default.hooks, mod.next.hooks)
  })
}

describe("messages transform cancellation", () => {
  it.instance("supplies a native signal without trusting or changing caller input", () =>
    withHooks((hooks) =>
      Effect.gen(function* () {
        const signals: AbortSignal[] = []
        hooks[name] = async (input) => {
          expect(input.signal).toBeInstanceOf(AbortSignal)
          signals.push(input.signal!)
        }
        const plugin = yield* Plugin.Service
        const caller = new AbortController()
        caller.abort()
        const input = { signal: caller.signal }
        yield* plugin.trigger(name, input, { messages: [] })
        yield* plugin.trigger(name, {}, { messages: [] })
        expect(signals).toHaveLength(2)
        expect(signals[0]).not.toBe(caller.signal)
        expect(signals[0]).not.toBe(signals[1])
        expect(signals.every((signal) => !signal.aborted)).toBe(true)
        expect(input.signal).toBe(caller.signal)
      }),
    ),
  )

  it.instance("keeps legacy hooks and the original output object compatible", () =>
    withHooks((hooks) =>
      Effect.gen(function* () {
        const calls: Output[] = []
        hooks[name] = async (_input, output) => {
          await Promise.resolve()
          calls.push(output)
        }
        const plugin = yield* Plugin.Service
        const output: Output = { messages: [] }
        expect(yield* plugin.trigger(name, {}, output)).toBe(output)
        expect(calls).toEqual([output])
      }),
    ),
  )

  it.instance("preserves synchronous throws and asynchronous rejection as defects", () =>
    withHooks((hooks) =>
      Effect.gen(function* () {
        const error = new Error("fixture hook failure")
        const plugin = yield* Plugin.Service
        for (const sync of [true, false]) {
          hooks[name] = () => {
            if (sync) throw error
            return Promise.reject(error)
          }
          const exit = yield* Effect.exit(plugin.trigger(name, {}, { messages: [] }))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBe(error)
            expect(Exit.hasInterrupts(exit)).toBe(false)
          }
        }
      }),
    ),
  )

  it.instance("aborts a pending HTTP body and joins hook cleanup before stopping", () =>
    withHooks((hooks, following) =>
      Effect.gen(function* () {
        const body = Promise.withResolvers<void>()
        const cleanup = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const settled = Promise.withResolvers<void>()
        const stopped = Promise.withResolvers<void>()
        const socketClosed = Promise.withResolvers<void>()
        const fallback = new AbortController()
        const events: string[] = []
        const messages: Output["messages"] = []
        const output: Output = { messages }
        let signal: AbortSignal | undefined
        let failure: unknown
        const server = createServer((req, res) => {
          req.socket.on("close", () => socketClosed.resolve())
          res.writeHead(200, { "content-type": "text/plain" })
          res.write("pending body")
        })
        yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)))
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("missing owned HTTP listener")
        hooks[name] = async (input, out) => {
          events.push("hook")
          signal = input.signal
          try {
            const response = await fetch(`http://127.0.0.1:${address.port}`, {
              signal: AbortSignal.any([fallback.signal, ...(input.signal ? [input.signal] : [])]),
            })
            body.resolve()
            await response.text()
            out.messages = [...out.messages]
          } catch (error) {
            failure = error
            throw error
          } finally {
            events.push("cleanup")
            cleanup.resolve()
            await release.promise
            events.push("settled")
            settled.resolve()
          }
        }
        following[name] = async () => {
          events.push("following hook")
        }
        const plugin = yield* Plugin.Service
        const fiber = yield* plugin.trigger(name, {}, output).pipe(
          Effect.tap(() => Effect.sync(() => events.push("continuation"))),
          Effect.forkChild,
        )
        try {
          yield* Effect.promise(() => body.promise)
          const interrupt = yield* Fiber.interrupt(fiber).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                events.push("stopped")
                stopped.resolve()
              }),
            ),
            Effect.forkChild,
          )
          const first = yield* Effect.promise(() =>
            Promise.race([cleanup.promise.then(() => "cleanup"), stopped.promise.then(() => "stopped")]),
          )
          expect(first).toBe("cleanup")
          expect(events).toEqual(["hook", "cleanup"])
          expect(signal?.aborted).toBe(true)
          expect(failure).toMatchObject({ name: "AbortError" })
          yield* Effect.promise(() => socketClosed.promise)
          release.resolve()
          yield* Fiber.join(interrupt)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.hasInterrupts(exit)).toBe(true)
          expect(events).toEqual(["hook", "cleanup", "settled", "stopped"])
          expect(output.messages).toEqual([])
          expect(output.messages).toBe(messages)
          yield* Effect.promise(() => Promise.resolve())
          expect(events).toEqual(["hook", "cleanup", "settled", "stopped"])
        } finally {
          fallback.abort()
          release.resolve()
          yield* Effect.promise(() => settled.promise)
          yield* Effect.promise(
            () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
          )
        }
      }),
    ),
  )
})
