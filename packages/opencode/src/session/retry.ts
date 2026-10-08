import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Context, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5
/** Invocation-local host override; never accepted from public prompt payloads. */
export const RetryLimit = Context.Reference<number>("opencode/session/retry-limit", {
  defaultValue: () => RETRY_MAX_RETRIES,
})

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

/**
 * Per-provider retry policy from `provider.<id>.options.retry`. When it is
 * absent every default above applies unchanged; when present it is the
 * authority for the provider's session retry budget.
 */
export type Config = {
  readonly maxAttempts?: number
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxElapsedMs?: number
  readonly backoffFactor?: number
  readonly retryableStatuses?: readonly number[]
}

/** Error code for a failure that must not be replayed (a tool already started). */
export const RETRY_UNSAFE_CODE = "ProviderRetryUnsafeError"

function statusRetryable(status: number, config: Config) {
  if (config.retryableStatuses) return config.retryableStatuses.includes(status)
  return status === 408 || status === 429 || (status >= 500 && status < 600)
}

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

function hinted(error?: SessionV1.APIError) {
  const headers = error?.data.responseHeaders
  if (!headers) return undefined
  const retryAfterMs = headers["retry-after-ms"]
  if (retryAfterMs) {
    const parsedMs = Number.parseFloat(retryAfterMs)
    if (!Number.isNaN(parsedMs)) return parsedMs
  }
  const retryAfter = headers["retry-after"]
  if (retryAfter) {
    const parsedSeconds = Number.parseFloat(retryAfter)
    // convert seconds to milliseconds
    if (!Number.isNaN(parsedSeconds)) return Math.ceil(parsedSeconds * 1000)
    // Try parsing as HTTP date format
    const parsed = Date.parse(retryAfter) - Date.now()
    if (!Number.isNaN(parsed) && parsed > 0) return Math.ceil(parsed)
  }
  return undefined
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random(), config?: Config) {
  if (config) {
    // Configured policy: Retry-After wins over backoff; maxDelayMs bounds both
    // and initialDelayMs floors a hint so a "retry now" answer cannot spin.
    const ceiling = config.maxDelayMs ?? RETRY_MAX_DELAY_NO_HEADERS
    const initial = config.initialDelayMs ?? RETRY_INITIAL_DELAY
    const hint = hinted(error)
    if (hint !== undefined) return cap(Math.min(Math.max(hint, initial), ceiling))
    const base = initial * Math.pow(config.backoffFactor ?? RETRY_BACKOFF_FACTOR, attempt - 1)
    // Jitter below the ceiling so sessions that failed together spread out.
    if (base >= ceiling) return cap(Math.ceil(ceiling - ceiling * RETRY_JITTER_FACTOR * random))
    return cap(Math.min(Math.ceil(base + base * RETRY_JITTER_FACTOR * random), ceiling))
  }
  if (error?.data.responseHeaders) {
    const hint = hinted(error)
    if (hint !== undefined) return cap(hint)
    return cap(exponential(attempt, random))
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export function retryable(error: Err, provider: string, config?: Config) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    if (error.data.metadata?.code === RETRY_UNSAFE_CODE) return undefined
    const status = error.data.statusCode
    if (config && status !== undefined) {
      // A configured policy classifies status-bearing failures by status only:
      // 400/401/402/403/404/422 are never retried, whatever the message says.
      if (!statusRetryable(status, config)) return undefined
    } else if (
      // 5xx errors are transient server failures and should always be retried,
      // even when the provider SDK doesn't explicitly mark them as retryable.
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

/**
 * One retry decision. `attempt` is the 1-based retry about to be scheduled and
 * `elapsed` the time since the first failure. Returns undefined to stop.
 *
 * Without `config` the invocation `limit` (RetryLimit) bounds the retries. A
 * configured provider policy is the authority instead, including for tasks
 * whose caller lowered RetryLimit.
 */
export function decide(input: {
  error: Err
  provider: string
  attempt: number
  elapsed: number
  limit: number
  config?: Config
  random?: number
}): (Retryable & { wait: number }) | undefined {
  const retry = retryable(input.error, input.provider, input.config)
  if (!retry) return undefined
  const retries = input.config ? Math.max(0, (input.config.maxAttempts ?? RETRY_MAX_RETRIES + 1) - 1) : input.limit
  if (input.attempt > retries) return undefined
  const error = SessionV1.APIError.isInstance(input.error) ? input.error : undefined
  let wait = delay(input.attempt, error, input.random, input.config)
  const budget = input.config?.maxElapsedMs
  if (budget !== undefined) {
    const remaining = budget - input.elapsed
    if (remaining <= 0) return undefined
    wait = Math.min(wait, remaining)
  }
  return { ...retry, wait }
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
  config?: Config
  /** Failed attempts and first-failure time already spent by this turn. */
  carried?: { attempts: number; since: number }
}) {
  return Schedule.fromStepWithMetadata(
    Effect.map(RetryLimit, (limit) => (meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = decide({
        error,
        provider: opts.provider,
        attempt: (opts.carried?.attempts ?? 0) + meta.attempt,
        elapsed: opts.carried ? meta.now - opts.carried.since : meta.elapsed,
        limit,
        config: opts.config,
      })
      if (!retry) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = retry.wait
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
