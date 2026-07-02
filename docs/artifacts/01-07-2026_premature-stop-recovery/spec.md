# Qwen Premature-Stop Recovery & Thinking-Loop Prevention (L0 + L1) — Spec

Status: approved design, revised per adversarial review (`review-judgment.md`, this dir), not implemented
Date: 2026-07-01 (revised 2026-07-01)
Inputs: `research.md`, `user_choices.md` (FROZEN), `research-1-harness-survey.md`, `research-2-qwen-inference.md`, `research-3-loop-detection.md`, `review-judgment.md`
Format precedent: `docs/artifacts/30-06-2026_fallback-takeover/spec.md`

## 1. Problem statement

A local Qwen 3.6 27B reasoning model served via vLLM (OpenAI-compatible endpoint) driving this opencode fork exhibits two failure modes:

1. **Thinking loops** — the model repeats reasoning text inside the thinking block until the output-token cap, producing no answer or tool call.
2. **Premature stop** — the model ends its turn (`finish: "stop"` with pending work, `finish: "length"` truncation, or empty text after a long reasoning block) while the task is incomplete. The fork's session loop treats `"length"` as terminal (`packages/opencode/src/session/prompt.ts:1294`) and ends the turn silently. Server-side repetition kills surface client-side as `finish: "unknown"` and also end the turn silently (§5.6).

Fix scope is harness-side (this fork) plus request/server configuration. No model retraining. No inference-server code changes.

### Goals

- **L0 Prevention**: correct sampling/penalty parameters reach the vLLM endpoint per model/agent; documented vLLM server recipe (reasoning parser, thinking budget, repetition detection, sampling preset).
- **L1 Recovery**: bounded, deterministic, visible recovery in the session loop for three trigger families: length truncation, no-tool-use-with-pending-work, empty-after-thinking.
- Zero behavior change when the feature flag is off; zero change for untriggered providers/models when on.
- Telemetry for every recovery incident (trigger, attempt, outcome) so L2 need can be judged from data — including `observed`-only telemetry for silent unknown-finish ends (§5.6, §8).

### Non-goals (v1) — per UC2 / UC4

- L2 streaming thinking-loop detector (client-side repeat detection on `reasoning_content` deltas).
- L3 fallback escalation (loop/premature-stop counters feeding `shouldFallback`).
- Stream-stall watchdog (no-delta timeout abort).
- LLM-as-judge completion checks.
- Hidden/invisible nudges or auto-continues (UC4: all synthetic recovery messages are visible).
- Changing hosted-provider behavior (`transform.ts` qwen defaults stay untouched — see L0.2).
- SGLang/llama.cpp/LM Studio/Ollama recipes (UC1: vLLM only).

## 2. Human Decision Log (frozen 2026-07-01 — copied 1:1 from `user_choices.md`)

> Invariant: these choices are frozen. Any review finding that conflicts with a frozen choice is `human_required`; never autonomously revise.

### UC1 — Inference server

**Question:** Which inference server(s) run the Qwen 3.6 27B model?
**Choice:** **vLLM** (only).
**Implications:** L0 levers are `presence_penalty`/`frequency_penalty` via request body (no DRY sampler on vLLM), `--reasoning-parser qwen3`, `thinking_token_budget`, `repetition_detection`. SGLang/llama.cpp/LM Studio/Ollama recipes are out of scope (reference-only in research-2).

### UC2 — Scope of first implementation

**Question:** What scope for the first implementation?
**Choice:** **L0 + L1** — prevention config (sampling defaults/config plumbing + vLLM server recipe docs) plus premature-stop recovery (length auto-continue, no-tool-use nudge with grace retry + cap 3, empty-after-thinking trigger).
**Explicitly deferred (non-goals v1):** L2 streaming thinking-loop detector; L3 fallback escalation; stream-stall watchdog; LLM-as-judge completion checks.
**Implications:** revisit L2 only if telemetry from L0+L1 shows loops surviving correct sampling + vLLM server-side budgets.

### UC3 — Placement

**Question:** Where should the recovery behavior live?
**Choice:** **Core fork feature**, config-gated (opt-in, off by default), in the session loop/processor — same pattern as the fallback-model and compaction-continuation fork features.
**Implications:** full access to `finishReason`, tool-call state, and runner transitions; adds fork maintenance surface → must be additive/isolated with a FORK_CHANGES.md entry; plugin-only implementation rejected (no finishReason input, no clean prompt-injection path, no abort/retry capability).

### UC4 — Nudge/continue message visibility

**Question:** Should the synthetic continue/nudge messages be visible in the TUI?
**Choice:** **Visible, muted, explicitly marked as automated** (Cline/Roo convention), rendered via existing `visibleUserTextParts` machinery.
**Implications:** no hidden auto-continues; preserves user trust and debuggability; a later config option to hide is possible but not in v1 scope.

## 3. Verified repo baseline (spot-checked 2026-07-01, fork/main; review-verified 2026-07-01)

| Fact | Location | Verified detail |
|---|---|---|
| Live session path | `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:11, 289, 298-302` | The server route imports `SessionPrompt` (`:11`) and drives sessions via `promptSvc.prompt()` + `loop()` (`:289, 298-302`); server deps include `SessionPrompt.node`. The V1 `SessionPrompt.loop` IS the live path. The core `SessionRunner` (`packages/core/src/session/runner/`) is NOT the live path. |
| Loop exit guard | `packages/opencode/src/session/prompt.ts:1106-1130` | `hasToolCalls` = any part `type === "tool" && !metadata?.providerExecuted && !isOrphanedInterruptedTool(part)`; exit when `lastAssistant?.finish && !["tool-calls"].includes(finish) && !hasToolCalls && lastUser.id < lastAssistant.id`. The outer guard's core comparison is `lastUser.id < lastAssistant.id` (`:1111-1116`). Note: outer exit excludes only `"tool-calls"`, not `"unknown"`. |
| Step-level finished check | `prompt.ts:1294-1295` | `finished = handle.message.finish && !["tool-calls","unknown"].includes(finish)` — `"length"` counts as finished; no auto-continue anywhere. |
| Unknown-finish silent end | `packages/llm/src/protocols/openai-chat.ts:378-384`, `processor.ts:677-679`, `prompt.ts:1294` | `mapFinishReason` maps stop/length/content_filter/function_call\|tool_calls; everything else → `"unknown"`. Unknown-finish turns end silently: processor returns "continue" (`processor.ts:677-679`), `prompt.ts:1294` excludes unknown from finished, and the next-iteration outer guard breaks. |
| Content-filter precedent | `prompt.ts:1300-1306` | Sets `handle.message.error` (named error) + publishes `Session.Event.Error` — precedent for the L1 hard-stop surface. |
| Compaction continuation insertion | `packages/opencode/src/session/compaction.ts:62-67, 489-515` | User message with text part `synthetic: true, metadata: { compaction_continue: true }` is inserted DIRECTLY into session storage (`:489-515`) — no event round-trip. `isCompactionContinuation` excludes it from `turns()` (`:100`) and overflow replay selection (`:325,336`). |
| No loop-side synthetic event | `packages/schema/src/session-event.ts:116-125`, `prompt.ts` | The schema event `session.next.synthetic` exists, but `prompt.ts` never publishes it — it is NOT a loop-side injection mechanism. The only in-repo injection precedent for loop code is compaction's direct insertion (row above). |
| lastUser derivation | `prompt.ts:1141, 1170, 1188` | The loop derives model, agent, and `parentID` from `lastUser`. `MessageV2.latest()` has NO synthetic exclusion — an injected synthetic user message becomes `lastUser` and drives the next iteration's resolution. |
| Pending-tool cleanup guarantee | `packages/opencode/src/session/processor.ts:575-591` | `Effect.ensuring` cleanup transitions pending tool calls to `error` + `interrupted: true` on ALL exits — a truncated tool call cannot execute today. |
| Visible/muted rendering | `packages/tui/src/routes/session/visible-user-text.ts` | Synthetic text parts are hidden unless `metadata.opencodeMcpVisible === true`; visible synthetic parts render `muted: true`; optional caller header `◇ MCP · {caller}`. |
| Web synthetic filter | `packages/session-ui/src/components/message-part.tsx:1128` | Web/app clients filter synthetic user parts — recovery messages are invisible on those surfaces in v1 (§6, documented exclusion; §11.1 F16). |
| Doom-loop guard | `packages/opencode/src/session/processor.ts:29, 354-377` | `DOOM_LOOP_THRESHOLD = 3`; fires only when last 3 parts are tool parts with same tool + identical `JSON.stringify(input)`; raises `permission.ask("doom_loop")`. |
| Options merge chain | `packages/opencode/src/session/llm/request.ts:86-91` | `options = mergeOptions(mergeOptions(mergeOptions(base, model.options), agent.options), variant)`; exposed via `chat.params` plugin trigger alongside `temperature/topP/topK/maxOutputTokens`; handed to native request as `providerOptions` (`native-request.ts:192`). |
| Penalty/sampling emission | `packages/llm/src/protocols/openai-chat.ts:364-365` | `presence_penalty`/`frequency_penalty` ARE emitted on the AI SDK openai-chat path. Confirmed gaps: `min_p` absent from `GenerationOptions`; `top_k` not emitted AND on `PROTOCOL_BODY_OVERLAY_DENYLIST`; native `RequestInput`/`generation()` lack penalties. See §L0.1 matrix. |
| Temperature precedence | `request.ts:123-127` | `temperature: agent.temperature ?? ProviderTransform.temperature(model)`; `topK: ProviderTransform.topK(model)` (no agent override). Model-level sampling override path NOT verified end-to-end — see OPEN-2. |
| Qwen defaults | `packages/opencode/src/provider/transform.ts:484, 502` | `temperature()` → 0.55 and `topP()` → 1 for ANY model id containing `"qwen"` (hosted included). `OUTPUT_TOKEN_MAX = 32_000` (`:18`). |
| Reasoning replay (client side) | `packages/opencode/src/session/message-v2.ts:362-376` | `toModelMessagesEffect` DOES serialize reasoning parts into outgoing messages; native path too. Template-side replay (whether the vLLM Qwen chat template renders replayed reasoning into the prompt) is unverified — OPEN-7. |
| Last-step handling (V1) | `prompt.ts:1132, 1178-1179, 1280` | `step++` at `:1132`; `isLastStep = step >= (agent.steps ?? Infinity)` at `:1178-1179`; injects `MAX_STEPS_PROMPT` ("Tools are disabled… Respond with text ONLY") as assistant content at `:1280`. V1 never sets `toolChoice: "none"` on the last step (that is the core-runner path; research.md's claim corrected here). |
| Todo state queryable, not wired | `packages/opencode/src/session/todo.ts` | `Todo.Service.get(sessionID)` reads `TodoTable`, returns `{content, status, priority}[]`; statuses `pending \| in_progress \| completed \| cancelled` (`packages/schema/src/session-todo.ts:9-10`). Pending-work signal IS cleanly available, BUT `Todo.Service` is NOT imported/provided in `prompt.ts` — wiring is a normative requirement (§5.2). |
| Event conventions | `packages/schema/src/session-event.ts:65-78` | `ModelSwitched` = typed event with optional `source/from/reason/attempts` — template for the new recovery event. |
| Event-manifest tests | `packages/schema/test/event-manifest.test.ts`, `packages/opencode/test/event-manifest.test.ts` | Schema test asserts `ServerDefinitions.length === 55`, `Definitions.length === 85`, `Latest.size === 85`, `Durable.size === 32`. The opencode test asserts `Latest === 90` and identity-asserts the rest against the schema manifest (NOT mirrored counts). New events require bumping schema counts to 56/86/86/33 and opencode `Latest` to 91 in the same change (§8). |

## 4. L0 — Prevention (config plumbing + vLLM recipe)

### L0.1 Request-parameter delivery (per-field, per-path)

Requirement: `presence_penalty`, `frequency_penalty`, `top_k`, `min_p`, and arbitrary extra body fields configured per model (`model.options`) or per agent (`agent.options`) MUST reach the HTTP JSON body of a vLLM OpenAI-compatible endpoint verbatim.

Review-verified delivery state (source-cited; supersedes the earlier "byte-level pass-through unverified" blanket statement):

| Field | Verified status | Gap to close |
|---|---|---|
| `presence_penalty` / `frequency_penalty` | EMITTED on the AI SDK openai-chat path (`packages/llm/src/protocols/openai-chat.ts:364-365`). Native path: `RequestInput`/`generation()` lack penalties. | Regression-assert on the openai-chat path; close the native gap only if the native path serves the local vLLM provider (path scoping below). |
| `top_k` | NOT emitted AND on `PROTOCOL_BODY_OVERLAY_DENYLIST`. | Needs an explicit delivery mechanism (typed option or sanctioned extra-body) plus a denylist exemption for this provider. |
| `min_p` | Absent from `GenerationOptions` — no typed carrier. | Needs a typed option or extra-body support. |
| `thinking_token_budget`, `repetition_detection` (arbitrary extra body) | Pass-through unverified on either path. | A1 per-field capture test decides; if dropped, add explicit extra-body support for OpenAI-compatible providers (smallest additive change; document the key path in the recipe doc). |

Path scoping (normative, first implementation task): determine which request path — AI SDK openai-chat protocol vs native `RequestInput`/`generation()` — serves the local vLLM provider. A1 capture tests (§9) target the live path per field; the inactive path's gaps are documented, not closed, in v1.

Deliverable includes a documented, working `opencode.json` provider/model example for the local vLLM Qwen model carrying the full sampling preset + penalties + vLLM extra fields (`thinking_token_budget`, `repetition_detection`).

Evidence: §3 penalty/sampling emission row (source-verified); research-2 (§Deliverable (a) field-support matrix: vLLM accepts `top_k`/`min_p` via `extra_body`, penalties natively; no DRY — issue #8581); research-3 (vLLM `RepetitionDetectionParams`, `thinking_token_budget` are request-level fields on the OpenAI-compatible server).

### L0.2 `transform.ts` qwen defaults — decision: DO NOT change

`ProviderTransform.temperature()`/`topP()` match every model id containing `"qwen"`, including hosted qwen providers (e.g. `qwen-plus`). Changing these globals would silently alter hosted-provider behavior — **forbidden constraint**.

Instead:

- The Qwen thinking-coding preset (temp 0.6, top_p 0.95, top_k 20, min_p 0 — official card, research-2 Recommendations Stage 1) is applied via per-model config for the local vLLM model only (L0.1 plumbing).
- Requirement: per-model/per-agent sampling overrides MUST take precedence over `transform.ts` defaults. `request.ts:123-127` computes `temperature` as `agent.temperature ?? transform default` — whether `model.options.temperature` wins downstream is unverified (OPEN-2). If it does not, close the gap (model-level sampling override) as part of L0; regression-test that hosted qwen defaults are unchanged.
- `presence_penalty` is the sanctioned anti-loop dial: start 0.5, raise toward 1.5 if loops persist (Qwen official; 1.5 strongly recommended for quantized/FP8 — research-2 §Recommendations, research-3 §Recovery ladder rung 2). `repetition_penalty` stays 1.0 (harms code, can itself cause loops — research-2 lever #10).

### L0.3 vLLM server recipe — docs deliverable

New file `docs/fork/qwen-vllm-recipe.md` (+ FORK_CHANGES.md entry). Content requirements (all vLLM-only per UC1; cite research-2/research-3):

| Item | Value | Evidence |
|---|---|---|
| Reasoning parser | `--reasoning-parser qwen3` (separates `reasoning_content` from `content`) | research-3 §vLLM streaming reasoning channel |
| Thinking budget | `thinking_token_budget ≈ 4096` for agentic/tool tasks (forces `</think>`; PR #20859); caveat: NOT enforced under MTP speculative decoding (#39573); needs `--reasoning-config` | research-2 Stage 3; research-3 Key Finding 3 |
| Repetition detection | `repetition_detection` request field: `min_pattern_size=1, max_pattern_size≈40, min_count=4` (scheduler stop → `FINISHED_REPETITION`) | research-3 §Native vLLM primitives |
| Sampling preset | temp 0.6, top_p 0.95, top_k 20, min_p 0, presence_penalty 0.5→1.5, frequency_penalty 0–0.3 optional, repetition_penalty 1.0, never greedy | research-2 TL;DR + Stage 1/2 |
| Serving pitfalls | KV cache q8_0 or unquantized (never q4); weight quant ≥4-bit; YaRN off unless >32K context; vLLM ≥0.21.0 (spec-decode budget enforcement) | research-2 §5 |
| Harness cap note | `OUTPUT_TOKEN_MAX = 32_000` (`transform.ts:18`, env override `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`) — why `finish: "length"` occurs | research-1 (opencode section) |

## 5. L1 — Recovery (session-loop, config-gated)

### 5.0 Placement and shared state model

Per UC3: implemented in the V1 session loop (`packages/opencode/src/session/prompt.ts` `runLoop`), additive and isolated (new module, e.g. `packages/opencode/src/session/stop-recovery.ts`, with pure trigger/counter functions for unit testing; wiring at the loop's turn-end decision point). The V1 loop is confirmed as the LIVE session path (§3 live-path row; OPEN-4 resolved).

Interception point (plan-phase source verification, 2026-07-01 — supersedes the review's "inner break" phrasing): the WOULD-BE-EXIT point, inside the outer exit-guard block (`prompt.ts:1111-1130`) immediately before `break`. Finished turns (`finish: "stop"`/`"length"`) reach termination ONLY through this path: the processor returns `"continue"` for them (`processor.ts:677-679`), the step gen returns outcome `"continue"` (`prompt.ts:1328`), and the NEXT loop iteration's exit guard performs the actual `break`. The inner `outcome === "break"` returns cover only structured-output (`:1291`), content-filter (`:1306`), json_schema-error (`:1314`), and blocked/error (`:1318`) turns — all excluded from recovery, so intercepting there would never see a normal turn end. Recovery therefore evaluates exactly once per would-be turn end, inside the guard block: if it injects, the loop `continue`s instead of breaking; on the next iteration the injected synthetic user message is `lastUser` (`MessageV2.latest()` has no synthetic exclusion), the guard comparison `lastUser.id < lastAssistant.id` is false, and the loop processes the injected message. This placement satisfies every §5.0 normative requirement (single evaluation per would-be end, natural re-entry, `lastUser` mechanics) — only the review's location label was wrong.

Injection mechanism (review-corrected): DIRECT message insertion into session storage, the compaction-continuation pattern (`compaction.ts:489-515`). `prompt.ts` never publishes `session.next.synthetic`; there is no event-based injection path from loop code. The injected user message MUST:

- copy `agent`, `model` (providerID/modelID), and output `format` from the anchor real user message, with correct `parentID` linkage — the next iteration derives model/agent/parentID from `lastUser` (`prompt.ts:1141, 1170, 1188`);
- re-resolve the CURRENT session model instead of blind-copying when the fallback-takeover feature coexists (a takeover may have switched the session model mid-turn);
- never carry `ignored: true` (an ignored message would corrupt `lastUser` semantics);
- carry the §6 marker metadata.

State (in-memory, per active `runLoop` invocation; NOT persisted):

| Field | Meaning |
|---|---|
| `turnKey` | id of the anchor REAL user message: walk back past ANY user message whose text parts carry `synthetic: true` (generic predicate — not an enumerated marker list; robust to future synthetic families). All counters are keyed to this. |
| `lengthContinues` | count of length auto-continues injected for this `turnKey`. |
| `noProgressCount` | shared counter for no-tool nudge + empty-after-thinking (same failure family). |
| `graceUsed` | whether the one silent grace retry has been consumed for this `turnKey`. |

Reset rules (normative):

| Event | Effect |
|---|---|
| New REAL user prompt (non-synthetic user message) | all counters reset (new `turnKey`). Reset placement: evaluated at the top of each outer loop iteration, when the resolved real-user anchor differs from the stored `turnKey`. |
| Queued prompt processed by the loop | it is a real user message → new `turnKey`, full reset. |
| Abort / interrupt | state discarded; nothing injected. |
| Tool call executed in a subsequent step (`hasToolCalls` true on a later assistant message) | `noProgressCount` and `graceUsed` reset (genuine progress). `lengthContinues` does NOT reset (bounds context bloat per truncated turn). Gaming exposure: a trivial/no-op tool call also resets — see R13. |
| Empty-after-thinking trigger resolved by non-empty final text | counts as progress for that trigger (turn ends normally). |
| Synthetic recovery/compaction continue message | does NOT reset anything (explicitly excluded from "new user prompt" detection by the generic synthetic predicate). |
| Compaction (summary + continuation injection) | does NOT reset counters — the real-user anchor is unchanged. |
| Anchor pruned (walk-back finds no real user message, e.g. after compaction pruning) | keep the current in-memory state, keyed to the `runLoop` invocation itself; no reset, no re-key churn. State is per-invocation anyway. |
| Config/agent disable observed mid-sequence | no further injections from that point; already-injected messages stand; nothing retroactive. |
| Process restart / session resume mid-turn | state starts fresh (caps re-arm). Accepted bounded risk: worst case one extra cap's worth of attempts after a crash. |

### 5.1 Length auto-continue

| Aspect | Specification |
|---|---|
| Trigger | Assistant message `finish === "length"` AND turn would otherwise end AND NOT reasoning-only (routing row below) AND `lengthContinues < max` AND step-eligible (§5.5) AND feature+component enabled. |
| Action (1) discard | Non-execution is ALREADY guaranteed by the processor: `Effect.ensuring` cleanup transitions pending tool calls to `error` + `interrupted: true` on ALL exits (`processor.ts:575-591`) — a truncated tool call cannot execute today. Recovery does not re-implement this guarantee; it ADDS `{ truncated: true }` metadata to such parts for telemetry/history clarity, and regression-asserts that provider-facing history conversion presents no in-flight call (orphaned-interrupted-tool handling, `prompt.ts:1108, 1117-1127`). Covers both shapes: a materialized pending part, and no part at all (OPEN-3, narrowed — fixture is a plan-phase obligation, §11.2). |
| Action (2) inject | Synthetic user message inserted DIRECTLY per the §5.0 mechanism (compaction-style; no event round-trip). Default text `"Continue where you left off."` (config-overridable), part fields: `synthetic: true`, `metadata: { stop_recovery_continue: true, stop_recovery: { trigger: "length", attempt: <n> } }` — sibling of `compaction_continue`. Loop re-enters via the §5.0 `lastUser` mechanics. |
| Reasoning-only routing | If `finish === "length"` AND joined text (text parts only) `trim() === ""` AND reasoning present: do NOT inject the plain continue — it would resume the thinking loop, and prior reasoning IS replayed client-side (`message-v2.ts:362-376`; template-side replay is OPEN-7). Route to the §5.3 nudge family instead, tagged `reasoning_only: true` (marker metadata + event field); counts against `noProgressCount` (grace rules apply), NOT `lengthContinues`. |
| Bound | `max` default **3** per real user turn (evidence: near-universal convergence on 3 — research-1 Key Finding 3; recommended 2–3 for length continuation — research-1 Recommendation 1). Range 0–5; 0 disables. Also bounded by the remaining step budget (§5.5). On exhaustion: no injection, turn ends normally (finish stays `"length"`), telemetry `halt` event with `trigger: "length"`. |
| Compaction exclusion | Messages carrying `stop_recovery_continue` MUST be excluded wherever `isCompactionContinuation` is consulted: turn accounting (`compaction.ts:100`) and overflow replay selection (`compaction.ts:325,336`). New predicate `isStopRecoveryContinuation` alongside, or a shared `isSyntheticContinuation`. |
| Counting | Length continues do NOT count toward `noProgressCount` (distinct failure family; research-1 Key Finding 1: truncation and premature stop need opposite fixes). |
| Rendering | Visible + muted + marked automated (UC4, §6). |

### 5.2 No-tool-use nudge

| Aspect | Specification |
|---|---|
| Trigger | Turn would otherwise end AND normal stop — defined exactly as `finish === "stop"` AND no `error` set on the assistant message (not `"length"`, `"tool-calls"`, `"unknown"`, `"content_filter"`) — AND no tool parts of ANY kind on the message: `hasToolCalls === false` (the boolean, §5.4) AND no provider-executed tool parts (provider-executed tools count as progress and suppress the nudge) AND joined text (text parts only) non-empty AND **work pending** AND step-eligible (§5.5) AND feature+component enabled. |
| Work-pending signal | Deterministic: `Todo.Service.get(sessionID)` contains ≥1 todo with status `"pending"` or `"in_progress"` (verified queryable, §3). No LLM judgment. Known false negative: pending work without todos → no nudge (accepted; deterministic-only per research-1 Key Finding 2). |
| Wiring (normative) | `Todo.Service` is NOT currently imported/provided in `prompt.ts` (§3). Implementation MUST provide `Todo.Service` in the loop's service context — without this wiring the trigger is dead code. Stale-todo storm risk: R12. |
| Action | Inject synthetic nudge (Cline/Roo lineage) via the §5.0 direct-insertion mechanism. Default text (config-overridable): `[ERROR] You did not use a tool in your previous response. If work remains, retry with a tool use; if the task is complete, state so explicitly and update the todo list. (This is an automated message; do not respond to it conversationally.)` Same part marker family: `metadata: { stop_recovery_continue: true, stop_recovery: { trigger: "no_tool", attempt: <n>, grace: <bool> } }`. |
| Grace retry | First occurrence per `turnKey`: nudge injected WITHOUT incrementing `noProgressCount` (`graceUsed = true`). "Silent" means it does not count toward the limit and raises no error status — the message itself is still visible-muted-automated (UC4 forbids hidden injections; this reconciles Roo PR #10196 grace semantics with UC4). Evidence: research-1 (Roo §, Recommendation 2). |
| Bound | Subsequent occurrences increment `noProgressCount`. Limit default **3** (`0` = unlimited, Roo parity — research-1 Roo §). At limit: NO injection; hard stop — set assistant message error (new named error, e.g. `SessionV1.StopRecoveryError { trigger, attempts, limit }`, following the content-filter precedent `prompt.ts:1300-1306`), publish `Session.Event.Error`, emit `halt` telemetry event. User-facing status text pattern: `Stop recovery: model repeatedly ended its turn without tool use (limit 3).` |
| Reset | Executed tool call on a later step resets `noProgressCount` + `graceUsed` (§5.0). |

### 5.3 Empty-after-thinking

| Aspect | Specification |
|---|---|
| Trigger | Turn would otherwise end AND finish gate passes (row below) AND no tool parts of any kind (`hasToolCalls === false`, no provider-executed parts) AND joined assistant text (text parts only) `trim() === ""` AND reasoning present (≥1 reasoning part on the message, OR `tokens.reasoning > 0`) AND step-eligible (§5.5) AND feature+component enabled. NO pending-work check (the trigger is deterministic by itself — research.md L1 item 3). |
| Finish gate | Fires on `finish === "stop"` (normal empty turn), or `finish === "length"` routed here by the §5.1 reasoning-only rule (tagged `reasoning_only: true`). `finish === "unknown"` NEVER triggers injection — unknown-finish ends are telemetry-only (`observed`, §5.6). |
| Action | Same nudge path, shared `noProgressCount` and grace semantics as §5.2. Default text (config-overridable): `Your previous response contained only internal reasoning with no visible answer or tool call. Provide your answer or the next tool call. (This is an automated message; do not respond to it conversationally.)` Marker `trigger: "empty_after_thinking"`. |
| Note | This is the expected harness-side complement to vLLM `thinking_token_budget` forcing `</think>`: a budget-forced turn that produced no content lands exactly here — intended interplay (§5.6 budget-close row). |

### 5.4 Finish-reason robustness

All L1 trigger evaluation MUST gate on the tool-call presence boolean (`hasToolCalls`, computed as at `prompt.ts:1106-1109`) alongside the finish string — never on the finish string alone. Local OpenAI-compatible providers lie (`stop`/`unknown` with tool calls present; empty `tool_calls: []` — research-1 Key Findings, opencode issues #14972/#19339/#20719/#4255). Consequences:

- If `hasToolCalls` is true, no L1 trigger fires (the existing loop continues to run tools — current guard preserved).
- `finish === "unknown"` is not an injection trigger (inner `finished` check already treats it as non-terminal at `prompt.ts:1294`; the outer/inner asymmetry is documented in §3 and §5.6 — recovery must not change either existing check's semantics when the flag is off). Unknown-finish turn ends emit the telemetry-only `observed` event (§5.6, §8).
- The recovery decision point runs strictly after the existing guards, so it can never convert a tool-running turn into a nudge.

### 5.5 Interaction constraints (normative)

| Constraint | Rule |
|---|---|
| Step eligibility (OPEN-6 resolved) | Every recovery injection consumes a loop step (`step++` at `prompt.ts:1132`). NO recovery injection — any trigger family, length-continue included — when `step + 1 >= (agent.steps ?? Infinity)`: recovery must not push the loop into the `isLastStep`/`MAX_STEPS_PROMPT` regime (`prompt.ts:1178-1179`, `:1280`). Corollary: §5.1/§5.2/§5.3 never fire on the turn produced by the `MAX_STEPS_PROMPT` demand itself (the harness demanded a text-only, no-tool reply). |
| Doom-loop guard | Recovery injects user-role text, never tool calls, so it cannot structurally trip `doom_loop` (which requires 3 identical tool parts). Rules: (a) recovery MUST NOT inject while a `doom_loop` permission ask is pending/unanswered (enforcement mechanism is a plan-phase decision, §11.2 F14); (b) recovery never bypasses or auto-answers permission asks; (c) if post-nudge tool calls trip the doom-loop guard, the doom-loop flow wins (recovery yields — it only acts at turn end). |
| Compaction | If the loop iteration ends in a compaction task or a compaction continuation was just injected, recovery yields. At most ONE synthetic continuation (of any kind) is injected per loop iteration; compaction has priority. |
| Sub-sessions / agents | Per-agent disable (`stopRecovery: false` in agent config, §7). Subtask/child sessions evaluate their own agent's setting. Compaction/title/summary internal agents: always disabled. |
| Structured output (`format.type === "json_schema"`) | Recovery disabled for these turns — the loop already has its own error path (`prompt.ts:1308-1315`). |
| Abort | Abort during a recovery-injected turn behaves exactly like any user abort; no re-injection after abort. |
| Bound by construction | Effective max synthetic injections per real user turn = min(`lengthContinue.max` + 1 (grace) + `noToolNudge.limit`, remaining step budget). All defaults finite; `limit: 0` (unlimited) is an explicit user opt-in with a documented infinite-cycle risk (§10-R8), still bounded by `agent.steps`. |

### 5.6 Loop end-state matrix & finish mapping

How each server-side end cause reaches the loop, what happens today, and what L1 v1 does (source-verified; `mapFinishReason` at `packages/llm/src/protocols/openai-chat.ts:378-384` maps stop/length/content_filter/function_call|tool_calls and everything else to `"unknown"`):

| End cause (server side) | Wire `finish_reason` | Client mapping | Behavior today | L1 v1 routing |
|---|---|---|---|---|
| vLLM repetition kill (`repetition_detection` → `FINISHED_REPETITION`) | non-standard string (raw value unknown — Phase-0 capture, §11.2) | `"unknown"` | Silent end: processor returns "continue" (`processor.ts:677-679`); `finished` excludes unknown (`prompt.ts:1294`); next-iteration outer guard breaks. | NO injection. Telemetry-only `observed` event (§8) at the unknown-finish turn end. |
| vLLM thinking-budget close (`thinking_token_budget` forces `</think>`) | `stop` | `"stop"` | Normal turn end. | §5.3 if text empty + reasoning present; §5.2 if text non-empty + todos pending. |
| Harness output cap (`OUTPUT_TOKEN_MAX`) | `length` | `"length"` | Turn ends silently (`"length"` counts as finished, `prompt.ts:1294`). | §5.1 continue; §5.3 family with `reasoning_only: true` if text empty + reasoning present. |

Finish-mapping requirement and trade-off:

- v1 requirement: emit the telemetry-only `observed` event when an unknown-finish turn ends (no injection, no behavior change). This makes repetition kills countable for the L2 go/no-go decision.
- Follow-up option (deferred): fork-side `mapFinishReason` extension mapping the raw vLLM repetition-stop string to an actionable finish reason, IF Phase-0 capture + telemetry show repetition kills are frequent.
- Trade-off: the mapper extension makes repetition kills actionable L1 triggers but adds a fork diff inside `packages/llm` protocol code (upstream merge surface); observed-only is zero-behavior-change but repetition-killed turns still end silently for the user (visible only in telemetry).

## 6. Synthetic message contract & rendering (UC4)

- Marker: text part `synthetic: true`, `metadata.stop_recovery_continue: true`, `metadata.stop_recovery: { trigger: "length" | "no_tool" | "empty_after_thinking", attempt: number, grace?: boolean, reasoning_only?: boolean }`. Sibling convention of `compaction_continue` (`compaction.ts:504-515`), same "internal marker, not a stable plugin contract" caveat comment.
- Emission: direct insertion into session storage (§5.0). No `session.next.synthetic` / `tui.prompt.synthetic` event round-trip — `prompt.ts` never publishes those events (§3).
- TUI rendering: `visible-user-text.ts` currently hides synthetic parts unless `metadata.opencodeMcpVisible === true`. Requirement: extend `isVisibleUserTextPart` so parts with `stop_recovery_continue === true` are also visible; they render `muted: true` (existing behavior for synthetic parts) with an automated-source header via the `mcpCallerHeader`-style mechanism, e.g. `◇ auto · stop recovery (length 1/3)`. Exact strings are plan-level; requirements: visibly muted, explicitly identifies automation, identifies trigger and attempt/cap.
- Non-TUI surfaces (documented v1 exclusion): web/app clients filter synthetic user parts (`packages/session-ui/src/components/message-part.tsx:1128`) — recovery messages are invisible on those surfaces in v1; auto-continues are effectively hidden there. This exclusion is documented and routed for human confirmation against UC4's "no hidden auto-continues" intent (§11.1, F16). Headless/API consumers: the `session.next.stop_recovery` events + server log are the observability fallback. Session shares include recovery messages (the share payload carries the raw messages).
- Provider-facing: the message IS sent to the model (it is the nudge). Only compaction/turn-accounting treats it specially (§5.1).

## 7. Config schema sketch

Root config (v1 `packages/core/src/v1/config/config.ts` + v2 migration, following the compaction root keys and fork feature (6) `fallback` precedent of v1 AgentSchema + `KNOWN_KEYS` + `migrate.ts`):

```jsonc
{
  "stopRecovery": {
    "enabled": false,                    // master opt-in; default false (UC3)
    "lengthContinue": {
      "enabled": true,                   // effective only when stopRecovery.enabled
      "max": 3,                          // per real user turn; 0 disables; range 0-5
      "text": "Continue where you left off."          // optional override
    },
    "noToolNudge": {
      "enabled": true,
      "graceRetry": true,                // first nudge does not count toward limit
      "limit": 3,                        // consecutive mistakes; 0 = unlimited (Roo parity)
      "text": "..."                      // optional override (default in §5.2)
    },
    "emptyAfterThinking": {
      "enabled": true,
      "text": "..."                      // optional override (default in §5.3)
    }
  }
}
```

Agent-level: `stopRecovery?: boolean` (disable per agent; default inherits root). Added to v1 `AgentSchema` + `KNOWN_KEYS` (`packages/core/src/v1/config/agent.ts`) and carried through `migrate.ts`, exactly like `fallback`.

Semantics: master `enabled: false` → all components dead, zero behavior change. Component `enabled` flags allow enabling e.g. only length-continue. Text overrides never change marker metadata.

## 8. Events & telemetry

New public session event following the `ModelSwitched` convention (`session-event.ts:65-78`):

```
SessionEvent.StopRecovery — type: "session.next.stop_recovery"
schema: {
  ...Base,
  messageID: SessionMessage.ID,          // the assistant message that triggered
  trigger:  "length" | "no_tool" | "empty_after_thinking" | "unknown_finish",
  action:   "continue" | "nudge_grace" | "nudge" | "halt" | "observed",
  attempt:  number,                      // 1-based within turnKey (0 for halt-without-injection and observed)
  limit:    number,                      // effective cap for this action family (0 for observed)
  reasoning_only: optional boolean,      // §5.1 reasoning-only routing tag
  tokens:   optional (token stats),      // usage snapshot of the triggering assistant message
  cost:     optional number,             // cost snapshot of the triggering assistant message
  agent:    optional string
}
```

- One event per recovery decision (including the terminal `halt` — both cap-exhausted length and mistake-limit stops), plus `observed` for every unknown-finish turn end while the master flag is on (§5.6): telemetry-only, no injection, no behavior change.
- Usage roll-up: recovery creates no separate accounting ledger. Each continued step produces a normal assistant message whose tokens/cost roll into existing session/message usage totals; the event's `tokens`/`cost` fields snapshot the triggering assistant message so recovery overhead is quantifiable from telemetry alone.
- Durable: yes (incidents must survive reload and be countable for the L2 go/no-go decision, UC2 implication).
- Modification targets: event definition in `packages/schema/src/session-event.ts` (`ModelSwitched` convention); registration in `Definitions`, `DurableDefinitions`, and the `Durable` union.
- Manifest impact (must change in the same commit): `packages/schema/test/event-manifest.test.ts` — `ServerDefinitions` 55→56, `Definitions` 85→86, `Latest` 85→86, `Durable` 32→33. `packages/opencode/test/event-manifest.test.ts` — `Latest` 90→91 only; its remaining assertions identity-assert against the schema manifest and need no count edits (they are NOT mirrored counts). These counts are merge magnets → FORK_CHANGES.md entry required (UC3 implication).
- SDK regeneration is part of the same change: run `bun ./packages/sdk/js/script/build.ts`; the generated `SessionDurableEvent` union must include the new event.
- Hard stop additionally surfaces via `Session.Event.Error` with the new named error (§5.2) — same user-facing path as content-filter errors.
- TUI surfacing: the synthetic message itself is the primary visible artifact (UC4); the `halt` case shows the error status. No new TUI chrome required in v1 beyond §6 rendering.

## 9. Acceptance criteria

### L0

- A1. Per-field, per-path capture test (mock HTTP/fetch at the provider boundary of the LIVE request path for the local vLLM provider — path scoping per §L0.1): (a) `presence_penalty`/`frequency_penalty` present in the outgoing body (regression on the openai-chat path where they are already emitted, `openai-chat.ts:364-365`; gap-closure on the native path if that path is live — `RequestInput`/`generation()` lack penalties); (b) `top_k` present after closing its gap (currently not emitted + on `PROTOCOL_BODY_OVERLAY_DENYLIST`); (c) `min_p` present after closing its gap (currently absent from `GenerationOptions`); (d) `thinking_token_budget` and `repetition_detection` pass through verbatim; (e) merge precedence base < model < agent < variant per `request.ts:91`, asserted for both `model.options` and `agent.options`.
- A2. Precedence: model-level `temperature`/`top_p` for the local model override `transform.ts` qwen defaults in the outgoing request (close OPEN-2 if currently false).
- A3. Hosted regression: `ProviderTransform.temperature()` returns 0.55 and `topP()` returns 1 for hosted qwen ids, unchanged; no request-shape diff for any non-configured provider.
- A4. `docs/fork/qwen-vllm-recipe.md` exists with every §L0.3 row + a working `opencode.json` example; FORK_CHANGES.md entry present.

### L1 — length auto-continue

- B1. `finish === "length"`, flag on → synthetic continue with correct marker inserted directly (§5.0), loop re-enters; at most `max` per real user turn; attempt `max+1` not injected, turn ends with `finish: "length"` and a `halt` event.
- B2. A pending/truncated tool part on the length-finished message carries `error` + `interrupted: true` via the existing cleanup (regression assert on `processor.ts:575-591` behavior) plus recovery's `{ truncated: true }` metadata; provider-facing history contains no in-flight call for it.
- B3. `isStopRecoveryContinuation` messages are excluded from compaction `turns()` and overflow replay selection (unit tests at the `compaction.ts` seams).
- B4. Flag off (default) → `finish === "length"` behaves exactly as today (silent turn end).
- B5. Counter is keyed to the real user turn: a chain continue→length→continue counts 2; a new real user prompt resets.
- B6. Reasoning-only routing: `length` + empty text (text parts only) + reasoning present → NO plain continue; §5.3-family nudge with `reasoning_only: true` in marker and event; `lengthContinues` unchanged; `noProgressCount`/grace semantics apply.
- B7. Injected message carries copied `agent`/`model`/`format` and correct `parentID` from the anchor real user message; with a coexisting model takeover, the CURRENT session model is re-resolved; the message never has `ignored: true`.

### L1 — nudge family

- C1. `stop` + non-empty text + `hasToolCalls === false` + no provider-executed tool parts + ≥1 pending/in_progress todo → grace nudge injected (event `action: "nudge_grace"`, counter unchanged), rendered visible+muted+automated.
- C2. Repeat without progress → `noProgressCount` 1…limit; at limit: no injection, `StopRecoveryError` set, `Session.Event.Error` published, `halt` event emitted.
- C3. No pending todos (empty, all completed, or all cancelled) → no nudge.
- C4. Executed tool call after a nudge resets `noProgressCount` and `graceUsed`.
- C5. Step-ineligible turns never trigger ANY family: no injection when `step + 1 >= (agent.steps ?? Infinity)`; no trigger on the `MAX_STEPS_PROMPT` turn; length-continue equally suppressed (§5.5 step-eligibility rule).
- C6. Empty-after-thinking: finished + `text.trim()===""` (text parts only) + reasoning present → nudge regardless of todo state; non-empty text next step ends the turn normally.
- C7. `finish === "unknown"` or `hasToolCalls === true` or provider-executed tool parts present → no injection trigger fires.
- C8. Agent with `stopRecovery: false` (and compaction/title/summary agents) → no triggers.
- C9. Pending `doom_loop` permission ask → recovery yields (no injection).
- C10. `limit: 0` → nudges continue without hard stop (documented opt-in), still bounded by the step budget.

### L1 — interaction & negative cases

- E1. Master-off negative: `stopRecovery.enabled: false` with all component flags `true` → zero injections, zero `stop_recovery` events (including `observed`), request/history byte-identical to baseline.
- E2. Structured-output exclusion: `format.type === "json_schema"` turns never trigger any family.
- E3. Compaction priority / single injection: an iteration ending in compaction or a just-injected compaction continuation → recovery yields; at most ONE synthetic continuation of any kind per loop iteration.
- E4. Abort: abort during a recovery-injected turn → no re-injection after the abort.
- E5. `graceRetry: false` → the first nudge increments `noProgressCount` immediately (no free retry); event `action: "nudge"`.
- E6. `lengthContinue.max: 0` → length family disabled: no injection, turn ends as today.
- E7. Shared counter: alternating `no_tool` and `empty_after_thinking` triggers increment the SAME `noProgressCount` and reach the shared limit together.
- E8. Step eligibility boundary: with `agent.steps = N` and `step = N-1`, no recovery injection of any family; effective bound = min(config caps, remaining steps).
- E9. Observed-on-unknown: an unknown-finish turn end with the master flag on emits exactly one `observed` event (`trigger: "unknown_finish"`, no injection, loop behavior unchanged); flag off → no event.

### Events / config / hygiene

- D1. Schema manifest counts updated (`ServerDefinitions` 56, `Definitions` 86, `Latest` 86, `Durable` 33) and opencode manifest `Latest` 91 (identity assertions untouched); event registered in `Definitions`/`DurableDefinitions`/`Durable` union; event round-trips through the EventV2 bridge; durable-set membership asserted; SDK regenerated via `bun ./packages/sdk/js/script/build.ts` with `SessionDurableEvent` including the new event.
- D2. Config: schema accepts the §7 shape; v1→v2 migration carries `stopRecovery`; agent `KNOWN_KEYS` updated; defaults snapshot unchanged when the key is absent.
- D3. Zero-behavior-change: with default config the full existing test suite passes unmodified (except manifest-count updates).
- D4. All package validation commands run from package directories, never repo root (fork convention).

## 10. Test strategy sketch

- **Pure-unit layer**: extract trigger predicates + counter state machine into `stop-recovery.ts` pure functions (`evaluate(state, turnFacts) → { action, nextState }`); table-driven tests for every trigger/reset/cap row in §5.0–5.6 without provider streams.
- **Loop integration**: mocked processor handle producing scripted `finish`/parts sequences; assert directly-inserted synthetic messages, markers, copied `agent`/`model`/`format`/`parentID` fields, events, and hard-stop error (pattern: existing session tests in `packages/opencode/test`).
- **Compaction seam**: extend existing compaction tests for the new exclusion predicate (B3).
- **Request capture (L0)**: fake fetch on the live provider path (path scoping per §L0.1; native configure path seam at `native-request.ts:156-177`) asserting per-field body keys (A1–A3).
- **Event manifest**: schema count bumps + opencode `Latest` bump + definition identity (D1) — the schema manifest test asserts exact counts and the opencode test identity-asserts against it, so any new event is a deliberate two-file change plus SDK regen.
- **TUI**: unit test on `visibleUserTextParts` for the new marker (visible, muted, header present).

### 10.1 Staged validation (rollout gates)

| Phase | Gate to enter | Content |
|---|---|---|
| 0 — Baseline | none | Flag off. Capture raw vLLM `finish_reason` strings (including the repetition-stop string — plan obligation, §11.2), loop/truncation incidence, wasted-token profile. Comparison base for everything after. |
| 1 — L0 only | Phase 0 data recorded | Sampling preset + penalties + server recipe live; L1 off. Measure loop-incidence delta vs Phase 0. |
| 2 — L1 per component | Phase 1 stable | Enable `lengthContinue` alone → observe; then the nudge family (`noToolNudge`, `emptyAfterThinking`). Watch R7 (conversational nudge replies) and R12 (stale-todo storms) in telemetry. |
| 3 — L2 go/no-go | Phase 2 telemetry over an agreed window | UC2 implication: revisit L2 only if `stop_recovery`/`observed` telemetry shows loops surviving L0+L1. |

## 11. Risks & open questions

| ID | Status | Item |
|---|---|---|
| OPEN-1 | REWRITTEN (known-gap matrix) | The blanket "byte-level pass-through unverified" is superseded by the per-field/per-path matrix (§L0.1): penalties EMITTED on the AI SDK openai-chat path (`openai-chat.ts:364-365`) but absent from native `RequestInput`/`generation()`; `min_p` absent from `GenerationOptions`; `top_k` not emitted AND on `PROTOCOL_BODY_OVERLAY_DENYLIST`; arbitrary extra-body keys unverified per path. Closure = path scoping + A1 per-field capture tests; explicit extra-body support if keys are dropped. |
| OPEN-2 | OPEN | Precedence of `model.options.temperature`/`top_p` over `agent.temperature ?? transform default` (`request.ts:123-127`) unverified end-to-end. Requirement A2 forces resolution. |
| OPEN-3 | NARROWED | Execution risk is eliminated: existing cleanup transitions pending tool calls to `error` + `interrupted: true` on ALL exits (`processor.ts:575-591` via `Effect.ensuring`) — truncated calls cannot execute today. Remaining question is only whether a mid-call `length` truncation materializes a `pending` part or no part at all (upstream #18108 shape); §5.1 covers both, recovery adds `truncated: true` metadata only. Fixture for the no-part shape is a plan-phase obligation (§11.2). |
| OPEN-4 | RESOLVED | The live session path IS the V1 `SessionPrompt.loop`: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:11, 289, 298-302` imports `SessionPrompt` and drives sessions via `promptSvc.prompt()` + `loop()`; server deps include `SessionPrompt.node`. The core `SessionRunner` is NOT the live path. This spec targets the correct layer. The resulting conflict with the sibling `30-06-2026_fallback-takeover` spec (which targets the core runner) is routed to the human — §11.1, F1. |
| OPEN-5 | RESOLVED | No event machinery exists for loop-side injection: `prompt.ts` never publishes `session.next.synthetic`. Injection is DIRECT message insertion at the inner `outcome === "break"` path, compaction-style (`compaction.ts:489-515`) — §5.0. |
| OPEN-6 | RESOLVED | Step-eligibility rule (§5.5): recovery never injects — any family, length-continue included — when `step + 1 >= (agent.steps ?? Infinity)`; recovery consumes steps (`step++` at `prompt.ts:1132`) and must not push the loop into the `MAX_STEPS_PROMPT` regime. |
| OPEN-7 | OPEN (added by review) | Whether the vLLM Qwen chat template replays prior-turn reasoning into the rendered prompt is UNVERIFIED. Client-side serialization is confirmed: `toModelMessagesEffect` serializes reasoning parts into outgoing messages (`message-v2.ts:362-376`); native path too. Affects §5.1 reasoning-only routing efficacy; verification is a plan-phase obligation (§11.2). |
| R7 | risk | Nudge-loop: Qwen may reply conversationally to the nudge ("I already finished"). Mitigation tunables per research-1 thresholds: set `graceRetry: false`, lower `limit` to 2, strengthen nudge text. Telemetry (§8) makes this visible. |
| R8 | risk | `limit: 0` (unlimited, Roo parity) permits infinite nudge cycles by explicit user opt-in. Documented; default remains 3; step budget still bounds it. |
| R9 | risk | Event-manifest count assertions and `visible-user-text.ts` are upstream-merge magnets; FORK_CHANGES.md entry with future-merge recipe is mandatory (UC3). |
| R10 | risk | `thinking_token_budget` unenforced under MTP speculative decoding (#39573) — recipe carries the caveat; harness-side §5.3 is the backstop. |
| R11 | risk | Todo-based pending-work signal has false negatives (no todos written). Accepted for v1 determinism; telemetry will show `no_tool` triggers vs. silent incompletions for later tuning. |
| R12 | risk | Stale-todo nudge storm: todos that are never updated keep the pending-work signal true, so every normal-stop turn nudges up to the limit on every real user turn. Bounded per turn by `noToolNudge.limit` + grace; visible in telemetry (`no_tool` volume); mitigations: nudge text instructs updating the todo list (§5.2), tune `limit`/`graceRetry`. |
| R13 | risk | Counter gaming: an executed tool call resets `noProgressCount` + `graceUsed` (§5.0), so a model can alternate a trivial/no-op tool call with empty turns to keep earning nudges. Bounded by the step budget (`agent.steps`) and the doom-loop guard for identical calls; visible in telemetry. Accepted v1. |

### 11.1 Review outcome

This spec was revised 2026-07-01 per `review-judgment.md` (this directory): all 13 fix-list items applied; OPEN-4/OPEN-5/OPEN-6 resolved, OPEN-1 rewritten, OPEN-3 narrowed, OPEN-2 kept, OPEN-7 added; the interception/injection mechanics (§5.0), discard guarantee (§5.1), event-manifest facts (§3, §8), and parameter-delivery state (§L0.1) were corrected against source-verified ground truth.

Human-required items (verbatim from the judgment):

1. **F1 (blocking, portfolio — does not block THIS spec):** The live session path is V1 `SessionPrompt.loop`, which this spec correctly targets. The approved sibling spec `30-06-2026_fallback-takeover` targets the core runner, which is NOT the live path. Decide: (a) rework fallback-takeover to target V1, (b) keep it as a future V2-migration artifact, or (c) park it.
2. **F16 (non-blocking confirmation):** Recovery messages are invisible in web/app clients in v1 (they filter synthetic user parts) — auto-continues are effectively hidden on those surfaces. Confirm the documented v1 exclusion is acceptable under UC4's "no hidden auto-continues" intent, or pull web rendering into v1 scope.

Accepted risks (documented, no action): F12 — nudge-text hazards (config tunables cover); F13 — `limit: 0` unlimited mode (explicit opt-in, R8).

### 11.2 Plan-phase obligations

The plan writer MUST carry these into `plan.md` (review PLAN-NOTES; not spec defects):

1. F6: the recipe `opencode.json` example must include `model.limit.output`; add a reasoning-parser/tool-call routing canary.
2. F14: pick the doom_loop pending-ask enforcement mechanism (`Permission.list()` vs shared flag) for §5.5 rule (a).
3. F10/OPEN-3: build the fixture for the no-part truncation shape.
4. OPEN-2: model-level temperature precedence capture test (A2).
5. OPEN-7: verify vLLM Qwen-template replay of prior-turn reasoning.
6. Phase-0 capture of the raw vLLM repetition-stop `finish_reason` string (feeds the §5.6 mapper-extension decision).

## 12. Out of scope

- Implementing code changes in this spec.
- L2/L3, stall watchdog, LLM-as-judge (UC2).
- Hidden nudges or a hide-config option (UC4: "possible but not in v1 scope").
- Any change to hosted-provider qwen defaults in `transform.ts` (L0.2 constraint).
- Non-vLLM server recipes (UC1).
- Core-runner (V2) parity — the core runner is NOT the live path (OPEN-4 resolved); parity remains out of scope; the sibling fallback-takeover spec's disposition is human-required (§11.1, F1).
- Web/app rendering of recovery messages (documented v1 exclusion, §6 — pending F16 confirmation).
- vLLM server code changes; model retraining.

## 13. Relevant files

- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` — live-path evidence: `SessionPrompt` import + `promptSvc.prompt()`/`loop()` (OPEN-4 resolution).
- `packages/opencode/src/session/prompt.ts` — inner `outcome === "break"` interception point, outer exit guard, `finished` computation, `lastUser` derivation (`:1141,1170,1188`), `step++`/`isLastStep`/`MAX_STEPS_PROMPT`, orphan-tool handling.
- `packages/opencode/src/session/processor.ts` — doom-loop guard (`DOOM_LOOP_THRESHOLD`), pending-tool cleanup (`:575-591`), unknown-finish "continue" (`:677-679`).
- `packages/opencode/src/session/compaction.ts` — direct-insertion precedent (`:489-515`), `isCompactionContinuation` pattern + exclusion seams for the new marker.
- `packages/opencode/src/session/message-v2.ts` — `toModelMessagesEffect` reasoning serialization (`:362-376`); provider-facing history conversion.
- `packages/opencode/src/session/todo.ts` — `Todo.Service.get` pending-work signal (wiring into `prompt.ts` required, §5.2).
- `packages/opencode/src/session/llm/request.ts` — options merge chain, temperature/topP/topK computation.
- `packages/opencode/src/session/llm/native-request.ts` — providerOptions handoff to AI SDK providers (L0 capture-test seam).
- `packages/llm/src/protocols/openai-chat.ts` — `mapFinishReason` (`:378-384`), penalty emission (`:364-365`), `PROTOCOL_BODY_OVERLAY_DENYLIST`/`GenerationOptions` gaps (L0.1 matrix).
- `packages/opencode/src/provider/transform.ts` — qwen defaults (unchanged), `OUTPUT_TOKEN_MAX`.
- `packages/schema/src/session-event.ts` — new `StopRecovery` event definition + `Definitions`/`DurableDefinitions`/`Durable` union registration.
- `packages/schema/src/session-todo.ts` — todo status values.
- `packages/core/src/v1/config/config.ts`, `agent.ts`, `migrate.ts` — config schema + agent key + migration (fork feature (6) precedent).
- `packages/tui/src/routes/session/visible-user-text.ts`, `packages/tui/src/util/mcp-visible-message.ts` — visible/muted/automated rendering.
- `packages/session-ui/src/components/message-part.tsx` — web synthetic-part filter (`:1128`, documented v1 exclusion, F16).
- `packages/schema/test/event-manifest.test.ts`, `packages/opencode/test/event-manifest.test.ts` — count assertions (56/86/86/33) and `Latest === 91` + identity assertions.
- `packages/sdk/js/script/build.ts` — SDK regeneration (`SessionDurableEvent` union).
- `docs/fork/qwen-vllm-recipe.md` (new) — L0.3 deliverable.
- `FORK_CHANGES.md` — new fork-feature entry + future-merge recipe.
