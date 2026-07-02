# Research Synthesis — Qwen Premature-Stop Recovery & Thinking-Loop Prevention

Date: 2026-07-01
Status: brainstorm research complete; user choices frozen (see `user_choices.md`)
Companion evidence: `research-1-harness-survey.md`, `research-2-qwen-inference.md`, `research-3-loop-detection.md`

## 1. Problem statement

A local Qwen 3.6 27B reasoning model (served via **vLLM**, OpenAI-compatible endpoint) driving this opencode fork exhibits two canonical failure modes:

1. **Thinking loops** — the model repeats reasoning text inside its thinking block until the output-token cap, producing no answer/tool call.
2. **Premature stop** — the model ends its turn (`finish_reason: "stop"`, or `"length"` truncation) while the task is incomplete: pending work, a promised-but-not-executed action, or empty text after a long thinking block.

Fix scope is **harness-side** (opencode fork) plus request/server configuration. No model retraining.

## 2. Repo scouting — existing machinery (verified 2026-07-01, fork/main @ v1.17.13 merge)

### Reusable

| Machinery | Location | Relevance |
|---|---|---|
| Synthetic prompt infra (fork) | `packages/schema/src/tui-event.ts:20-28` (`PromptSynthetic`), `packages/schema/src/session-event.ts:116-125` (`session.next.synthetic`), `packages/core/src/session/message-updater.ts:153-163`, TUI hidden-prompt queue `packages/tui/src/component/prompt/index.tsx:235-290` | Ready-made path to inject a continue/nudge prompt; supports visible/hidden + muted rendering via `visibleUserTextParts` (`packages/tui/src/routes/session/visible-user-text.ts`) |
| `compaction_continue` marker (fork) | `packages/opencode/src/session/compaction.ts:62-67` (`isCompactionContinuation`), exclusion from `turns()` at :100 | Exact precedent for a synthetic continuation excluded from compaction/turn accounting — clone for stop-recovery markers |
| Fallback/model-switch (fork) | `packages/core/src/session/runner/fallback.ts` (`shouldFallback` :65-69, `nextFallbackModel` :73-86, `MAX_FALLBACKS=4`, `MAX_TURN_TRANSITIONS=8`), transitions `ContinueWithFallbackModel`/`ContinueRetrySameModel` in `packages/core/src/session/runner/llm.ts:157-163,385-462`, `SessionEvent.ModelSwitched` | Retry/switch orchestration exists; today triggers only on retryable HTTP errors + context overflow. L3 (deferred) would extend it |
| Doom-loop detector | `packages/opencode/src/session/processor.ts:29,351-378` (`DOOM_LOOP_THRESHOLD=3`, same tool + identical `JSON.stringify(input)` 3×, → `permission.ask("doom_loop")`) | Only loop detection in the codebase; pattern/threshold precedent |
| Streaming reasoning observation point | `packages/opencode/src/session/processor.ts:292-304` (`reasoningMap[id].text += delta`, unbounded) | Where an L2 detector would hook (deferred) |
| `chat.params` plugin hook | `packages/plugin/src/index.ts` (Hooks), invoked `packages/opencode/src/session/llm/request.ts:115-135` | Can mutate `temperature`, `topP`, `topK`, `maxOutputTokens`, arbitrary `options` per request — L0 penalty plumbing without core changes |
| Per-agent request passthrough | `packages/schema/src/provider.ts:46-50` (`Provider.Request.body: Record<string, Json>`), options merge chain `request.ts:91` (base → model.options → agent.options → variant) | Arbitrary body fields (e.g. `presence_penalty`, vLLM `extra_body` keys) reach OpenAI-compatible providers |
| `experimental.compaction.autocontinue` hook | plugin Hooks interface | Precedent for gating auto-continue behavior |

### Turn lifecycle facts (V1 path, `packages/opencode/src/session/`)

- Step loop: `prompt.ts:1081-1340` (`runLoop`, `while(true)`); exit when `lastAssistant.finish` set AND not `"tool-calls"` AND no pending tool calls AND user msg older than assistant (`prompt.ts:1111-1129`).
- `finished = handle.message.finish && !["tool-calls","unknown"].includes(...)` at `prompt.ts:1294` — **`"length"` counts as finished; turn ends silently. No auto-continue.**
- Provider-lies guard exists partially: `prompt.ts:1106-1109` continues the loop if the message has non-provider-executed tool calls even when finish is `"stop"`.
- `maxSteps` per agent (`agent.steps`), `MAX_STEPS_PROMPT` + `toolChoice:"none"` on last step (core runner `llm.ts:247-258`).
- API-error retry: `processor.ts:658-672` (`SessionRetry.policy`, exponential backoff).
- Abort: `AbortController` per stream (`llm.ts:377-380`); aborted turn persists partial parts + error; **no abort-then-re-prompt primitive**.
- FinishReason schema: `packages/llm/src/schema/ids.ts:39` — `["stop","length","tool-calls","content-filter","error","unknown"]`.
- Reasoning tokens tracked message-level only (`tokens.reasoning`); no per-part accounting, no stream watchdog, no reasoning-text repetition detection.
- Qwen model defaults in `packages/opencode/src/provider/transform.ts:484,502`: temp 0.55 / topP 1 when id includes "qwen". **No penalty params set anywhere**; `presence_penalty`/`frequency_penalty` exist in the OpenAI protocol schema (`packages/llm/src/protocols/openai-chat.ts:103-104,364-365`) but are never populated.

### Gaps (nothing exists)

- No auto-continue on `finish === "length"`.
- No premature-stop detection (`stop` + incomplete work).
- No no-tool-use nudge.
- No reasoning-loop detection / reasoning budget / stream stall watchdog.
- No abort+re-prompt primitive.
- No Qwen penalty/thinking-budget config surface documented for local providers.

## 3. Research conclusions (see companion reports for evidence)

1. **Two failure modes need opposite fixes**: truncation (`length`) → bounded re-request/continuation; premature stop (`stop` + incomplete) → bounded nudge. Conflating them causes bugs.
2. **Deterministic checks beat LLM-as-judge**: every surveyed harness (Cline, Roo, Kilo, Aider, OpenHands, Gemini CLI, Codex, Goose, Claude Code) uses finish-reason gating + "did it call a tool?" booleans. Judge calls are rare and opt-in.
3. **The convergent guardrail number is 3** (consecutive mistakes/reflections/repeats) with one silent grace retry (Roo PR #10196) and explicit automated-message marking.
4. **`finish_reason` from local OpenAI-compatible providers lies** (`stop`/`unknown` with tool calls present; empty `tool_calls: []`). All gating must pair with tool-call presence booleans.
5. **Loops are mostly preventable at the sampler**: Qwen official — thinking-coding preset temp 0.6 / top_p 0.95 / top_k 20 / min_p 0; `presence_penalty` 0.5→1.5 as the sanctioned anti-loop lever; `repetition_penalty` stays 1.0 (harms code, can cause loops). Never greedy.
6. **vLLM natives (operative for this deployment)**: `--reasoning-parser qwen3`, `thinking_token_budget` (forces `</think>`; PR #20859; unenforced under MTP spec-decode #39573), `repetition_detection` (`FINISHED_REPETITION` scheduler stop). No DRY on vLLM.
7. **Streaming client-side loop detection (L2) is well-understood but highest-complexity/highest-FP-risk** — line-level exact-repeat ≥3, reasoning-channel-only, multi-signal confirmation. Field evidence (SWE-agent abandoning semantic detection; Gemini CLI FP history) says: do it only after L0/L1 data shows residual need.

## 4. Chosen design: layered, sequenced by evidence strength

```
L0 Prevention   — sampling + vLLM config (config/docs + penalty plumbing)   [IN SCOPE v1]
L1 Recovery     — length-continue + no-tool nudge + empty-after-thinking    [IN SCOPE v1]
L2 Detector     — streaming thinking-loop detection + abort/recovery ladder [DEFERRED]
L3 Escalation   — loop/premature-stop counters feed shouldFallback          [DEFERRED]
```

### L0 — Prevention (vLLM + config)

- Document + (where needed) plumb the Qwen thinking-coding request set: `temperature 0.6, top_p 0.95, top_k 20, min_p 0, presence_penalty 0.5–1.5, repetition_penalty 1.0`.
- Verify the fork can deliver `presence_penalty`/`frequency_penalty`/`min_p` per model to a vLLM OpenAI-compatible endpoint via existing options chain (`provider.options` → `model.options` → `agent.options` / `Provider.Request.body` / `chat.params`); close any plumbing gap found.
- vLLM server-side recipe (docs): `--reasoning-parser qwen3`, `thinking_token_budget ≈ 4096–8192`, `repetition_detection {min_pattern_size 1, max_pattern_size ~40, min_count 4}`, KV cache q8_0/unquantized, YaRN off unless >32k, spec-decode caveat.
- Consider updating `transform.ts` qwen defaults (temp 0.55 → 0.6 alignment; whether to add default presence_penalty for qwen-on-local is a spec decision — must not affect hosted qwen providers).

### L1 — Premature-stop recovery (core fork feature, config-gated opt-in)

Components (all deterministic, all bounded):

1. **Length auto-continue**: on `finish === "length"` → validate/repair any truncated partial tool call (discard, never execute), inject a synthetic continue prompt ("Continue from where you left off."), re-enter loop. Cap: 2–3 per user turn.
2. **No-tool-use nudge**: assistant finished (`stop`) with text but zero tool calls while work is demonstrably pending → inject Cline/Roo-lineage automated nudge. One silent grace retry, then count toward `consecutiveMistakeLimit` (default 3, `0` = unlimited), then hard-stop + surface to user. "Work pending" signal must be deterministic (e.g. pending todo state); defining it precisely is a spec task.
3. **Empty-after-thinking**: `text.trim() === "" && reasoning present` on a finished turn → same nudge path (deterministic trigger, no pending-work check needed).
4. **Finish-reason robustness**: continuation gate pairs finish string with tool-call presence boolean (extend the existing `prompt.ts:1106-1109` guard).
5. **Synthetic messages**: reuse fork synthetic infra + a new metadata marker (sibling of `compaction_continue`, e.g. `stop_recovery_continue`), excluded from compaction turn accounting; rendered **visible + muted + marked automated** (frozen choice UC4).
6. **Config**: opt-in gate (off by default), caps, and enable/disable per component; exact schema is a spec task.
7. **Telemetry**: count incidents/outcomes (trigger type, attempts, resolution) — pattern-match the fallback feature's event/telemetry approach.

### Interactions & risks to carry into spec

- Doom-loop guard and no-tool nudge must not fight (nudge loop → doom loop of nudges); nudge counter must reset on genuine progress (tool call or text growth).
- `MAX_STEPS_PROMPT` path (tools disabled on last step) must not trigger the no-tool nudge.
- Continue-cap state lives per user-turn, must survive step iterations but reset on new user prompt / manual abort.
- Length-continue with a truncated tool call: partial JSON must never execute (research: opencode #18108 class of bugs).
- Fork-maintenance: feature must be additive and isolated (FORK_CHANGES.md entry, upstream-merge-friendly), consistent with fallback-model/compaction fork features.
- Non-goals v1: L2 streaming detector, L3 fallback escalation, stream-stall watchdog, LLM-as-judge completion checks, hidden nudges.

## 5. Success criteria (draft, to be formalized in spec)

- A `length`-truncated turn resumes automatically and completes without user intervention (≤ cap attempts).
- A `stop`-with-pending-work turn receives exactly one visible automated nudge (+ grace retry semantics) and either resumes or halts with a clear user-facing status after the cap.
- Zero behavior change when the feature flag is off, and zero change for providers/models when on but not triggered.
- Sampling/penalty params reach the vLLM endpoint verbatim per configuration.
- All new synthetic messages excluded from compaction candidates; no infinite continue loops possible by construction (hard caps).
