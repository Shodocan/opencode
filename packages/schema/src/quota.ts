import { Schema } from "effect"

const Reference = Schema.String.check(Schema.isPattern(/^[^\u0000-\u001f\u007f]{1,200}$/))
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/))
export const HardQuotaReason = Schema.Literals(["account_quota_exhausted", "account_usage_limit"])
const common = {
  schema_version: Schema.Literal("1.0"),
  reason: HardQuotaReason,
  matrix_sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  receipt_id: Reference,
  observed_at: Timestamp,
  reset_at: Schema.optional(Timestamp),
  emitted_output_or_action: Schema.Literal(false),
}
export const HardQuotaEvidence = Schema.Union([
  Schema.Struct({ ...common, source: Schema.Literal("provider_rejection"),
    response_complete: Schema.Literal(true), turn_provider_requests: Schema.Literal(1),
    status_code: Schema.optional(Schema.Number), provider_request_id: Schema.optional(Reference) }),
  Schema.Struct({ ...common, source: Schema.Literal("open_circuit"),
    original_receipt_id: Reference, turn_provider_requests: Schema.Literal(0) }),
])
export type HardQuotaEvidence = Schema.Schema.Type<typeof HardQuotaEvidence>

export const QuotaFallback = Schema.Struct({
  evidence: HardQuotaEvidence,
  provider_id: Reference,
  model_id: Reference,
  effort: Reference,
})
export type QuotaFallback = Schema.Schema.Type<typeof QuotaFallback>
