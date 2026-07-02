# Adversarial Spec Review — Consolidated Findings

Spec: `spec.md` (this dir) | Review run: 2026-07-01
Pipeline: 3 finder waves (6 sonnet personas each) → final-finder (fable) → verify → refute → judge
Raw yield: W1 47, W2 28, W3 ~18, FIN 5. Consolidated below into 20 stable clusters.
Wave loop stopped after W3 on declining/saturating yield (47→28→18, no new criticals in W3); final-finder served as catch-all. Deviation from strict zero-new-wave rule noted for the record.

Status legend: filled in by judge (verdict: confirmed/refuted/downgraded; disposition: doc-fix/human_required/accepted-risk).

## A. Architecture (blocking)

### F1 | Execution-path selection: V1 prompt.ts loop vs core SessionRunner | CRITICAL | sources: ASM-1, FIN-3, spec OPEN-4
The spec targets the V1 `prompt.ts` loop. The core `SessionRunner` (`packages/core/src/session/execution/local.ts`, `runner/llm.ts`) is the durable drain path used by `V2Session.prompt` → `execution.wake()`. The sibling approved spec (30-06-2026_fallback-takeover) targets the core runner for the same deployment. UC3's frozen precedents are split across both layers (fallback = core runner, compaction-continuation = V1). At most one spec targets the live path. Additional collision: V1 resolves model from `lastUser.model` (prompt.ts:1141), so copying `model` onto injected synthetic messages would pin recovered turns to the pre-takeover model if takeover ever coexists.
Fix direction: OPEN-4 becomes BLOCKING; layer selection recorded as human decision (frozen-choice adjacency); add normative rule that recovery injections re-resolve the current session model when a takeover occurred within the turn; reconcile with fallback-takeover spec.

### F2 | Injection mechanism is mis-specified | CRITICAL | sources: GAP-1, ASM-2, CON-1, CON-2, GAP2-1, GAP2-2, CON3-46, CON3-47, CON3-48, RISK3-4, spec OPEN-5
`prompt.ts` never publishes `session.next.synthetic`; V1 synthetic user messages are inserted directly (compaction precedent `compaction.ts:504-515`). The interception point must be the inner `outcome === "break"` path (~prompt.ts:1333), NOT the outer exit guard — an injected user message flips the `lastUser.id < lastAssistant.id` comparison and the outer guard would not re-process. The injected message MUST copy `agent`, `model`, `format` from the originating real user message (`MessageV2.latest()` has no synthetic exclusion; agent-not-found is fatal; parentID binding). Marker is part-level metadata on V1 parts; `SessionMessage.Synthetic` (flat, no parts) is a secondary projection only. Recovery parts must never set `ignored: true` (survives `toModelMessagesEffect`).
Fix direction: rewrite §5.0/§5.1 injection + interception normatively; document dual representation; resolve OPEN-5 in-spec.

### F3 | Thinking-loop end-state coverage missing; repetition-killed turns invisible | CRITICAL | sources: FIN-1, GAP-3, ASM-3, DEP-4, GAP2-5, COV2-1, DEP3-48
The primary symptom has 3 end-states: (1) vLLM `repetition_detection` kill → provider finish maps to `"unknown"` via `mapFinishReason` fallthrough → exits silently at outer guard: no L1 trigger, no telemetry, unreachable from the inner interception point by construction; (2) `thinking_token_budget` force-close → empty-after-thinking works; (3) cap-hit `length` → mishandled (F4). §5.3 (no finish condition) vs §5.4 ("unknown never triggers") is a spec-internal contradiction. UC2's go/no-go rule ("revisit L2 only if telemetry shows loops surviving") is unimplementable as designed.
Fix direction: end-state coverage matrix in §5; REQUIRED finish-reason mapping for the repetition stop (map to a reachable value or extend enum) or an outer-guard telemetry-only observation hook; resolve §5.3/§5.4; plain-language trade-off statement for the human ("in-harness loop mitigation is nil by design; loops are mitigated server-side only").

### F4 | Length-continue counterproductive for reasoning-only truncation | HIGH | sources: FIN-2, GAP2-3, COV2-2 (priority interplay)
A thinking loop hitting the output cap yields `finish:"length"`, empty text, reasoning only. Prior-turn thinking is not replayed (Qwen template strips it; no assistant-reasoning wire field in the OpenAI-compatible chat format) — "Continue where you left off" restarts thinking from zero and likely re-loops, burning up to max×32k tokens. Trigger priority must NOT be a blanket length-first rule.
Fix direction: route `length AND empty-text AND reasoning-present` to the empty-after-thinking family; length-continue requires non-empty replayable content; tag events `reasoning_only: true`. (Adapter-level no-replay claim to be byte-verified; verifier task.)

## B. L0 plumbing

### F5 | Request-parameter plumbing structurally incomplete on BOTH runtime paths | MAJOR | sources: DEP-2, DEP-3, DEP2-1, DEP2-3, DEP3-46, DEP3-47, RISK-3, COV-8, spec OPEN-1/OPEN-2
AI SDK path: `openai-chat.ts` body builder emits penalties but omits `min_p`/`thinking_token_budget`/`repetition_detection`; `top_k` is in GenerationOptions but not emitted AND on `PROTOCOL_BODY_OVERLAY_DENYLIST`; `min_p` absent from `GenerationOptions` entirely. Native path (`experimentalNativeLlm`): `RequestInput`/`generation()` lack penalty fields altogether; namespaced providerOptions format vs `@opencode-ai/llm` consumer unverified. AI SDK `providerOptions` namespacing byte-level pass-through unverified.
Fix direction: spec must name the actual delivery mechanism per field per path (http.body overlay vs schema extension vs providerOptions), scope native path (unsupported note or patch requirement), and adjust A1 acceptance criteria per field.

### F6 | vLLM recipe completeness | MINOR | sources: DEP-5, DEP-6, DEP2-2, ASM2-3, FIN-4 (part)
Recipe example must set `model.limit.output`; add reasoning-parser/tool-call routing verification step (misrouting → false `hasToolCalls === false` → false nudges); pin versions (ai 6.0.168, @ai-sdk/openai-compatible 2.0.41, minimum vLLM); canary request per lever.

## C. Recovery semantics

### F7 | Trigger gating exactness | MAJOR | sources: COV3-1, COV3-2, GAP2-4, GAP3-3, GAP-4, GAP-8
"Normal stop" must exclude `content-filter` and `error` (both with/without message.error rows in §5.4); provider-executed tool calls count as progress (suppress nudge, `hasToolCalls` excludes providerExecuted parts); "joined assistant text" = text-type parts only (reasoning parts structurally separate); structured-output turns need an explicit exclusion mechanism at the decision point.

### F8 | Counter/state model robustness | MAJOR | sources: RISK3-1, RISK3-3, GAP3-1, GAP3-4, COV3-3, COV2-4, GAP-5, GAP-6, RISK-2, RISK-5, RISK-8
turnKey walk-back must skip ALL synthetic user messages via the generic real predicate (prompt.ts:202-203) — the task-summary nudge carries no marker; define turnKey fallback when compaction prunes the anchor (fabricate + reset, accepted bounded risk); specify reset mechanism placement (compare latest real user id at decision point); compaction does not reset counters; queued real user prompt resets when reached (no preemption); restart re-arms caps (bounded, document rapid-crash caveat); mid-sequence disable takes effect at next decision point; single shared grace across both nudge families; trivial-tool reset gaming documented + telemetry.

### F9 | Step accounting — one normative rule | MAJOR | sources: RISK3-2, RISK-7, FIN-5, spec OPEN-6
Recovery injections consume steps like any iteration; ALL recovery families are eligibility-checked against the next step: no injection when `step + 1 >= maxSteps`; restate §5.5 bound as min(configured caps, remaining steps). Closes OPEN-6 and the MAX_STEPS_PROMPT degenerate loop, avoids silent step-budget extension.

### F10 | Truncated tool-call discard semantics | CRITICAL (data integrity) | sources: RISK-1, spec OPEN-3
Specify exact atomic state transition (e.g. status cancelled + metadata.truncated) BEFORE loop re-entry; partial JSON must never reach an execution path; fixture both shapes (pending part vs no part); AC asserting no execution during discard.

### F11 | Work-pending signal wiring + staleness | MAJOR | sources: GAP-2, ASM-6
`Todo.Service` is not imported/provided in `prompt.ts` — wiring is a normative requirement (or query via available DB service). Stale-todo false positives → nudge storms: add mitigation or explicit risk entry.

### F12 | Nudge text hazards | MINOR | sources: ASM2-1, RISK2-3, COV3-4, GAP3-2, ASM2-4
Alt nudge variant without `[ERROR]` prefix for thinking models (prefix may amplify reasoning loops); override validation (non-empty, max length ~500 chars, structural-token caution); plugin `experimental.chat.messages.transform` may mutate recovery messages (marker-preservation note); subtask recovery artifacts visible in parent context (accepted, document).

### F13 | Unbounded modes | MINOR | sources: RISK-4, RISK2-2
`limit: 0` needs a session-level backstop (or TUI confirmation past N); durable StopRecovery event retention policy under unlimited mode.

### F14 | doom_loop pending-ask enforcement | MINOR | sources: RISK2-1, CON2-4
Constraint currently unenforceable; specify `Permission.list()` (or shared flag) check at the decision point, or downgrade to documented race.

## D. Contracts & artifacts

### F15 | Event-manifest counts + schema registration targets | CRITICAL (CI-breaking) | sources: ASM-4, DEP-1, CON-4, CON-8
Finders returned CONTRADICTORY numbers (ASM-4: schema Latest 90 / opencode 85; DEP-1/CON-4: schema 85 / opencode 90). Verifier must establish ground truth. Also: `DurableDefinitions`/`Definitions` inventories + `Durable` union in `packages/schema/src/session-event.ts` are the actual modification targets, not just test counts.

### F16 | Rendering beyond the TUI + exact TUI predicate | MAJOR | sources: ASM-5, CON-3, CON2-1, RISK-6, RISK2-4, RISK2-6
Exact `isVisibleUserTextPart` predicate change (which key, opencodeMcpVisible interplay, mcpCallerHeader); SDK metadata round-trip verification; web `session-ui` filters synthetic text parts (`message-part.tsx:1128`) → recovery invisible in web/app clients (partState/renderable/TimelineRow work or documented exclusion); headless: log-line/telemetry fallback; shares/exports include recovery messages (document or exclude).

### F17 | Artifact/codegen corrections batch | MINOR | sources: DEP-8, CON2-2, CON2-5, CON-5, CON-6, CON-7, GAP-7, DEP-7
SDK regen is `bun ./packages/sdk/js/script/build.ts` (not `bun run generate`); SDK `SessionDurableEvent` union must ingest the new event; `StopRecoveryError` needs NamedError definition + HTTP error middleware registration; exact `Config.Info` Effect Schema struct + defaults + per-model override decision; pick shared `isSyntheticContinuation` vs sibling predicate + 3 call-site updates; HTTP client exposure statement; FORK_CHANGES watchlist add prompt.ts/processor.ts + draft merge recipes.

## E. Process & telemetry

### F18 | Staged rollout / L0-verification protocol missing | MEDIUM-HIGH | sources: FIN-4
Phase 0 baseline (vLLM log capture, finish-reason histogram) → Phase 1 L0-only with verification checklist + observation window → Phase 2 L1 components individually → Phase 3 UC2 L2 go/no-go on captured data. Without this, L0 failure is invisible with L1 off.

### F19 | Telemetry insufficiency for the UC2 decision | MAJOR | sources: ASM2-2, RISK2-5, FIN-1/FIN-2 (tags)
Add tokens {input,output,reasoning} + cost to StopRecovery events; `reasoning_only` tag; usage roll-up statement for recovery turns (grouped under originating turnKey or documented as separate).

### F20 | Acceptance-criteria batch | MINOR | sources: COV-1..7, COV2-3, COV2-5, GAP-8
Add ACs: master-off negative (no triggers, no events); structured-output exclusion; standalone TUI rendering; empty-after-thinking counter sharing; single-injection-per-iteration (compaction priority); abort-during-recovery; graceRetry:false; lengthContinue.max:0 component disable.
