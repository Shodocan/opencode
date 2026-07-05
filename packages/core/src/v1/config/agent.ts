export * as ConfigAgentV1 from "./agent"

import { Schema, SchemaGetter } from "effect"
import { PositiveInt } from "../../schema"
import { ConfigPermissionV1 } from "./permission"

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String).annotate({
      description: "Default model variant for this agent (applies only when using the agent's configured model).",
    }),
    temperature: Schema.optional(Schema.Finite),
    top_p: Schema.optional(Schema.Finite),
    prompt: Schema.optional(Schema.String),
    tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
      description: "@deprecated Use 'permission' field instead",
    }),
    disable: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String).annotate({ description: "Description of when to use the agent" }),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
    }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color).annotate({
      description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
    }),
    steps: Schema.optional(PositiveInt).annotate({
      description: "Maximum number of agentic iterations before forcing text-only response",
    }),
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
    permission: Schema.optional(ConfigPermissionV1.Info),
    // FORK FEATURE (6) fallback-model — legacy/frontmatter agents use this
    // path, so keep fallback out of `options` and preserve it through v1->v2
    // migration and the runtime Agent.Info layer.
    fallback: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
      description: "Ordered fallback model refs to retry when the active model fails with a retriable error.",
    }),
    // FORK FEATURE (9) stop-recovery — per-agent disable-only override for
    // the L1 premature-stop recovery. Inherits the root `stopRecovery` block;
    // `false` disables recovery for this agent. See
    // docs/artifacts/01-07-2026_premature-stop-recovery/spec.md §7.
    stopRecovery: Schema.optional(Schema.Boolean).annotate({
      description: "Disable stop-recovery for this agent (default: inherits root stopRecovery.enabled).",
    }),
    can_spawn_subagents: Schema.optional(Schema.Boolean).annotate({
      description:
        "Allow this subagent to dispatch its own subagents via the task tool (default: false). When true, grants task-tool permission unless `permission.task` is already set (in which case your scoping wins). Primary agents can always spawn; this field is meaningful for `mode: subagent`.",
    }),
    subagents: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
      description:
        "Allow-list of subagent_types this agent may dispatch via the task tool. If set, dispatching a subagent_type not in this list is rejected at runtime. If unset, any known agent is allowed (subject to `can_spawn_subagents` / `permission.task`).",
    }),
    // FORK FEATURE (10) gates — workflow-agnostic dispatch enforcement primitive.
    // Parsed/validated at agent-load time (fail-fast with the agent name); kept
    // out of `options` so it reaches the dispatch path. See
    // packages/opencode/src/agent/gates.ts and FORK_CHANGES.md Feature (10).
    gates: Schema.optional(Schema.Unknown).annotate({
      description:
        "Declarative dispatch gates (requires_artifacts, requires_prior_dispatch, first_dispatch_must_be). Evaluated at task-dispatch time; blocked dispatches return a structured BLOCKED result to the parent. Malformed blocks fail fast at startup.",
    }),
    // FORK FEATURE (11) subagent-model-override — per-agent opt-out. When true,
    // callers cannot override this agent's model or variant via the task tool.
    disableModelOverride: Schema.optional(Schema.Boolean).annotate({
      description: "Block callers from overriding this agent's model or variant via the task tool (default: false).",
    }),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "color",
  "steps",
  "maxSteps",
  "options",
  "permission",
  "fallback",
  "disable",
  "tools",
  "can_spawn_subagents",
  "subagents",
  "stopRecovery",
  "gates",
  "disableModelOverride",
])

const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  const options: Record<string, unknown> = { ...agent.options }
  for (const [key, value] of Object.entries(agent)) {
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }

  const permission: ConfigPermissionV1.Info = {}
  for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
    const action = enabled ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      permission.edit = action
      continue
    }
    permission[tool] = action
  }
  globalThis.Object.assign(permission, agent.permission)

  const steps = agent.steps ?? agent.maxSteps
  return { ...agent, options, permission, ...(steps !== undefined ? { steps } : {}) }
}

export const Info = AgentSchema.pipe(
  Schema.decodeTo(AgentSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "AgentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
