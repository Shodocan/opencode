import { Schema } from "effect"

// Receipt vocabulary only: proxy authentication and session binding stay in
// their runtime owners. The legacy receipt's vocabulary is intentionally frozen.
export const Target = Schema.Literals([
  "is1", "yolo", "ollama", "opencode_go", "glm_ollama", "grok",
  "minimax_m3_ollama", "kimi_k27_ollama", "kimi_k3_ollama", "nemotron_ollama",
  "gemma_ollama", "minimax_m27_ollama", "minimax_m25_ollama", "ornith_sglang",
]).annotate({ identifier: "GatewayRoute.Target" })
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max", "unspecified"]).annotate({ identifier: "GatewayRoute.Effort" })
export const RequestedModel = Schema.Literals([
  "qwen3.8-thinking", "qwen3.8-instruct", "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.3",
  "minimax-m3", "kimi-k2.7-code", "kimi-k3", "nemotron-3-super", "gemma4:31b",
  "minimax-m2.7", "minimax-m2.5", "ornith-9b",
]).annotate({ identifier: "GatewayRoute.RequestedModel" })
export const Model = Schema.String.check(Schema.isPattern(/^[\x20-\x7e]{1,200}$/)).annotate({ identifier: "GatewayRoute.Model" })
export const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)).annotate({ identifier: "GatewayRoute.Generation" })
export const SelectionReason = Schema.Literals(["primary", "availability", "capability"]).annotate({ identifier: "GatewayRoute.SelectionReason" })

export const Receipt = Schema.Struct({
  v: Schema.Literal(2),
  nonce: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  session_sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  target: Target,
  model: Model,
  effort: Effort,
  observation_id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  requested_model: RequestedModel,
  requested_effort: Effort,
  generation: Generation,
  selection_reason: SelectionReason,
}).annotate({ identifier: "GatewayRoute.Receipt" })
export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}

export * as GatewayRoute from "./gateway-route"
