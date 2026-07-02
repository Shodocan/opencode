export * as ConfigStopRecovery from "./stop-recovery"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

// FORK FEATURE (9) stop-recovery — v2 config block for opt-in premature-stop
// recovery (L1). Default disabled; zero behavior change when absent.
// See docs/artifacts/01-07-2026_premature-stop-recovery/spec.md §7.

const LengthMax = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(5))
const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))

export class LengthContinue extends Schema.Class<LengthContinue>("ConfigV2.StopRecovery.LengthContinue")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  max: LengthMax.pipe(Schema.optional),
  text: NonEmptyText.pipe(Schema.optional),
}) {}

export class NoToolNudge extends Schema.Class<NoToolNudge>("ConfigV2.StopRecovery.NoToolNudge")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  graceRetry: Schema.Boolean.pipe(Schema.optional),
  limit: NonNegativeInt.pipe(Schema.optional),
  text: NonEmptyText.pipe(Schema.optional),
}) {}

export class EmptyAfterThinking extends Schema.Class<EmptyAfterThinking>("ConfigV2.StopRecovery.EmptyAfterThinking")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  text: NonEmptyText.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.StopRecovery")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  lengthContinue: LengthContinue.pipe(Schema.optional),
  noToolNudge: NoToolNudge.pipe(Schema.optional),
  emptyAfterThinking: EmptyAfterThinking.pipe(Schema.optional),
}) {}