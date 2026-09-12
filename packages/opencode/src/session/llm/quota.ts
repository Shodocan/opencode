import { randomUUID } from "node:crypto"
import { Cause, Effect, Stream } from "effect"
import { HttpContext, HttpRequestDetails, HttpResponseDetails, LLMError, QuotaExceededReason, type LLMEvent } from "@opencode-ai/llm"
import { HardQuotaEvidence } from "@opencode-ai/schema/quota"
import type { QuotaBinding, QuotaPolicy } from "@opencode-ai/plugin"
import { APICallError } from "ai"
import z from "zod"

const policy = z.object({
  schema_version: z.literal("2.1"), matrix_sha256: z.string().regex(/^[0-9a-f]{64}$/), category: z.string().min(1).max(120),
  rule: z.object({
    source: z.object({ route: z.string().regex(/^[^/\s]+\/[^\s]+$/), effort: z.enum(["medium", "xhigh", "max"]) }).strict(),
    target: z.object({ route: z.string().regex(/^[^/\s]+\/[^\s]+$/), effort: z.enum(["high", "max"]) }).strict(),
    when: z.array(z.enum(["account_quota_exhausted", "account_usage_limit"])).min(1).max(2)
      .refine((values) => new Set(values).size === values.length),
    max_fallbacks_per_turn: z.literal(1),
  }).strict(),
}).strict()

/** The plugin resolves this from its frozen admission record. Native verifies
 * only the exact active source and treats malformed or absent authority as no
 * authority; it never discovers fallback policy from model-visible data. */
export function authority(value: QuotaBinding, route: string): QuotaBinding {
  if (value.binding === "unknown") return { binding: "unknown" }
  if (value.binding !== "standalone" && value.binding !== "workflow") return { binding: "unknown" }
  if (!value.policy) return { binding: value.binding }
  const parsed = policy.safeParse(value.policy)
  if (!parsed.success) return { binding: "unknown" }
  const resolved = parsed.data
  if (resolved.rule.source.route !== route || resolved.rule.target.route === route)
    return { binding: "unknown" }
  if (resolved.rule.target.effort === "max" && resolved.category !== "review")
    return { binding: "unknown" }
  return { binding: value.binding, policy: resolved }
}

/** A complete typed provider quota rejection, never prose, a generic 429, or a partial SSE failure. */
export function rejection(error: unknown, config: QuotaPolicy, now = Date.now()): HardQuotaEvidence | undefined {
  if (!(error instanceof LLMError) || error.reason._tag !== "QuotaExceeded") return
  const http = error.reason.http
  if (!http?.response || http.bodyTruncated || http.response.status !== 429 || typeof http.body !== "string" || http.body.length > 65536) return
  const raw = http.body
  let body: { error?: { code?: unknown; type?: unknown; resets_at?: unknown } }
  try { body = JSON.parse(raw) } catch { return }
  const code = body?.error?.code ?? body?.error?.type
  const reason = code === "insufficient_quota" ? "account_quota_exhausted"
    : code === "usage_limit_reached" ? "account_usage_limit" : undefined
  if (!reason || !config.rule.when.includes(reason)) return
  const headers = http.response.headers
  const seconds = Number(headers?.["retry-after"])
  const reset = typeof body.error?.resets_at === "number" ? body.error.resets_at * 1000
    : Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : undefined
  const reset_at = reset !== undefined && reset > now && reset - now <= 90 * 86400000
    ? new Date(reset).toISOString() : undefined
  const id = http.requestId ?? headers["x-request-id"]
  return {
    schema_version: "1.0", reason, matrix_sha256: config.matrix_sha256,
    receipt_id: randomUUID(), observed_at: new Date(now).toISOString(),
    ...(reset_at ? { reset_at } : {}), emitted_output_or_action: false,
    source: "provider_rejection", response_complete: true, turn_provider_requests: 1,
    status_code: http.response.status, ...(id && /^[^\u0000-\u001f\u007f]{1,200}$/.test(id) ? { provider_request_id: id } : {}),
  }
}

/**
 * The AI SDK reports an actual provider response as APICallError while the
 * native runtime uses LLMError. Convert only the complete, structured account
 * exhaustion response at their common stream seam. This deliberately refuses
 * caller-shaped objects, generic 429s, transports, and partial bodies.
 */
export function fromAISDKError(error: unknown): LLMError | undefined {
  if (
    !APICallError.isInstance(error) ||
    error.statusCode !== 429 ||
    typeof error.responseBody !== "string" ||
    error.responseBody.length > 65_536
  )
    return
  let body: { error?: { code?: unknown; type?: unknown } }
  try { body = JSON.parse(error.responseBody) } catch { return }
  const code = body?.error?.code ?? body?.error?.type
  if (code !== "insufficient_quota" && code !== "usage_limit_reached") return
  const headers = Object.fromEntries(
    Object.entries(error.responseHeaders ?? {}).filter(([key, value]) => typeof key === "string" && typeof value === "string"),
  )
  return new LLMError({
    module: "AISDKQuotaAdapter",
    method: "stream",
    reason: new QuotaExceededReason({
      message: error.message || "Provider account quota exhausted",
      http: new HttpContext({
        request: new HttpRequestDetails({ method: "POST", url: error.url || "https://provider.invalid", headers: {} }),
        response: new HttpResponseDetails({ status: error.statusCode, headers }),
        body: error.responseBody,
        ...(typeof headers["x-request-id"] === "string" ? { requestId: headers["x-request-id"] } : {}),
      }),
    }),
  })
}

export class HardQuotaError extends Error {
  constructor(readonly evidence: HardQuotaEvidence) { super("Provider account quota exhausted"); this.name = "HardQuotaError" }
}
export class FallbackFailedError extends Error {
  constructor(readonly evidence: HardQuotaEvidence, cause: unknown) {
    super("Quota fallback failed; invocation will not replay", { cause }); this.name = "QuotaFallbackFailedError"
  }
}

/** Common adapter seam. Only initial bookkeeping may be held; output is never buffered. */
export function guard<R>(input: {
  binding: "standalone" | "workflow"
  policy: QuotaPolicy
  primary: () => Stream.Stream<LLMEvent, unknown, R>
  fallback: () => Stream.Stream<LLMEvent, unknown, R>
}): Stream.Stream<LLMEvent, unknown, R> {
  return Stream.unwrap(Effect.sync(() => {
    let exposed = false
    const bookkeeping: LLMEvent[] = []
    const fallback = (evidence: HardQuotaEvidence): Stream.Stream<LLMEvent, unknown, R> => {
      // Workflow ownership consumes this typed terminal and schedules its own
      // fresh card. Native must never replace a bound workflow child.
      if (input.binding === "workflow") return Stream.fail(new HardQuotaError(evidence))
      return input.fallback().pipe(
        Stream.map((event) => event.type === "step-finish" ? {
          ...event, quotaFallback: { evidence, provider_id: input.policy.rule.target.route.split("/")[0], model_id: input.policy.rule.target.route.slice(input.policy.rule.target.route.indexOf("/") + 1), effort: input.policy.rule.target.effort },
        } : event),
        Stream.catchCause((cause) => Cause.hasInterruptsOnly(cause)
          ? Stream.failCause(cause) : Stream.fail(new FallbackFailedError(evidence, Cause.squash(cause)))),
      )
    }
    return input.primary().pipe(
      Stream.mapEffect((event) => Effect.gen(function* () {
        if (!exposed && event.type === "step-start" && bookkeeping.length === 0) { bookkeeping.push(event); return [] }
        exposed = true
        return [...bookkeeping.splice(0), event]
      })),
      Stream.flatMap((events) => Stream.fromIterable(events)),
      Stream.catchCause((cause) => {
        if (exposed || Cause.hasInterruptsOnly(cause)) return Stream.failCause(cause)
        const evidence = rejection(Cause.squash(cause), input.policy)
        if (!evidence) return Stream.failCause(cause)
        return fallback(evidence)
      }),
    )
  }))
}

export * as Quota from "./quota"
