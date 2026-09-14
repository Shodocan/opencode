import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { StepFinish, TransportRoute } from "@opencode-ai/llm"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { LLMAISDK } from "../../src/session/llm/ai-sdk"

const binding = { providerID: "opencode-route", nonce: "1".repeat(32), sessionID: "ses_route_receipt_v2" }
const receipt = {
  v: 2, nonce: binding.nonce, session_sha256: createHash("sha256").update(binding.sessionID).digest("hex"),
  target: "grok", model: "grok-4.6", observation_id: "2".repeat(32), effort: "xhigh",
  requested_model: "glm-5.3", requested_effort: "high", generation: 7, selection_reason: "availability",
} as const
const route = {
  source: "managed_gateway_attestation", provider: "grok", model: "grok-4.6", observationID: receipt.observation_id,
  effort: "xhigh", receiptVersion: 2, requestedModel: "glm-5.3", requestedEffort: "high", generation: 7, selectionReason: "availability",
} as const
const persisted = {
  source: route.source, provider: route.provider, model: route.model, effort: route.effort,
  observation_id: route.observationID, receipt_version: 2, requested_model: route.requestedModel,
  requested_effort: route.requestedEffort, generation: route.generation, selection_reason: route.selectionReason,
} as const

// Native receives a proxy-verified header. Synthetic proof follows the existing
// adapter fixture; HMAC/domain validation belongs to the H proxy, not this seam.
function header(value: Record<string, unknown> = receipt) {
  return `${Buffer.from(JSON.stringify(value, Object.keys(value).sort())).toString("base64url")}.${"3".repeat(64)}`
}
async function adapt(value = header(), context = binding, extra: Record<string, string> = {}) {
  const event = { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: {},
    response: { id: "synthetic-response", timestamp: new Date(0), modelId: "untrusted-response-model",
      headers: { "x-opencode-route-attestation": value, ...extra } } }
  // Sparse usage matches existing adapter tests and needs no AI SDK client.
  const events = await Effect.runPromise(LLMAISDK.toLLMEvents(LLMAISDK.adapterState(context),
    event as Parameters<typeof LLMAISDK.toLLMEvents>[1]))
  expect(events).toHaveLength(1)
  expect(events[0].type).toBe("step-finish")
  if (events[0].type !== "step-finish") throw new Error("Missing step-finish")
  return events[0]
}

describe("managed gateway receipt v2", () => {
  test.each(["grok", "glm_ollama", "is1", "yolo", "ollama", "opencode_go",
    "minimax_m3_ollama", "kimi_k27_ollama", "kimi_k3_ollama", "nemotron_ollama",
    "gemma_ollama", "minimax_m27_ollama", "minimax_m25_ollama", "ornith_sglang"])("preserves actual %s selection through step-finish", async target => {
    const input = Object.freeze({ ...binding }), before = JSON.stringify(input)
    const event = await adapt(header({ ...receipt, target }), input)
    expect(event.transportRoute).toEqual({ ...route, provider: target })
    expect(event.responseModel).toBe("untrusted-response-model")
    expect(JSON.stringify(input)).toBe(before)
    expect(Schema.decodeUnknownSync(StepFinish)(event).transportRoute).toEqual({ ...route, provider: target })
  })
  test.each(["low", "medium", "high", "xhigh", "max", "unspecified"])("retains truthful %s requested/actual effort", async effort => {
    expect((await adapt(header({ ...receipt, effort, requested_effort: effort }))).transportRoute)
      .toEqual({ ...route, effort, requestedEffort: effort })
  })
  test("records unspecified to Go HIGH and primary LOW without rewriting requested effort", async () => {
    expect((await adapt(header({ ...receipt, target: "opencode_go", model: "deepseek-flash", requested_effort: "unspecified", effort: "high" }))).transportRoute)
      .toEqual({ ...route, provider: "opencode_go", model: "deepseek-flash", requestedEffort: "unspecified", effort: "high" })
    expect((await adapt(header({ ...receipt, target: "glm_ollama", model: "glm-5.3", requested_effort: "low", effort: "low", selection_reason: "primary" }))).transportRoute)
      .toEqual({ ...route, provider: "glm_ollama", model: "glm-5.3", requestedEffort: "low", effort: "low", selectionReason: "primary" })
  })
  test("decodes v2 metadata without silently stripping it into v1", () => {
    expect(Schema.decodeUnknownSync(TransportRoute)(route)).toEqual(route)
    expect(Schema.decodeUnknownSync(SessionV1.InferenceTransportRoute)(persisted)).toEqual(persisted)
  })
  test("preserves requested identity separately in the persisted step schema", () => {
    const part: SessionV1.StepFinishPart = {
      id: SessionV1.PartID.make("prt_receipt"), sessionID: SessionID.make(binding.sessionID), messageID: SessionV1.MessageID.make("msg_receipt"), type: "step-finish", reason: "stop", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      inference: { requested: { provider_id: "opencode-route", model_id: "glm-5.3", effort: "high" },
        response: { model_id: "untrusted-response-model", source: "transport_response", upstream_actual_identity: "unknown" },
        transport_route: persisted, cost: { amount: 0, semantics: "configured_rate_estimate", actual_bill: "unknown" } },
    }
    expect(Schema.decodeUnknownSync(SessionV1.StepFinishPart)(part)).toEqual(part)
  })
  test("accepts v1 unchanged with absent or arbitrary bounded legacy effort", async () => {
    for (const effort of [undefined, "legacy-custom-effort", "high"]) {
      const optional = effort === undefined ? {} : { effort }
      const legacy = { v: 1, nonce: receipt.nonce, session_sha256: receipt.session_sha256, target: "opencode_go",
        model: "deepseek-flash", observation_id: receipt.observation_id, ...optional }
      const expected = { source: route.source, provider: "opencode_go", model: "deepseek-flash", observationID: route.observationID, ...optional } as const
      expect((await adapt(header(legacy))).transportRoute).toEqual(expected)
      expect(Schema.decodeUnknownSync(TransportRoute)(expected)).toEqual(expected)
      const oldPersisted = { source: route.source, provider: "opencode_go", model: "deepseek-flash", observation_id: route.observationID, ...optional } as const
      expect(Schema.decodeUnknownSync(SessionV1.InferenceTransportRoute)(oldPersisted)).toEqual(oldPersisted)
    }
  })
  test("does not retroactively extend the v1 physical target set", async () => {
    for (const target of ["grok", "glm_ollama", "ornith_sglang"]) {
      expect((await adapt(header({ v: 1, nonce: receipt.nonce, session_sha256: receipt.session_sha256,
        target, model: "synthetic", observation_id: receipt.observation_id }))).transportRoute).toBeUndefined()
    }
  })
  test("rejects every missing or null v2 wire field", async () => {
    for (const key of Object.keys(receipt)) {
      const missing: Record<string, unknown> = { ...receipt }; delete missing[key]
      expect((await adapt(header(missing))).transportRoute, `missing ${key}`).toBeUndefined()
      expect((await adapt(header({ ...receipt, [key]: null }))).transportRoute, `null ${key}`).toBeUndefined()
    }
  })
  test("rejects out-of-range, unknown, and noncanonical v2 values", async () => {
    const changes: Record<string, unknown>[] = [
      { v: 3 }, { extra: "unknown" }, { target: "unknown" }, { target: "petabit" },
      { model: "" }, { model: "x".repeat(201) }, { model: "grok\n4" }, { model: "grók" },
      { nonce: "z".repeat(32) }, { nonce: "1".repeat(31) }, { session_sha256: "A".repeat(64) },
      { observation_id: "a".repeat(31) }, { observation_id: "A".repeat(32) },
      { effort: "none" }, { effort: "unsupported" }, { effort: "HIGH" }, { requested_effort: "unsupported" },
      { requested_model: "openai/glm-5.3" }, { requested_model: "arbitrary-model" }, { requested_model: "" },
      { generation: -1 }, { generation: 1.5 }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { generation: "7" },
      { selection_reason: "fallback" }, { selection_reason: "" },
    ]
    for (const change of changes) expect((await adapt(header({ ...receipt, ...change }))).transportRoute, JSON.stringify(change)).toBeUndefined()
  })
  test("accepts exact model/generation bounds and each selection reason", async () => {
    for (const model of ["x", "x".repeat(200)]) for (const generation of [0, Number.MAX_SAFE_INTEGER]) {
      expect((await adapt(header({ ...receipt, model, generation }))).transportRoute).toEqual({ ...route, model, generation })
    }
    for (const selection_reason of ["primary", "availability", "capability"] as const) {
      expect((await adapt(header({ ...receipt, selection_reason }))).transportRoute).toEqual({ ...route, selectionReason: selection_reason })
    }
  })
  test("requires current nonce/session/provider, unique header and canonical wire", async () => {
    for (const context of [{ ...binding, nonce: "4".repeat(32) }, { ...binding, sessionID: "ses_other" }, { ...binding, providerID: "other" }]) {
      expect((await adapt(header(), context)).transportRoute).toBeUndefined()
    }
    const canonical = header(), encoded = canonical.split(".")[0]
    for (const invalid of ["", canonical + ".extra", encoded + "=." + "3".repeat(64), encoded + "." + "Z".repeat(64),
      `${Buffer.from(JSON.stringify(receipt)).toString("base64url")}.${"3".repeat(64)}`,
      `${Buffer.from(JSON.stringify(receipt, Object.keys(receipt).sort(), 2)).toString("base64url")}.${"3".repeat(64)}`]) {
      expect((await adapt(invalid)).transportRoute).toBeUndefined()
    }
    expect((await adapt(canonical, binding, { "X-OpenCode-Route-Attestation": canonical })).transportRoute).toBeUndefined()
  })
  test("rejects ambiguous partial v2 schema objects instead of dropping new fields", () => {
    // An old target forces a union implementation to prove it does not fall
    // through to the v1 branch and strip the unrecognized v2 metadata.
    for (const key of ["receiptVersion", "requestedModel", "requestedEffort", "generation", "selectionReason"]) {
      const incomplete: Record<string, unknown> = { ...route, provider: "opencode_go" }; delete incomplete[key]
      expect(() => Schema.decodeUnknownSync(TransportRoute)(incomplete), key).toThrow()
    }
    for (const key of ["receipt_version", "requested_model", "requested_effort", "generation", "selection_reason"]) {
      const incomplete: Record<string, unknown> = { ...persisted, provider: "opencode_go" }; delete incomplete[key]
      expect(() => Schema.decodeUnknownSync(SessionV1.InferenceTransportRoute)(incomplete), key).toThrow()
    }
    for (const change of [{ generation: -1 }, { generation: 1.5 }, { generation: Number.MAX_SAFE_INTEGER + 1 },
      { receiptVersion: 3 }, { selectionReason: "arbitrary" }, { requestedEffort: "unsupported" }]) {
      expect(() => Schema.decodeUnknownSync(TransportRoute)({ ...route, provider: "opencode_go", ...change })).toThrow()
    }
  })
})
