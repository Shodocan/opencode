import { describe, expect, it } from "bun:test"
import { HindsightPlugin } from "@/plugin/hindsight"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

const fakeInput = {} as PluginInput

function makeUserMessage(id: string, text: string) {
  return {
    id,
    role: "user" as const,
    sessionID: "sess",
    agent: "build",
    model: { providerID: "p", modelID: "m" },
    time: { created: 0 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("HindsightPlugin", () => {
  it("injects a volatile text part on the active user message via chat.message", async () => {
    const calls: { url: string; method: string; body?: string }[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input?.url ?? input?.toString?.() ?? ""
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body?.toString() })
      if (u.includes("/retrieve")) {
        return new Response(JSON.stringify({ chunks: [{ content: "memory-1", score: 0.9 }] }), {
          status: 200,
        })
      }
      return new Response("", { status: 404 })
    }) as typeof fetch

    try {
      const hooks = await HindsightPlugin(fakeInput, { userId: "user-1", baseUrl: "http://h:8080" })
      const output = {
        message: makeUserMessage("msg-1", "hello"),
        parts: [{ id: "prt_u", sessionID: "sess", messageID: "msg-1", type: "text", text: "hello" }] as any[],
      }
      await (hooks["chat.message"] as any)({ sessionID: "sess" }, output)

      expect(calls.some((c) => c.url.includes("/retrieve"))).toBe(true)
      expect(output.parts.length).toBeGreaterThan(0)
      const injected = output.parts[0]
      expect(injected.volatile).toBe(true)
      expect(injected.messageID).toBe("msg-1")
      expect(injected.type).toBe("text")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("does not inject on non-user messages (role guard)", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch
    try {
      const hooks = await HindsightPlugin(fakeInput, { userId: "user-1", baseUrl: "http://h:8080" })
      const output = { message: { ...makeUserMessage("msg-1", "hello"), role: "assistant" as const }, parts: [] as any[] }
      await (hooks["chat.message"] as any)({ sessionID: "sess" }, output)
      expect(output.parts.length).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("Tier-1 appends the durable header to the system prompt via system.transform, once per session (cached)", async () => {
    let fetchCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => {
      const u = typeof input === "string" ? input : input?.url ?? input?.toString?.() ?? ""
      if (u.includes("/durable")) {
        fetchCount++
        return new Response("DURABLE-HEADER", { status: 200 })
      }
      return new Response("", { status: 404 })
    }) as typeof fetch
    try {
      const hooks = await HindsightPlugin(fakeInput, { userId: "user-1", baseUrl: "http://h:8080" })
      const out1 = { system: [] as string[] }
      const out2 = { system: [] as string[] }
      await (hooks["experimental.chat.system.transform"] as any)({ sessionID: "s1" }, out1)
      await (hooks["experimental.chat.system.transform"] as any)({ sessionID: "s1" }, out2)
      expect(out1.system).toContain("DURABLE-HEADER")
      expect(out2.system).toContain("DURABLE-HEADER")
      // Cached: durable fetched once for the session.
      expect(fetchCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("Tier-1 is a no-op when the durable endpoint returns empty", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch
    try {
      const hooks = await HindsightPlugin(fakeInput, { userId: "user-1", baseUrl: "http://h:8080" })
      const out = { system: [] as string[] }
      await (hooks["experimental.chat.system.transform"] as any)({ sessionID: "s2" }, out)
      expect(out.system.length).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})