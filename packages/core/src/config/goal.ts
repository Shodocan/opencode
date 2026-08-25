export * as ConfigGoal from "./goal"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

// FORK FEATURE (13) autonomy-stack — v2 config blocks for the L4 goal and the
// L3 ralph loop. Default disabled; zero behavior change when absent.
//
// Deliberately NOT gated on `stopRecovery.enabled` (D-13): these ship
// independently, and coupling them would make /goal silently depend on a
// separate opt-in. `agentDisabled` likewise splits per feature (D-16).
// See docs/artifacts/25-08-2026_autonomy-stack/spec.md §6.3.

export class Info extends Schema.Class<Info>("ConfigV2.Goal")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  // C2 dual budget defaults. Per-goal-cumulative, not per-round (E-11).
  maxRounds: NonNegativeInt.pipe(Schema.optional),
  maxTokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Ralph extends Schema.Class<Ralph>("ConfigV2.Ralph")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  maxRounds: NonNegativeInt.pipe(Schema.optional),
}) {}
