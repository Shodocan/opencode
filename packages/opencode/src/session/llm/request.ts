import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"
import z from "zod"

const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
  readonly budgetProjection: BudgetProjection
}

// ---------------------------------------------------------------------------
// Budget projection (QCB T02)
//
// A separate, immutable, data-only view of the prepared request, consumed by
// the late pre-dispatch context-budget estimate. It carries exactly what
// affects the serialized prompt: transformed system text, normalized
// model-visible messages (current user input, tool calls, tool results,
// max-step additions), active tool name/description/JSON schema,
// serialization-affecting provider options, and the output allowance.
//
// Executable tool functions never enter it. Media is sized conservatively
// without dereference: known encoded/byte length plus SHA-256 where derivable
// from in-memory data, or a deterministic envelope overhead for remote URIs.
// Media whose size is not derivable fails closed (UnknownMediaSizeError).
// ---------------------------------------------------------------------------

export class BudgetProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BudgetProjectionError"
  }
}

export class UnknownMediaSizeError extends BudgetProjectionError {
  constructor(message: string) {
    super(message)
    this.name = "UnknownMediaSizeError"
  }
}

export type BudgetMedia = {
  readonly kind: "data" | "uri"
  readonly source: "string" | "data-uri" | "bytes" | "blob" | "uri"
  readonly mediaType: string | null
  readonly filename: string | null
  /** Known encoded/byte length; null when only the envelope overhead applies. */
  readonly length: number | null
  /** SHA-256 hex of the in-memory payload; null when not derivable without dereference. */
  readonly sha256: string | null
  readonly envelopeOverhead: number
}

export type BudgetTool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown> | null
}

export type BudgetProjectionMessage = {
  readonly role: string
  readonly content: unknown
}

export type BudgetProjection = {
  readonly system: string[]
  readonly messages: BudgetProjectionMessage[]
  readonly tools: Record<string, BudgetTool>
  readonly options: Record<string, unknown>
  readonly outputAllowance: number
}

// Deterministic serialization overhead (characters) charged for media that
// cannot be sized without dereference, e.g. remote URIs. Used by the
// four-characters-per-token estimator as a conservative floor.
const MEDIA_ENVELOPE_OVERHEAD = 16_384

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags?.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  const sortedTools = Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b)))

  // Output allowance: normal requests keep the full runtime output allowance;
  // compaction is bounded by min(4_096, route output limit, runtime cap).
  const outputAllowance =
    input.agent.name === "compaction"
      ? Math.min(4_096, input.model.limit.output, input.flags?.outputTokenMax ?? Number.MAX_SAFE_INTEGER)
      : ProviderTransform.maxOutputTokens(input.model, input.flags?.outputTokenMax)

  const budgetProjection = yield* Effect.tryPromise({
    try: () =>
      buildBudgetProjection({
        system,
        messages,
        tools: sortedTools,
        options: params.options,
        outputAllowance,
      }),
    catch: (cause) =>
      cause instanceof UnknownMediaSizeError
        ? cause
        : new BudgetProjectionError(
            `budget projection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
  })

  return {
    system,
    messages,
    tools: sortedTools,
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags?.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            "User-Agent": USER_AGENT,
          }),
      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
      ...input.model.headers,
      ...headers,
    },
    budgetProjection,
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isMediaPart(part: unknown): part is Record<string, any> {
  if (typeof part !== "object" || part === null) return false
  const candidate = part as Record<string, any>
  return candidate.type === "file" || (typeof candidate.mediaType === "string" && candidate.data != null)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isUrlString(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("http://") || value.startsWith("https://")
}

function projectTool(name: string, tool: Tool): BudgetTool {
  const description = typeof tool.description === "string" ? tool.description : ""
  const inputSchema = tool.inputSchema
  let schema: Record<string, unknown> | null = null
  if (inputSchema !== undefined && inputSchema !== null) {
    const converted = isZodType(inputSchema)
      ? z.toJSONSchema(inputSchema, { io: "input", unrepresentable: "any" })
      : inputSchema
    const data = toData(converted)
    schema = isPlainRecord(data) ? data : {}
  }
  return { name, description, inputSchema: schema }
}

async function projectMedia(part: Record<string, any>): Promise<BudgetMedia> {
  const mediaType = typeof part.mediaType === "string" ? part.mediaType : null
  const filename = typeof part.filename === "string" ? part.filename : null
  const label = `${mediaType ?? "media"}${filename ? ` (${filename})` : ""}`
  const data = part.data
  const uri = data instanceof URL ? data.href : typeof data === "string" && isUrlString(data) ? data : undefined
  if (uri !== undefined) {
    const scheme = new URL(uri).protocol.replace(/:$/, "")
    if (scheme === "data") {
      // Inline encoded payload: size and digest are derivable without I/O.
      const payload = uri.slice(uri.indexOf(",") + 1)
      return {
        kind: "data",
        source: "data-uri",
        mediaType,
        filename,
        length: payload.length,
        sha256: await sha256Hex(payload),
        envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
      }
    }
    if (scheme === "http" || scheme === "https") {
      // Remote media is accounted without dereference: source kind plus the
      // deterministic envelope overhead only.
      return {
        kind: "uri",
        source: "uri",
        mediaType,
        filename,
        length: null,
        sha256: null,
        envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
      }
    }
    // file://, blob://, etc. have no derivable size without dereference.
    throw new UnknownMediaSizeError(`cannot derive size of ${scheme}:// media ${label}; failing closed`)
  }
  if (typeof data === "string") {
    return {
      kind: "data",
      source: "string",
      mediaType,
      filename,
      length: data.length,
      sha256: await sha256Hex(data),
      envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
    }
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    // Blob size is known without reading the stream, so no digest is taken.
    return {
      kind: "data",
      source: "blob",
      mediaType,
      filename,
      length: data.size,
      sha256: null,
      envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
    }
  }
  if (data instanceof ArrayBuffer) {
    return {
      kind: "data",
      source: "bytes",
      mediaType,
      filename,
      length: data.byteLength,
      sha256: await sha256Hex(new Uint8Array(data)),
      envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
    }
  }
  if (ArrayBuffer.isView(data)) {
    return {
      kind: "data",
      source: "bytes",
      mediaType,
      filename,
      length: data.byteLength,
      sha256: await sha256Hex(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
      envelopeOverhead: MEDIA_ENVELOPE_OVERHEAD,
    }
  }
  throw new UnknownMediaSizeError(`cannot derive size of media handle ${label}; failing closed`)
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function toData(value: unknown): unknown {
  if (value === null) return null
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      return Number.isFinite(value) ? value : null
    case "undefined":
    case "function":
      return null
  }
  if (Array.isArray(value)) return value.map((item) => toData(item))
  if (value instanceof URL) return value.href
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function") continue
      out[key] = toData(item)
    }
    return out
  }
  return null
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeDeep(item)
    Object.freeze(value)
  }
  return value
}

async function buildBudgetProjection(input: {
  system: string[]
  messages: ModelMessage[]
  tools: Record<string, Tool>
  options: Record<string, any>
  outputAllowance: number
}): Promise<BudgetProjection> {
  const messages: BudgetProjectionMessage[] = []
  for (const message of input.messages) {
    const candidate = message as { role?: unknown; content?: unknown } | string
    const role = typeof candidate === "object" && typeof candidate.role === "string" ? candidate.role : "unknown"
    const content = typeof candidate === "object" ? candidate.content : candidate
    if (typeof content === "string") {
      messages.push({ role, content })
      continue
    }
    const parts: unknown[] = []
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") {
          parts.push(part)
          continue
        }
        // Media is sized conservatively without dereference; everything else
        // is deep-copied to plain data with functions dropped.
        parts.push(isMediaPart(part) ? await projectMedia(part) : toData(part))
      }
    } else {
      parts.push(toData(content))
    }
    messages.push({ role, content: parts })
  }

  const tools: Record<string, BudgetTool> = {}
  for (const [name, tool] of Object.entries(input.tools)) tools[name] = projectTool(name, tool)

  const options = toData(input.options)
  return freezeDeep({
    // System entries are strings by contract; non-strings cannot contribute
    // text to the estimate and are dropped.
    system: input.system.filter((entry): entry is string => typeof entry === "string"),
    messages,
    tools,
    options: isPlainRecord(options) ? options : {},
    outputAllowance: input.outputAllowance,
  })
}

export * as LLMRequestPrep from "./request"
