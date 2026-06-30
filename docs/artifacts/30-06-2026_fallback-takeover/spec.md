# Model Fallback Takeover Visibility and Telemetry Spec

Status: approved design, not implemented
Date: 2026-06-30

## Goal

When the active model fails with a real provider availability/capacity error, OpenCode should retry the same model enough times, then let the configured fallback model take over as the session-wide active model. The takeover must be visible in the TUI and recorded with detailed telemetry, without falling back on timeout-only failures.

## User-approved decisions

- Use approach A: extend the existing `session.next.model.switched` / `model-switched` path with optional fallback metadata.
- Fallback takeover is session-wide until the user manually switches models again.
- TUI visibility uses both a transcript row and status/footer context.
- Telemetry records full detail for failed attempts, successful takeover, and fallback exhaustion.
- The TUI shows only concise, sanitized failure reason text.
- Persist takeover immediately before publishing the first valid assistant event from the selected fallback model.
- Never fallback because of timeout alone.
- Fallback only for real provider errors such as quota exceeded, rate limit, provider internal/server errors, provider offline/unreachable, or equivalent availability/capacity failures.
- Try 3 total same-model attempts before fallback: initial attempt + 2 retries. Existing lower-level provider/runtime retries count toward this budget and must not be stacked with redundant session-level retries.

## Architecture

### Durable state path

Use the existing `SessionEvent.ModelSwitched` event as the single authoritative durable model-state transition.

The event/message contract should gain optional fallback metadata, while keeping existing manual switch events backward compatible. Each new field below must be optional on both `SessionEvent.ModelSwitched` and `SessionMessage.ModelSwitched`:

- `source`: discriminator such as `"manual" | "fallback"`; omitted legacy events are treated as manual/non-fallback.
- `from`: previous model ref for fallback takeover.
- `reason`: concise sanitized reason object for fallback takeover, including a stable category such as `rate-limit`, `quota-exceeded`, `provider-internal`, `provider-offline`, or `context-overflow`.
- `attempts`: summary of same-model attempts before takeover.

The existing projector already updates `SessionTable.model` from `event.data.model`. Fallback takeover should reuse that projector by emitting `ModelSwitched` only at the successful takeover commit point. This keeps one authoritative persisted model: the session model.

### Commit boundary

The runner must not emit `ModelSwitched` when it merely selects a fallback candidate. Selection can fail.

The takeover commit point is the first valid assistant event from the fallback model that would start an assistant message in the session transcript. This includes the first assistant text/content event, reasoning/thinking content block, or first model-emitted tool-call event. It does not include local tool results, telemetry-only records, provider-error events, or internal retry bookkeeping.

Implementation must publish the fallback `ModelSwitched` event immediately before publishing that first fallback assistant event. This guarantees:

- a failed fallback attempt does not persist takeover;
- the transcript can show the takeover before the fallback answer;
- future prompts resolve from the fallback model after takeover;
- the active session model remains unchanged if all fallbacks fail.

If the fallback turn later fails mid-stream after this commit point, do not roll back the persisted session model. At that point the fallback has taken over and should remain the active session model; telemetry must record a committed takeover whose provider turn later failed.

### Manual switch semantics

Manual model switches continue to use the same event path. Manual switches either set `source: "manual"` or omit `source` for backward compatibility. Any manual switch clears fallback status/footer context because the user has explicitly selected a new active model.

## Fallback trigger and retry policy

### Attempt budget before fallback

Fallback may begin only after 3 total attempts on the current active model fail with eligible non-timeout provider errors.

- Count as 3 total attempts: initial attempt + 2 retries.
- Existing lower-level runtime retries count toward this total. For example, an HTTP executor with `MAX_RETRIES = 2` already satisfies 3 total HTTP attempts for errors it retries.
- Do not add extra session-level retries when the lower layer has already performed the 3 total attempts.
- For eligible errors that are not retried by the lower layer, the runner may perform enough same-model attempts to reach 3 total before selecting fallback.
- The per-drain transition budget and fallback-hop budget still apply; retry accounting must not create retry storms.
- Runner-level same-model retries, when needed, must preserve the V2 invariant of one explicit `llm.stream(request)` call per provider turn. Do not implement retries as an opaque nested in-memory loop around a single provider turn. Each retry attempt must be a bounded provider-turn attempt that rebuilds/reloads the request state as the current runner architecture requires and must not bridge through legacy `SessionPrompt.loop(...)`.

### Eligible fallback failures

Fallback is allowed only for real provider availability/capacity failures after the 3-attempt rule is satisfied:

- quota exceeded;
- rate limit;
- provider internal / 5xx / retryable server-side failure;
- provider offline or unreachable as a non-timeout transport failure;
- provider/model availability category when it represents provider outage or unavailability;
- context overflow only after the existing compaction recovery path cannot resolve it.

The implementation must update the fallback eligibility predicate so non-timeout transport/offline failures are eligible while timeout-only transport failures remain ineligible. The predicate should be explicit, for example via named helpers such as `isTimeoutOnlyFailure` and `isProviderOfflineFailure`, rather than relying on ad hoc string checks at multiple call sites.

### Ineligible fallback failures

Do not fallback for:

- timeout-only failures, including full-request, header, chunk, or Effect timeout classifications. The timeout discriminator must be centralized in a named predicate such as `isTimeoutOnlyFailure`; if it uses `TransportReason.kind`, the accepted timeout literal(s) must be documented and tested for value stability.
- user interrupts;
- authentication errors;
- content-policy errors;
- invalid requests other than context-overflow recovery cases;
- missing local route/configuration errors that represent a user/config issue rather than provider availability;
- any failure after assistant output has already started;
- provider errors already published mid-stream under current runner safety rules.

Timeouts may still be retried or surfaced according to the existing provider/runtime policy, but timeout alone must never select a fallback model.

## TUI behavior

### Transcript row

Extend the existing `model-switched` transcript message with optional fallback metadata.

Manual switch rendering stays compatible with current behavior.

Fallback takeover rendering should be explicit, for example:

```text
Fallback takeover: openai/gpt-4.1 → anthropic/claude-sonnet
Reason: rate limit
```

Only concise sanitized reason text should be shown. Do not render raw provider bodies, stack traces, headers, or oversized error responses.

The existing runner history conversion drops `model-switched` messages from LLM context, and that behavior must remain true so visibility rows do not affect provider prompts.

### Status/footer

The status/footer should show the fallback model as the active model after takeover and include lightweight fallback context from the latest fallback-sourced model switch, for example:

```text
Active: anthropic/claude-sonnet · fallback from openai/gpt-4.1
```

A later manual model switch clears this fallback context.

Legacy `model-switched` messages without fallback metadata should not produce fallback footer/status context.

On session reload/resume, the TUI should reconstruct fallback footer/status context from durable state: the latest model switch after the last manual switch determines whether fallback context is shown. If the latest relevant `model-switched` message/event has `source: "fallback"`, show its `from` context; if it is manual or legacy/omitted, show no fallback context. If compaction, pagination, or transcript windowing omits the visible row, status/footer should still be reconstructable from durable model-switch data and must not inject anything into provider-facing LLM context.

## Telemetry and failure accounting

Telemetry must be more detailed than the TUI transcript message. Full failed-attempt details must not be stored only in the transcript `model-switched` message.

Record telemetry for:

### Failed same-model attempts before fallback

- session ID;
- agent;
- attempted model/provider/variant;
- failure category and LLM reason tag/code where available;
- whether the failure was fallback-eligible;
- whether fallback was blocked because the failure was timeout-only;
- total attempt count;
- whether attempts came from lower-level runtime retries or runner-level attempts.

### Successful fallback takeover

- from model/provider/variant;
- to model/provider/variant;
- concise takeover reason category;
- triggering failure reason tag/code where safe;
- fallback hop count;
- tried model chain;
- final active model after takeover.

### Fallback exhaustion

- attempted fallback chain;
- final failure category;
- no takeover committed;
- session model stayed on the previous active model.

Telemetry may include existing sanitized LLM error fields, but must not leak secrets, raw auth headers, unredacted URLs, or large provider response bodies.

### Telemetry transport

Implementation should make fallback telemetry queryable through the existing stats/log processing path rather than hiding it only in transcript messages.

- Add optional fallback fields to the `infra/stats.ts` `inference.event` schema where needed, such as fallback event type, source/target model refs, attempt count, retry provenance, hop count, tried-chain summary, eligibility flag, timeout-blocked flag, and exhaustion/committed-failed flags.
- Extend `packages/console/function/src/log-processor.ts` to extract those optional fields from structured logs/events.
- Use distinct event types or equivalent stable values for `fallback.attempt_failed`, `fallback.takeover`, `fallback.exhausted`, `fallback.timeout_blocked`, and `fallback.takeover_turn_failed`.
- All new telemetry fields must be optional/backward-compatible for existing records.

## Schema and compatibility

- New fields on public `SessionEvent.ModelSwitched` and `SessionMessage.ModelSwitched` must be optional and decode-compatible with existing clients.
- The fields `source`, `from`, `reason`, and `attempts` must each be optional on both event and message schemas. Legacy payloads omitting all four fields decode successfully and are treated as manual/non-fallback.
- In `packages/schema`, optional object fields must use the package `optional(...)` helper where applicable.
- Existing manual switch callers must keep working without specifying fallback metadata.
- Legacy events/messages with no `source` are treated as manual/non-fallback.
- If public Protocol or Server `HttpApi` generated surfaces change, run `bun run generate` from `packages/client` and regenerate the legacy JavaScript SDK as required by repo policy.

## Edge cases

- If fallback candidate A fails before output starts, continue to the next configured fallback candidate after retry/attempt policy and budgets allow.
- If all fallback candidates fail, surface the final provider failure normally and emit exhaustion telemetry. Do not persist takeover.
- Preserve current user-interrupt behavior: interruption is not a fallback trigger.
- Preserve current post-output behavior: once assistant output has started, do not change models for that provider turn.
- Preserve anti-ping-pong behavior around compaction and overflow recovery. The fallback override should remain threaded through compaction reruns until takeover commits or the attempt fails.
- After fallback takeover succeeds, future prompts use the persisted fallback model as the new primary. If that model later fails, fallback evaluation starts from the new active model and its configured chain.
- Manual model switch after takeover clears fallback footer/status context.
- Manual model switch during an in-flight fallback attempt before takeover commit cancels any pending takeover from that attempt. Before emitting fallback `ModelSwitched`, the runner must confirm the session's active model still matches the `from` model that failed; if the user has switched, skip the automatic takeover.
- If a committed fallback turn fails mid-stream after emitting the takeover `ModelSwitched`, keep the fallback model as the active session model and record `fallback.takeover_turn_failed` telemetry. This is not exhaustion because takeover already committed.
- Compaction/reload must not erase the semantic fact that a fallback takeover happened. Even if a visible transcript window omits the row, durable model-switch data should allow TUI status/footer reconstruction.

## Acceptance criteria

### Core behavior

- A fallback candidate is not selected until 3 total attempts on the current active model have failed with eligible non-timeout provider errors.
- Existing lower-level retries count toward the 3 total attempts and are not duplicated by extra runner retries.
- Timeout-only failures never trigger fallback selection.
- Timeout detection uses a centralized predicate with tests for every timeout classification emitted by the LLM runtime.
- Quota exceeded, rate limit, provider internal/server error, and non-timeout provider offline/unreachable failures can trigger fallback after the 3-attempt rule.
- Non-timeout transport/offline failures are explicitly eligible, and timeout transport failures are explicitly ineligible.
- Fallback takeover persists `SessionTable.model` only after fallback assistant output begins.
- The fallback `ModelSwitched` event is durably emitted before the first fallback assistant event is published, so the transcript row precedes the fallback answer.
- Failed fallback attempts do not persist model takeover.
- A fallback turn that fails mid-stream after takeover commit does not roll back the session model and emits committed-turn-failed telemetry.
- Exhausted fallback chain leaves the session model unchanged and records exhaustion telemetry.
- Manual model switches remain backward compatible and clear fallback status context.
- Manual model switch during an in-flight fallback attempt cancels the pending automatic takeover if the switch happens before commit.
- Runner-level retries for eligible errors not retried by the lower layer preserve the one-`llm.stream`-call-per-provider-turn invariant and count correctly toward the 3-attempt budget.

### TUI

- Fallback takeover renders a transcript `model-switched` row with from/to model and concise sanitized reason.
- Status/footer shows active fallback model and fallback-from context after takeover.
- After session reload/resume, status/footer reconstructs fallback-from context from the latest durable fallback-sourced model switch after the last manual switch.
- Manual model switch clears fallback-from status/footer context.
- Raw provider errors are not rendered in the transcript/status surfaces.
- Sanitization is positively tested with provider messages containing secrets, raw headers, and unredacted URLs; the TUI renders only the safe concise category/message.

### Telemetry

- Failed attempts, successful takeover, timeout-blocked fallback, and fallback exhaustion are distinguishable in telemetry.
- Telemetry records attempt counts and whether retries came from lower-level runtime retries or runner-level attempts.
- Telemetry includes from/to model details and tried-chain/hop information for takeover/exhaustion.
- Telemetry includes a distinct committed-takeover-then-turn-failed record.
- Telemetry remains secret-safe and avoids raw oversized provider payloads.

### Contract and generation

- Optional fallback metadata fields are backward compatible for existing event/message consumers.
- Each of `source`, `from`, `reason`, and `attempts` is independently optional on both event and message schemas.
- Contract tests cover omitted optional fields and fallback-populated fields.
- Stats/log schema changes for fallback telemetry use optional fields and stable event-type values.
- Generated client/SDK outputs are refreshed if the changed public event/message surface requires it.

## Validation plan

- Core unit tests for fallback eligibility:
  - rate limit and quota exceeded eligible after 3 attempts;
  - provider internal/5xx eligible after 3 attempts;
  - non-timeout transport/provider offline eligible after 3 attempts;
  - timeout transport ineligible;
  - all timeout-only runtime classifications are caught by the centralized timeout predicate;
  - auth/content-policy/invalid request ineligible.
- Core runner tests:
  - takeover event emitted only after fallback assistant output starts;
  - takeover event is emitted before the first fallback assistant transcript event;
  - failed fallback before output does not mutate session model;
  - committed fallback turn that later fails mid-stream keeps the fallback model active and records committed-turn-failed telemetry;
  - exhaustion preserves original active model;
  - manual switch behavior unchanged;
  - manual switch during pending fallback prevents stale automatic takeover;
  - lower-level retry count can satisfy the 3-attempt rule without extra runner retries.
  - quota exceeded that is not retried by the lower layer still reaches 3 total attempts through the approved retry path before fallback.
- Projection/message tests:
  - `ModelSwitched` with fallback metadata updates session model and creates a `model-switched` message carrying concise metadata;
  - legacy/manual events without metadata remain valid.
- TUI tests:
  - fallback transcript row rendering;
  - fallback footer/status rendering;
  - fallback footer/status reconstruction after session reload;
  - manual switch clears fallback context.
  - sanitization redacts secrets, raw headers, and unredacted URLs from visible fallback reasons.
- Telemetry tests or smoke validation:
  - failed attempt record;
  - timeout-blocked record;
  - successful takeover record;
  - exhaustion record;
  - committed takeover followed by mid-stream failure record;
  - stats/log processor extraction for optional fallback fields and stable event-type values.
- Package validation commands must be run from package directories, never repo root.

## Out of scope

- Implementing the code changes in this spec.
- Changing cache optimization behavior.
- Changing release monitor or MinIO auto-update behavior.
- Falling back on timeout-only failures.
- Adding provider-specific secret/raw error details to TUI.

## Relevant files

- `packages/core/src/session/runner/fallback.ts` — fallback decision helpers and hop/transition limits.
- `packages/core/src/session/runner/llm.ts` — provider turn orchestration, current ambient fallback override, compaction/fallback transition handling.
- `packages/core/src/session/projector.ts` — `ModelSwitched` projection updates persisted session model.
- `packages/core/src/session/message-updater.ts` — maps `ModelSwitched` event to transcript message.
- `packages/core/src/session/runner/to-llm-message.ts` — drops `model-switched` from provider-facing LLM history.
- `packages/schema/src/session-event.ts` — public `SessionEvent.ModelSwitched` schema.
- `packages/schema/src/session-message.ts` — public `SessionMessage.ModelSwitched` schema.
- `packages/tui/src/context/data.tsx` — TUI event ingestion for `session.next.model.switched`.
- `packages/tui/src/routes/session/index.tsx` — likely status/footer/session rendering surface.
- `infra/stats.ts` and `packages/console/function/src/log-processor.ts` — existing telemetry/stat fields and extraction path.
- `packages/llm/src/schema/errors.ts` — LLM error reason taxonomy including rate limit, quota exceeded, provider internal, transport timeout/offline categories.
- `packages/llm/src/route/executor.ts` — existing HTTP retry count and timeout/transport classification.
