import { describe, expect, test } from "bun:test"
import { CodeModeTool } from "@/tool/code-mode"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"

// Self-contained copy of the code-mode test harness (test/tool/code-mode.test.ts)
// so the tool.execute.finally site tests do not depend on that file's imports.

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_code-mode"),
  messageID: MessageID.make("msg_code-mode"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_code_mode",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function mcpTool(
  name: string,
  handler: (args: Record<string, unknown>) => unknown,
  inputSchema: Record<string, unknown> = { type: "object", properties: {} },
  outputSchema?: Record<string, unknown>,
): MCP.McpTool {
  return {
    def: { name, description: name, inputSchema, ...(outputSchema ? { outputSchema } : {}) } as MCPToolDef,
    client: {
      callTool: async (params: { arguments?: Record<string, unknown> }) => handler(params.arguments ?? {}),
    } as unknown as MCP.McpTool["client"],
  }
}

function harness(input: {
  mcpTools: Record<string, MCP.McpTool>
  servers: string[]
  permission?: PermissionV1.Rule[]
  trigger?: Plugin.Interface["trigger"]
}) {
  return Layer.mergeAll(
    Layer.mock(Plugin.Service, {
      trigger: input.trigger ?? (((_name, _input, output) => Effect.succeed(output)) as Plugin.Interface["trigger"]),
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", permission: input.permission ?? [] } as any),
    }),
    Layer.mock(Session.Service, {
      get: () => Effect.succeed({ permission: [] } as any),
    }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.succeed(input.mcpTools),
      clients: () => Effect.succeed(Object.fromEntries(input.servers.map((name) => [name, {} as any]))),
    }),
  )
}

function serverNames(mcpTools: Record<string, MCP.McpTool>, servers?: string[]) {
  return servers ?? [...new Set(Object.keys(mcpTools).map((key) => key.split("_")[0]!))]
}

function build(
  mcpTools: Record<string, MCP.McpTool>,
  servers?: string[],
  permission?: PermissionV1.Rule[],
  trigger?: Plugin.Interface["trigger"],
) {
  const names = serverNames(mcpTools, servers)
  return Effect.runPromise(
    CodeModeTool.pipe(
      Effect.flatMap(Tool.init),
      Effect.provide(harness({ mcpTools, servers: names, permission, trigger })),
    ),
  )
}

type Event = { name: string; input: any; output: unknown }

function recordingTrigger(events: Event[], dieOnBefore?: string) {
  return ((name: unknown, input: any, output: unknown) => {
    events.push({ name: name as string, input, output })
    if (dieOnBefore !== undefined && name === "tool.execute.before" && input.tool === dieOnBefore)
      return Effect.die(new Error("hook exploded"))
    return Effect.succeed(output)
  }) as Plugin.Interface["trigger"]
}

async function until(predicate: () => boolean, what: string) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("code mode tool.execute.finally", () => {
  test("a successful child call fires before, after, then exactly one finally with the success outcome", async () => {
    const events: Event[] = []
    const tool = await build(
      { a_tool: mcpTool("a", () => ({ content: [{ type: "text", text: "one" }] })) },
      undefined,
      undefined,
      recordingTrigger(events),
    )
    const out = await Effect.runPromise(tool.execute({ code: 'await tools.a.tool({ x: 1 }); return "done"' }, ctx))
    expect(out.output).toBe("done")
    expect(events.map((e) => [e.name, e.input.tool, e.input.callID])).toEqual([
      ["tool.execute.before", "a_tool", "call_code_mode/1"],
      ["tool.execute.after", "a_tool", "call_code_mode/1"],
      ["tool.execute.finally", "a_tool", "call_code_mode/1"],
    ])
    const fin = events[2].input
    expect(fin.sessionID).toBe(ctx.sessionID)
    expect(fin.args).toEqual({ x: 1 })
    expect(fin.outcome).toBe("success")
    expect(fin.error).toBeUndefined()
    expect(fin.taskOrigin).toBeUndefined()
  })

  test("a successful child call echoes the context task origin into the finally input", async () => {
    const events: Event[] = []
    const taskOrigin: Tool.TaskOrigin = { version: 1 as const, parentSessionID: SessionID.make("ses_parent"), taskCallID: "call_parent" }
    const originCtx: Tool.Context = { ...ctx, taskOrigin }
    const tool = await build(
      { a_tool: mcpTool("a", () => ({ content: [{ type: "text", text: "one" }] })) },
      undefined,
      undefined,
      recordingTrigger(events),
    )
    const out = await Effect.runPromise(tool.execute({ code: 'await tools.a.tool({ x: 1 }); return "done"' }, originCtx))
    expect(out.output).toBe("done")
    const finallyEvents = events.filter((e) => e.name === "tool.execute.finally")
    expect(finallyEvents).toHaveLength(1)
    expect(finallyEvents[0].input.outcome).toBe("success")
    expect(finallyEvents[0].input.taskOrigin).toEqual(taskOrigin)
  })

  test("a rejected MCP client keeps the in-program error behavior and fires finally with the error details", async () => {
    const events: Event[] = []
    const tool = await build(
      { a_tool: mcpTool("a", async () => { throw new Error("mcp boom") }) },
      undefined,
      undefined,
      recordingTrigger(events),
    )
    const out = await Effect.runPromise(
      tool.execute({ code: "try { await tools.a.tool({ x: 1 }) } catch (e) { return 'caught: ' + e.message }" }, ctx),
    )
    expect(out.output).toBe("caught: mcp boom")
    expect(out.metadata.toolCalls).toEqual([{ tool: "a.tool", status: "error", input: { x: 1 } }])
    expect(events.map((e) => e.name)).toEqual(["tool.execute.before", "tool.execute.finally"])
    const fin = events[1].input
    expect(fin.callID).toBe("call_code_mode/1")
    expect(fin.outcome).toBe("error")
    expect(fin.error).toEqual({ name: "Error", message: "mcp boom" })
    expect(fin.args).toEqual({ x: 1 })
  })

  test("a non-Error client rejection reports the fallback error name and the raw message in finally", async () => {
    const events: Event[] = []
    const tool = await build(
      { a_tool: mcpTool("a", async () => { throw "raw defect" }) },
      undefined,
      undefined,
      recordingTrigger(events),
    )
    const out = await Effect.runPromise(
      tool.execute({ code: "try { await tools.a.tool({ x: 1 }) } catch (e) { return 'caught: ' + e.message }" }, ctx),
    )
    expect(out.output).toBe("caught: raw defect")
    const finallyEvents = events.filter((e) => e.name === "tool.execute.finally")
    expect(finallyEvents).toHaveLength(1)
    expect(finallyEvents[0].input.outcome).toBe("error")
    expect(finallyEvents[0].input.error).toEqual({ name: "Error", message: "raw defect" })
  })

  test("a dying before hook fires no after and no finally and never calls the MCP handler", async () => {
    const events: Event[] = []
    const called: string[] = []
    const tool = await build(
      {
        a_tool: mcpTool("a", () => {
          called.push("a")
          return { content: [{ type: "text", text: "ok" }] }
        }),
      },
      undefined,
      undefined,
      recordingTrigger(events, "a_tool"),
    )
    const out = await Effect.runPromise(
      tool.execute({ code: "try { await tools.a.tool({ x: 1 }) } catch (e) { return 'caught: ' + e.message }" }, ctx),
    )
    expect(out.output).toBe("caught: hook exploded")
    expect(called).toEqual([])
    expect(events.map((e) => e.name)).toEqual(["tool.execute.before"])
  })

  test("an aborted child call fires exactly one cancelled finally and no after", async () => {
    const events: Event[] = []
    const controller = new AbortController()
    const abortCtx: Tool.Context = { ...ctx, abort: controller.signal }
    const tool = await build(
      {
        a_tool: mcpTool(
          "a",
          () =>
            new Promise((_resolve, reject) => {
              controller.signal.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true },
              )
            }),
        ),
      },
      undefined,
      undefined,
      recordingTrigger(events),
    )
    const running = Effect.runPromise(tool.execute({ code: "await tools.a.tool({ x: 1 })" }, abortCtx))
    await until(() => events.some((e) => e.name === "tool.execute.before"), "the before hook")
    controller.abort()
    const out = await running
    expect(out.output).toBe("Execution cancelled.")
    expect(out.metadata.error).toBe(true)
    expect(events.filter((e) => e.name === "tool.execute.after")).toHaveLength(0)
    const finallyEvents = events.filter((e) => e.name === "tool.execute.finally")
    expect(finallyEvents).toHaveLength(1)
    expect(finallyEvents[0].input.outcome).toBe("cancelled")
    expect(finallyEvents[0].input.error).toBeUndefined()
  })

  test("an interrupted child call fires exactly one cancelled finally and propagates the interrupt", async () => {
    const events: Event[] = []
    const tool = await build(
      { a_tool: mcpTool("a", () => new Promise(() => {})) },
      undefined,
      undefined,
      recordingTrigger(events),
    )
    const fiber = await Effect.runFork(tool.execute({ code: "await tools.a.tool({})" }, ctx))
    await until(() => events.some((e) => e.name === "tool.execute.before"), "the before hook")
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(events.filter((e) => e.name === "tool.execute.after")).toHaveLength(0)
    const finallyEvents = events.filter((e) => e.name === "tool.execute.finally")
    expect(finallyEvents).toHaveLength(1)
    expect(finallyEvents[0].input.outcome).toBe("cancelled")
    expect(finallyEvents[0].input.error).toBeUndefined()
  })

  test("a long client error message is truncated to 500 characters in the finally payload", async () => {
    const events: Event[] = []
    const long = "x".repeat(700)
    const tool = await build(
      { a_tool: mcpTool("a", async () => { throw new Error(long) }) },
      undefined,
      undefined,
      recordingTrigger(events),
    )
    const out = await Effect.runPromise(
      tool.execute({ code: "try { await tools.a.tool({ x: 1 }) } catch (e) { return 'caught: ' + e.message }" }, ctx),
    )
    expect(out.output).toBe("caught: " + long)
    const finallyEvents = events.filter((e) => e.name === "tool.execute.finally")
    expect(finallyEvents).toHaveLength(1)
    expect(finallyEvents[0].input.outcome).toBe("error")
    expect(finallyEvents[0].input.error.message).toHaveLength(500)
    expect(finallyEvents[0].input.error.message).toBe(long.slice(0, 500))
  })
})
