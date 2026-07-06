// FORK FEATURE (12) volatile-injection — Hindsight memory plugin.
//
// Two-tier retrieval injection:
//
// Tier-1 (durable): a per-user header fetched once per session and appended to
//   the system prompt as a stable, cacheable-prefix segment. Held constant
//   mid-session (snapshot in `durableCache`) so the cacheable prefix never
//   shifts on every call. Implemented via `experimental.chat.system.transform`
//   because that is the hook that owns the `system` array; `chat.params` has
//   no `system` field. Tier-1 never touches the volatile-part churn, so it
//   does not accumulate N copies and sits in the cacheable prefix.
//
// Tier-2 (volatile): per-turn retrieval injected as a `volatile: true` text
//   part on the active user message via `chat.message`. The `role !== "user"`
//   guard makes injection safe even if `chat.message` fires for assistant
//   messages — context only ever attaches as user-role provided-context,
//   never as a synthetic assistant statement. The part's `messageID` is set to
//   `output.message.id`, which is the active-turn key the generation-time
//   `filterVolatile` predicate uses to decide what survives: the current turn's
//   Tier-2 lives for this turn, prior turns' Tier-2 is stripped.
//
// `retrieve()` runs on the TTFT path — fire it as early as the hook allows
// (the hook itself is the earliest user-message-shaped point in the pipeline).

import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// Per-session Tier-1 header snapshot. Held constant mid-session so the
// cacheable prefix stays byte-identical across calls; refreshed only when a
// new session starts (or the process restarts).
const durableCache = new Map<string, string>()

export interface HindsightPluginOptions {
  // User identity used as the Hindsight `user_id` key.
  userId: string
  // Base URL of the Hindsight HTTP API (e.g. "http://localhost:8080").
  baseUrl: string
  // Optional resolver for the user id when it depends on runtime context.
  // Falls back to the static `userId` when absent.
  resolveUserId?: (input: PluginInput) => string | undefined
}

function userFor(options: HindsightPluginOptions, input: PluginInput): string | undefined {
  return options.resolveUserId?.(input) ?? options.userId
}

function extractText(parts: { type: string; text?: string }[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
}

function renderContext(chunks: { content: string; score?: number }[]): string {
  return chunks
    .map((c, i) => `<hindsight_chunk index="${i}" score="${c.score ?? 0}">\n${c.content}\n</hindsight_chunk>`)
    .join("\n")
}

async function fetchDurable(baseUrl: string, userId: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/durable?user_id=${encodeURIComponent(userId)}`)
    if (!res.ok) return ""
    const text = await res.text()
    return text.trim()
  } catch {
    return ""
  }
}

async function retrieve(
  baseUrl: string,
  args: { user_id: string; session_id: string; turn_id: string; query: string },
): Promise<{ content: string; score?: number }[]> {
  try {
    const res = await fetch(`${baseUrl}/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { chunks?: { content: string; score?: number }[] }
    return data.chunks ?? []
  } catch {
    return []
  }
}

export async function HindsightPlugin(_input: PluginInput, options: HindsightPluginOptions): Promise<Hooks> {
  const userId = userFor(options, _input) ?? options.userId
  const baseUrl = options.baseUrl.replace(/\/$/, "")

  return {
    // Tier-1: append durable header to the system prompt, once per session,
    // byte-identical every call so the cacheable prefix stays stable. The
    // snapshot is held constant mid-session via `durableCache`.
    "experimental.chat.system.transform": async (_input, output) => {
      let header = durableCache.get(_input.sessionID ?? "")
      if (header === undefined) {
        header = await fetchDurable(baseUrl, userId)
        durableCache.set(_input.sessionID ?? "", header)
      }
      if (!header) return
      output.system.push(header)
    },

    // Tier-2: retrieve for THIS turn, inject as a volatile part on the user
    // message. The `role !== "user"` guard makes this safe even if the hook
    // fires for assistant messages — context only ever attaches as
    // user-role provided-context.
    "chat.message": async (input, output) => {
      if (output.message.role !== "user") return
      const query = extractText(output.parts as { type: string; text?: string }[])
      if (!query.trim()) return
      const chunks = await retrieve(baseUrl, {
        user_id: userId,
        session_id: input.sessionID,
        turn_id: output.message.id,
        query,
      })
      if (!chunks.length) return
      output.parts.unshift({
        id: `prt_hindsight-context-${Date.now()}`,
        sessionID: input.sessionID,
        messageID: output.message.id,
        type: "text",
        text: renderContext(chunks),
        synthetic: true,
        volatile: true,
      })
    },
  }
}