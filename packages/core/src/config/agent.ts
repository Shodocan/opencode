export * as ConfigAgent from "./agent"

import { Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { ConfigProvider } from "./provider"
import { PositiveInt } from "../schema"

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export class Info extends Schema.Class<Info>("ConfigV2.Agent")({
  model: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  // FORK FEATURE (6) fallback-model — ordered chain of model strings
  // ("provider/model") to retry the turn on when the active model fails with a
  // retriable error (rate-limit / 5xx / overload) or a context-overflow that
  // survives compaction. See FORK_CHANGES.md.
  fallback: Schema.mutable(Schema.Array(Schema.String)).pipe(Schema.optional),
  // FORK FEATURE (9) stop-recovery — per-agent disable-only override.
  stopRecovery: Schema.Boolean.pipe(Schema.optional),
  request: ConfigProvider.Request.pipe(Schema.optional),
  system: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(Schema.optional),
  hidden: Schema.Boolean.pipe(Schema.optional),
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  permissions: Permission.Ruleset.pipe(Schema.optional),
}) {}
