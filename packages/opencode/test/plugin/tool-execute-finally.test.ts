import { describe, expect } from "bun:test"
import type { Hooks, TaskOrigin } from "@opencode-ai/plugin"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Plugin } from "@/plugin"
import { TOOL_EXECUTE_FINALLY_ERROR_MESSAGE_MAX, toolExecuteFinally } from "@/plugin/tool-execute-finally"
import { testEffect } from "../lib/effect"

// Compile-time pin of the public hook surface. Both directions of assignability
// must hold once the implementer adds `tool.execute.finally` to Hooks; a
// narrower or wider input, a different outcome union, or a non-empty output
// type breaks one of the two Expect checks below.
type FinallyHookInput = {
  tool: string
  sessionID: string
  callID: string
  args: any
  taskOrigin?: TaskOrigin
  outcome: "success" | "error" | "cancelled"
  error?: { name: string; message: string }
}
type ExpectedFinallyHook = (input: FinallyHookInput, output: {}) => Promise<void>
type ActualFinallyHook = NonNullable<Hooks["tool.execute.finally"]>

type IsAssignable<From, To> = [From] extends [To] ? true : false
type Expect<T extends true> = T
type HookSurfaceForward = Expect<IsAssignable<ActualFinallyHook, ExpectedFinallyHook>>
type HookSurfaceReverse = Expect<IsAssignable<ExpectedFinallyHook, ActualFinallyHook>>

type Event = { name: string; input: any; output: unknown }

function finInput(event: Event) {
  return event.input as {
    tool?: string
    sessionID?: string
    callID?: string
    args?: unknown
    taskOrigin?: unknown
    outcome?: string
    error?: unknown
  }
}

function makePlugin(order: string[] = [], mode: "ok" | "fail" | "die" = "ok") {
  const events: Event[] = []
  const plugin: Plugin.Interface = {
    trigger: ((name: unknown, input: unknown, output: unknown) => {
      events.push({ name: String(name), input, output })
      order.push(String(name))
      if (name === "tool.execute.finally" && mode === "fail") return Effect.fail(new Error("finally hook failed"))
      if (name === "tool.execute.finally" && mode === "die") return Effect.die("finally hook defect")
      return Effect.succeed(output)
    }) as Plugin.Interface["trigger"],
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }
  return { plugin, events }
}

const input = {
  tool: "task",
  sessionID: "ses_test",
  callID: "call_test",
  args: { x: 1 },
}

const it = testEffect(Layer.empty)

describe("toolExecuteFinally", () => {
  it.live("exports the 500 character finally error message limit", () =>
    Effect.succeed(expect(TOOL_EXECUTE_FINALLY_ERROR_MESSAGE_MAX).toBe(500)),
  )

  it.live("fires exactly one finally with outcome success after the body succeeds, returning the body value", () =>
    Effect.gen(function* () {
      const order: string[] = []
      const { plugin, events } = makePlugin(order)
      const body = Effect.sync(() => {
        order.push("body")
        return 42
      })
      const out = yield* (toolExecuteFinally(plugin, input, body) as Effect.Effect<number>)
      order.push("returned")
      expect(out).toBe(42)
      expect(order).toEqual(["body", "tool.execute.finally", "returned"])
      expect(events.map((e) => e.name)).toEqual(["tool.execute.finally"])
      const fin = finInput(events[0])
      expect(fin).toEqual({
        tool: "task",
        sessionID: "ses_test",
        callID: "call_test",
        args: { x: 1 },
        outcome: "success",
      })
      expect(fin.error).toBeUndefined()
    }),
  )

  it.live("maps a typed failure to outcome error with name and message, propagating the original failure unchanged", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin()
      const error = new Error("boom")
      const exit = yield* (toolExecuteFinally(plugin, input, Effect.fail(error)) as Effect.Effect<unknown>).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.squash(exit.cause)).toBe(error)
      expect(events.map((e) => e.name)).toEqual(["tool.execute.finally"])
      const fin = finInput(events[0])
      expect(fin).toEqual({
        tool: "task",
        sessionID: "ses_test",
        callID: "call_test",
        args: { x: 1 },
        outcome: "error",
        error: { name: "Error", message: "boom" },
      })
    }),
  )

  it.live("maps a non-Error defect to outcome error with the fallback name and the raw message", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin()
      const exit = yield* (toolExecuteFinally(plugin, input, Effect.die("raw defect")) as Effect.Effect<unknown>).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.squash(exit.cause)).toBe("raw defect")
      expect(events).toHaveLength(1)
      const fin = finInput(events[0])
      expect(fin.outcome).toBe("error")
      expect(fin.error).toEqual({ name: "Error", message: "raw defect" })
    }),
  )

  it.live("maps an Error defect to outcome error with the error name and message, propagating the defect unchanged", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin()
      const error = new Error("defect boom")
      const exit = yield* (toolExecuteFinally(plugin, input, Effect.die(error)) as Effect.Effect<unknown>).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.squash(exit.cause)).toBe(error)
      expect(events).toHaveLength(1)
      const fin = finInput(events[0])
      expect(fin.outcome).toBe("error")
      expect(fin.error).toEqual({ name: "Error", message: "defect boom" })
    }),
  )

  it.live("reports outcome cancelled without an error key when the failure name is AbortError", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin()
      const error = new DOMException("aborted", "AbortError")
      const exit = yield* (toolExecuteFinally(plugin, input, Effect.fail(error)) as Effect.Effect<unknown>).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.squash(exit.cause)).toBe(error)
      expect(events).toHaveLength(1)
      const fin = finInput(events[0])
      expect(fin.outcome).toBe("cancelled")
      expect(fin.error).toBeUndefined()
    }),
  )

  it.live("reports outcome cancelled without an error key when the input signal is already aborted", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin()
      const controller = new AbortController()
      controller.abort()
      const exit = yield* (toolExecuteFinally(plugin, { ...input, signal: controller.signal }, Effect.fail(new Error("boom"))) as Effect.Effect<unknown>).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(events).toHaveLength(1)
      const fin = finInput(events[0])
      expect(fin.outcome).toBe("cancelled")
      expect(fin.error).toBeUndefined()
    }),
  )

  it.live("reports outcome cancelled without an error key when the body is interrupted, and propagates the interrupt", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin()
      const started = yield* Deferred.make<void>()
      const body = Effect.gen(function* () {
        yield* Deferred.succeed(started, void 0)
        yield* Effect.never
      })
      const fiber = yield* (toolExecuteFinally(plugin, input, body) as Effect.Effect<void>).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(events).toHaveLength(1)
      expect(events[0].name).toBe("tool.execute.finally")
      const fin = finInput(events[0])
      expect(fin.outcome).toBe("cancelled")
      expect(fin.error).toBeUndefined()
    }),
  )

  it.live("a failing finally trigger never changes a successful outcome", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin(undefined, "fail")
      const out = yield* (toolExecuteFinally(plugin, input, Effect.succeed(7)) as Effect.Effect<number>)
      expect(out).toBe(7)
      expect(events).toHaveLength(1)
      expect(finInput(events[0]).outcome).toBe("success")
    }),
  )

  it.live("a defect inside the finally trigger never changes the propagated failure", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin(undefined, "die")
      const error = new Error("boom")
      const exit = yield* (toolExecuteFinally(plugin, input, Effect.fail(error)) as Effect.Effect<unknown>).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.squash(exit.cause)).toBe(error)
      expect(events).toHaveLength(1)
      expect(finInput(events[0]).outcome).toBe("error")
    }),
  )

  it.live("truncates the finally error message to the 500 character limit", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin()
      const long = "x".repeat(700)
      const exit = yield* toolExecuteFinally(plugin, input, Effect.fail(new Error(long))).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(events).toHaveLength(1)
      const fin = finInput(events[0])
      expect(fin.outcome).toBe("error")
      expect(fin.error).toEqual({ name: "Error", message: long.slice(0, 500) })
    }),
  )

  it.live("echoes the task origin into the finally input", () =>
    Effect.gen(function* () {
      const { plugin, events } = makePlugin()
      const taskOrigin: TaskOrigin = { version: 1, parentSessionID: "ses_parent", taskCallID: "call_parent" }
      const out = yield* (toolExecuteFinally(plugin, { ...input, taskOrigin }, Effect.succeed("ok")) as Effect.Effect<string>)
      expect(out).toBe("ok")
      expect(events).toHaveLength(1)
      const fin = finInput(events[0])
      expect(fin.outcome).toBe("success")
      expect(fin.taskOrigin).toEqual(taskOrigin)
    }),
  )
})
