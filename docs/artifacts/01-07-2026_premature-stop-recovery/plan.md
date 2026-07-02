# Qwen Premature-Stop Recovery (L0+L1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Source of truth: `docs/artifacts/01-07-2026_premature-stop-recovery/spec.md` (review-revised). On any conflict, the spec wins; escalate rather than improvise.

**Goal:** Opt-in fork feature that (L0) delivers Qwen/vLLM anti-loop sampling parameters end-to-end and documents the server recipe, and (L1) recovers bounded-and-visibly from premature turn ends (`length` truncation, no-tool stop with pending work, empty-text-after-thinking) in the V1 session loop.

**Architecture:** A pure decision module (`stop-recovery.ts`) evaluates trigger/counter state from turn facts; an Effect shell gathers facts (config, todos, doom-loop pending), publishes telemetry, and injects synthetic continue/nudge user messages by direct insertion (compaction precedent). One small wiring block goes inside the `runLoop` exit-guard (`prompt.ts:1111-1130`) — the verified would-be-exit point. New durable event `session.next.stop_recovery`; TUI renders recovery messages visible+muted+automated.

**Tech Stack:** TypeScript + Effect (Effect.gen, Effect Schema), Bun test. Repo policies: run tests/typecheck FROM PACKAGE DIRS only (never repo root); SDK regen via `bun ./packages/sdk/js/script/build.ts`; never edit `src/generated*`.

**Verified anchors (do not re-derive):**
- Exit guard: `packages/opencode/src/session/prompt.ts:1111-1130`; `hasToolCalls` at `:1106-1109`; `step++` at `:1132`; `maxSteps`/`isLastStep` at `:1178-1179`; assistant msg creation at `:1186-1201`; inner outcome gen `:1221-1332`; `outcome === "break"` returns at `:1291/:1306/:1314/:1318` (all recovery-excluded).
- Finished `stop`/`length` turns exit ONLY via the next-iteration outer guard (processor returns `"continue"`, `processor.ts:677-679`).
- Injection precedent: `packages/opencode/src/session/compaction.ts:487-515` (`session.updateMessage` user msg + `session.updatePart` text part, `synthetic: true`, `metadata: { compaction_continue: true }`).
- Pending tool calls already finalized to `error` + `interrupted: true` on ALL exits (`processor.ts:575-591` via `Effect.ensuring`) — truncated tool calls cannot execute.
- Manifest ground truth: `packages/schema/test/event-manifest.test.ts` asserts 55/85/85/32 → becomes 56/86/86/33; `packages/opencode/test/event-manifest.test.ts` asserts `Latest === 90` → 91 (identity-asserts the rest; NOT mirrored counts).
- `mapFinishReason` fallthrough → `"unknown"`: `packages/llm/src/protocols/openai-chat.ts:378-384`.
- `Todo.Service.get(sessionID)` exists (`packages/opencode/src/session/todo.ts`); NOT wired into `prompt.ts` today.

**Cross-task contracts (fixed now so parallel tasks compile against them):**
- Marker keys (part-level `metadata`): `stop_recovery_continue: true` plus `stop_recovery: { trigger, attempt }`.
- Event type: `session.next.stop_recovery`, durable. Fields: `messageID`, `trigger: "length" | "no_tool" | "empty_after_thinking" | "unknown_finish"`, `action: "continue" | "nudge" | "nudge_grace" | "halt" | "observed"`, `attempt: number`, `limit: number`, optional `reasoning_only: boolean`, optional `tokens: { input, output, reasoning }`, optional `cost: number`.
- Config block (root, all optional, feature off unless `enabled: true`):
```jsonc
"stopRecovery": {
  "enabled": false,
  "lengthContinue": { "enabled": true, "max": 3, "text": "..." },      // max 0-5; 0 disables
  "noToolNudge":    { "enabled": true, "limit": 3, "graceRetry": true, "text": "..." }, // limit 0 = unlimited
  "emptyAfterThinking": { "enabled": true, "text": "..." }
}
```
- Agent-level: `stopRecovery?: boolean` (disable-only override).

---

## Task overview / dependency tree

| # | Task | Parallel | Touches (create/modify) |
|---|------|----------|-------------------------|
| 1 | L0 capture test (path scoping) | yes | `packages/opencode/test/stop-recovery-l0-capture.test.ts` |
| 2 | L0 gap closure per capture | after 1 | `packages/opencode/src/provider/*` or `packages/llm/*` per T1 findings + T1 test file |
| 3 | vLLM recipe doc + staged validation checklist | yes | `docs/fork/qwen-vllm-recipe.md` |
| 4 | Config schema (root + agent) | yes | `packages/core/src/v1/config/config.ts`, agent schema file, config tests |
| 5 | StopRecovery event + manifests + SDK | yes | `packages/schema/src/session-event.ts`, both manifest tests, SDK regen |
| 6 | Pure decision module + table tests | yes | `packages/opencode/src/session/stop-recovery.ts`, `packages/opencode/test/stop-recovery.test.ts` |
| 7 | Compaction exclusion predicate | yes | `packages/opencode/src/session/compaction.ts`, compaction tests |
| 8 | Effect shell: facts + injection + telemetry | after 4,5,6 | `packages/opencode/src/session/stop-recovery.ts` (same file, shell section) |
| 9 | runLoop wiring (guard block) | after 7,8 | `packages/opencode/src/session/prompt.ts` |
| 10 | TUI rendering | yes | `packages/tui/src/routes/session/visible-user-text.ts` + its test |
| 11 | Integration/AC tests (B/C/E) | after 9 | `packages/opencode/test/stop-recovery-loop.test.ts` |
| 12 | FORK_CHANGES entry + validation sweep | after 11 | `FORK_CHANGES.md` |

Commit after every task (and at marked mid-task points). Message prefix: `feat(fork): stop-recovery — <what>` (docs: `docs(fork): ...`, tests: `test(fork): ...`).

---

### Task 1: L0 capture test — which path serves local vLLM, and which fields arrive

**Parallel:** yes
**Touches:** `packages/opencode/test/stop-recovery-l0-capture.test.ts` (create)

Spec §L0.1 makes path scoping the first normative task. The test doubles as the permanent A1 acceptance test.

- [ ] **Step 1: Find the existing request-capture test pattern.**
Run: `rg -l "fetch" packages/opencode/test --glob '*.test.ts' | head -20` and `rg -l "custom-minio|mockHttpClient" packages/opencode/test packages/core/test`
Expected: at least one existing test that stubs fetch/HTTP for provider requests (the fork's `custom-minio.test.ts` uses `mockHttpClient`; provider tests may stub `fetch`). Mirror the strongest precedent for intercepting the outgoing HTTP body.

- [ ] **Step 2: Write the capture test (failing first).** Define a local OpenAI-compatible provider pointing at a stubbed fetch that records `JSON.parse(init.body)`, with per-model options containing every L0 field:

```ts
// packages/opencode/test/stop-recovery-l0-capture.test.ts
import { describe, expect, test } from "bun:test"

// Provider/model config under test — mirrors the recipe example
const MODEL_OPTIONS = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  presencePenalty: 0.5,
  frequencyPenalty: 0.1,
  // vLLM extras (delivery mechanism is what this test establishes):
  min_p: 0.0,
  thinking_token_budget: 8192,
  repetition_detection: { min_pattern_size: 1, max_pattern_size: 40, min_count: 4 },
}

describe("L0 per-field delivery to OpenAI-compatible body (spec A1)", () => {
  test("captures outgoing body for a local openai-compatible model", async () => {
    const captured = await captureRequestBody(MODEL_OPTIONS) // helper built on the repo's fetch-stub pattern from Step 1
    // Baseline fields — expected to pass on the live (AI SDK) path today:
    expect(captured.temperature).toBe(0.6)
    expect(captured.top_p).toBe(0.95)
    expect(captured.presence_penalty).toBe(0.5)
    expect(captured.frequency_penalty).toBe(0.1)
    // Known-gap fields — spec L0.1 matrix says these FAIL until Task 2 closes them:
    expect(captured.top_k).toBe(20)
    expect(captured.min_p).toBe(0.0)
    expect(captured.thinking_token_budget).toBe(8192)
    expect(captured.repetition_detection).toEqual(MODEL_OPTIONS.repetition_detection)
  })
})
```
The `captureRequestBody` helper must drive the REAL request-preparation pipeline (provider resolution → `request.ts` merge chain → transport), not re-implement it. Build it on the Step-1 precedent.

- [ ] **Step 3: Run and RECORD the per-field result.**
Run: `cd packages/opencode && bun test test/stop-recovery-l0-capture.test.ts`
Expected: FAIL on the known-gap assertions. Record in the test file header comment: which path executed (AI SDK vs native — assert via a breadcrumb, e.g. stub both fetch and the native transport and see which fired) and the exact pass/fail per field. This record is the input to Task 2 and resolves spec OPEN-1's per-field matrix empirically.

- [ ] **Step 4: Split assertions.** Move the failing known-gap assertions into a second `test.todo`/`test.skip` block labeled `A1-gap: closed by Task 2`, so the baseline block passes and CI stays green.
Run: `cd packages/opencode && bun test test/stop-recovery-l0-capture.test.ts` → PASS (baseline), SKIP (gap block).

- [ ] **Step 5: Commit.** `git add packages/opencode/test/stop-recovery-l0-capture.test.ts && git commit -m "test(fork): stop-recovery — L0 per-field capture baseline (A1)"`

---

### Task 2: L0 gap closure — deliver top_k / min_p / vLLM extras

**Parallel:** after Task 1
**Touches:** per T1 findings — likely `packages/opencode/src/provider/provider.ts` (custom fetch/body merge for openai-compatible) OR `packages/opencode/src/provider/transform.ts` (providerOptions), plus `packages/opencode/test/stop-recovery-l0-capture.test.ts`

Spec L0.1 (delivery matrix) and OPEN-2. Two arms depending on Task 1's recorded path:

- [ ] **Step 1 (Arm A — live path is AI SDK @ai-sdk/openai-compatible, the default):** implement extra-body delivery at the provider layer: in the openai-compatible provider construction (`packages/opencode/src/provider/provider.ts`, where `baseURL`/`apiKey`/`headers` are wired, ~:1685-1689), add a `fetch` wrapper that deep-merges a per-model `extraBody` (from `model.options.extraBody ?? {}` plus the recognized loose keys `min_p`, `top_k`, `thinking_token_budget`, `repetition_detection` when present in model options) into the JSON request body before dispatch:

```ts
// provider.ts — inside openai-compatible options construction
const extraBody = collectExtraBody(modelOptions) // { min_p?, top_k?, thinking_token_budget?, repetition_detection?, ...modelOptions.extraBody }
if (Object.keys(extraBody).length > 0) {
  options.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") {
      const parsed = JSON.parse(init.body)
      init = { ...init, body: JSON.stringify({ ...parsed, ...extraBody }) }
    }
    return globalThis.fetch(url, init)
  }
}
```
This is additive, per-provider-instance, and touches no upstream body-builder — the lowest-conflict fork mechanism.

- [ ] **Step 1 (Arm B — live path is the native `@opencode-ai/llm` protocol):** do NOT patch `generation()`/`GenerationOptions` (upstream-owned schema). Use the `HttpOptions.body` overlay for non-denylisted keys (`min_p`, `thinking_token_budget`, `repetition_detection`) and add the fork note that `top_k`/penalties are denylist-blocked on this path (`packages/llm/src/route/transport/http.ts:31-68`) — then implement the same fetch-wrapper mechanism one layer up. Record which arm was taken in the spec's L0.1 matrix (doc touch-up, one line).

- [ ] **Step 2: Un-skip the A1 gap assertions from Task 1.**
Run: `cd packages/opencode && bun test test/stop-recovery-l0-capture.test.ts` → ALL PASS.

- [ ] **Step 3: A2 precedence test (spec OPEN-2).** Add to the same test file: model-level `temperature: 0.6` must beat the qwen transform default (0.55, `transform.ts:484`) and agent-level absence must not reset it:

```ts
test("A2: model.options.temperature=0.6 wins over qwen default 0.55", async () => {
  const captured = await captureRequestBody({ temperature: 0.6 })
  expect(captured.temperature).toBe(0.6)
})
```
If this FAILS, fix the merge order in `packages/opencode/src/session/llm/request.ts:91` region (base → model.options → agent.options → variant is the spec-required order) and record the fix in the spec (OPEN-2 → resolved).

- [ ] **Step 4: A3 hosted-regression guard.** Add one test: a model whose id contains `qwen` on a hosted provider (no `stopRecovery`/extras configured) produces a body with NO `min_p`/`thinking_token_budget`/`repetition_detection` keys and unchanged temperature default.
Run: `cd packages/opencode && bun test test/stop-recovery-l0-capture.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
Run: `cd packages/opencode && bun typecheck` → clean.
`git add -A && git commit -m "feat(fork): stop-recovery — L0 extra-body delivery for vLLM sampling fields (A1/A2/A3)"`

---

### Task 3: vLLM recipe doc + staged validation checklist

**Parallel:** yes
**Touches:** `docs/fork/qwen-vllm-recipe.md` (create)

Spec §L0.2/L0.3, §10.1 (Phases 0-3), plan-phase obligations 1, 5, 6.

- [ ] **Step 1: Write the doc** with these mandatory sections (content from spec §L0.3 table + research-2/3, already synthesized — transcribe, don't re-research):
  1. **Sampling preset** (thinking-coding): `temperature 0.6, top_p 0.95, top_k 20, min_p 0, presence_penalty 0.5 (→1.5 if loops persist; 1.5 recommended for FP8/quantized), repetition_penalty 1.0 (never raise)`. Never greedy.
  2. **Server flags:** `--reasoning-parser qwen3` (+ `--reasoning-config` if the build needs explicit start/end strings); `thinking_token_budget ≈ 4096-8192` (note: NOT enforced under MTP spec-decode, vLLM #39573); `repetition_detection {min_pattern_size 1, max_pattern_size 40, min_count 4}`; KV cache q8_0/unquantized; YaRN off unless >32k; version pins (minimum vLLM per feature; harness pins: `ai 6.0.168`, `@ai-sdk/openai-compatible 2.0.41`).
  3. **opencode.json example** — MUST include `limit: { context, output }` on the local model entry (`limit.output` gates when `finish:"length"` fires — `transform.ts:1325-1327` uses `min(model.limit.output, 32_000)`), plus the Task-2 extras.
  4. **Parser/tool-call canary (pre-deploy gate):** one scripted request with a tool schema + thinking enabled; verify tool calls arrive in `tool_calls`/content channel, NOT `reasoning_content`. If misrouted, `hasToolCalls` breaks and L1 false-nudges — do not enable L1 until fixed.
  5. **Phase 0 baseline capture:** enable vLLM request logging; record finish-reason histogram over a work session; capture the RAW `finish_reason` string vLLM sends when `repetition_detection` fires (feeds spec §5.6 mapping decision).
  6. **Phase 1-3 staged enablement** exactly per spec §10.1 (L0-only window → L1 per-component → UC2 L2 go/no-go over StopRecovery events incl. `observed`/`reasoning_only`).
  7. **OPEN-7 check:** multi-turn probe of whether the served chat template replays prior-turn `reasoning_content` (client sends it — `message-v2.ts:362-376`; template may drop it). Record the answer in the spec (OPEN-7).

- [ ] **Step 2: Commit.** `git add docs/fork/qwen-vllm-recipe.md && git commit -m "docs(fork): stop-recovery — qwen vLLM recipe + staged validation (L0.3, Phases 0-3)"`

---

### Task 4: Config schema

**Parallel:** yes
**Touches:** `packages/core/src/v1/config/config.ts` (root block), the v1 agent schema file (locate in Step 1), `packages/core/test/` config test file

- [ ] **Step 1: Locate precedents.**
Run: `rg -n "compaction" packages/core/src/v1/config/config.ts` and `rg -n "steps|fallback" packages/core/src/v1 --glob '*.ts' -g '!*test*' | head`
Expected: the `compaction` root `Schema.Struct` (~:146-165) — copy its optionality/default style; the agent schema carrying `steps`/`fallback` keys — the agent `stopRecovery?: boolean` key goes beside them. Also check `migrateAgent`/`agentKeys` (`packages/opencode/src/plugin/agent.ts` per fork history) so the new agent key is NOT dropped by v1 migration — add it to the key list if such a list gates passthrough.

- [ ] **Step 2: Add the root schema** (shape from Cross-task contracts, all `Schema.optional`, numeric ranges validated: `lengthContinue.max` 0-5, `noToolNudge.limit` >= 0; `text` overrides `Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500))`).

- [ ] **Step 3: Tests (failing → passing):** in the core config test suite: (a) config without `stopRecovery` parses (back-compat); (b) full block parses; (c) `max: 9` rejected; (d) empty `text` rejected; (e) agent `stopRecovery: false` parses and survives migration.
Run: `cd packages/core && bun test test/<config-test-file>.test.ts` → PASS.

- [ ] **Step 4: Typecheck + commit.** `cd packages/core && bun typecheck` → clean. `git add -A && git commit -m "feat(fork): stop-recovery — config schema (root stopRecovery block + agent disable key)"`

---

### Task 5: StopRecovery event + manifest bumps + SDK regen

**Parallel:** yes
**Touches:** `packages/schema/src/session-event.ts`, `packages/schema/test/event-manifest.test.ts`, `packages/opencode/test/event-manifest.test.ts`, generated SDK (via script only)

- [ ] **Step 1: Define the event** in `packages/schema/src/session-event.ts` — copy the `ModelSwitched` block (`:65-78`) as the template, adapt to the Cross-task contract fields (trigger/action literals, attempt, limit, optional reasoning_only/tokens/cost). Register in ALL THREE places: `Definitions` inventory, `DurableDefinitions` inventory, `Durable` union (the spec names these as the real modification targets — grep `DurableDefinitions` for the exact registration style).

- [ ] **Step 2: Bump manifest tests (failing first, then aligned):**
  - `packages/schema/test/event-manifest.test.ts`: 55→56, 85→86, 85→86, 32→33.
  - `packages/opencode/test/event-manifest.test.ts`: `Latest` 90→91 ONLY (it identity-asserts the rest — do NOT add mirrored counts).
Run: `cd packages/schema && bun test test/event-manifest.test.ts` → PASS. `cd packages/opencode && bun test test/event-manifest.test.ts` → PASS.

- [ ] **Step 3: SDK regen.**
Run from repo root: `bun ./packages/sdk/js/script/build.ts`
Then verify: `rg -n "SessionNextStopRecovery|stop_recovery" packages/sdk/js/dist --glob '*.d.ts' | head` → the new event appears in the `SessionDurableEvent` union. NEVER hand-edit `src/generated*`.

- [ ] **Step 4: Typecheck + commit.** `cd packages/schema && bun typecheck`; `cd packages/opencode && bun typecheck` → clean.
`git add -A && git commit -m "feat(fork): stop-recovery — session.next.stop_recovery durable event + manifest bumps + SDK regen"`

---

### Task 6: Pure decision module + table tests

**Parallel:** yes
**Touches:** `packages/opencode/src/session/stop-recovery.ts` (create — pure section), `packages/opencode/test/stop-recovery.test.ts` (create)

The heart of L1. Pure functions, no Effect, fully table-testable. Implements spec §5.0-§5.6 exactly.

- [ ] **Step 1: Write the module skeleton with types:**

```ts
// packages/opencode/src/session/stop-recovery.ts
export namespace StopRecovery {
  export const MARKER = "stop_recovery_continue" as const

  export interface Config {
    enabled: boolean
    lengthContinue: { enabled: boolean; max: number; text?: string }
    noToolNudge: { enabled: boolean; limit: number; graceRetry: boolean; text?: string }
    emptyAfterThinking: { enabled: boolean; text?: string }
  }

  export interface State {
    turnKey: string // id of originating REAL user message
    lengthContinues: number
    noProgressCount: number
    graceUsed: boolean // single grace shared across no_tool + empty_after_thinking (spec §5.0)
  }

  export interface TurnFacts {
    turnKey: string
    finish: string | undefined
    hasError: boolean
    hasToolCalls: boolean            // prompt.ts:1106-1109 semantics (excludes providerExecuted + orphans)
    hasProviderExecutedTools: boolean // counts as progress (spec §5.2)
    textEmpty: boolean               // joined type==="text" parts only, trim() === ""
    reasoningPresent: boolean
    pendingTodos: boolean
    step: number                     // completed steps at guard time (pre-increment)
    maxSteps: number                 // agent.steps ?? Infinity
    isJsonSchemaTurn: boolean
    agentDisabled: boolean
    doomLoopPending: boolean
    compactionPending: boolean
  }

  export type Decision =
    | { action: "none" }
    | { action: "observed"; trigger: "unknown_finish" }
    | { action: "continue"; trigger: "length"; attempt: number; text: string }
    | { action: "nudge" | "nudge_grace"; trigger: "no_tool" | "empty_after_thinking"; attempt: number; reasoningOnly: boolean; text: string }
    | { action: "halt"; trigger: "no_tool" | "empty_after_thinking"; attempts: number; limit: number }

  export const DEFAULT_CONTINUE_TEXT = "Continue from where you left off."
  export const DEFAULT_NUDGE_TEXT =
    "Your previous reply ended without completing the pending work. Continue with the task: execute the next required action (use a tool if one is needed), or state explicitly that everything is complete. (Automated message from the harness - do not respond to it conversationally.)"

  export function initialState(turnKey: string): State {
    return { turnKey, lengthContinues: 0, noProgressCount: 0, graceUsed: false }
  }

  export function evaluate(config: Config, prev: State | undefined, f: TurnFacts): { decision: Decision; state: State } {
    // turnKey change or first evaluation → fresh counters (spec §5.0 reset rules)
    let state = prev && prev.turnKey === f.turnKey ? { ...prev } : initialState(f.turnKey)
    const none = { decision: { action: "none" } as Decision, state }

    // Hard gates (spec §5.4/§5.5) — order matters
    if (!config.enabled || f.agentDisabled) return none
    if (f.isJsonSchemaTurn) return none
    if (f.compactionPending) return none            // compaction has priority; counters persist
    if (f.doomLoopPending) return none
    if (f.hasToolCalls) return none                 // turn is not over / progress
    if (f.hasError) return none                     // error & content-filter turns: existing paths own them
    if (f.finish === "content-filter" || f.finish === "error") return none

    // Step eligibility (spec §5.5): injected turn runs at step+1; never enter MAX_STEPS regime
    const stepEligible = f.step + 1 < f.maxSteps
    if (!stepEligible) return none

    // Unknown finish: telemetry only (spec §5.6 — repetition-kill lands here today)
    if (f.finish === "unknown" || f.finish === undefined) {
      return { decision: { action: "observed", trigger: "unknown_finish" }, state }
    }

    const reasoningOnly = f.textEmpty && f.reasoningPresent

    // length + reasoning-only → empty-after-thinking family (spec §5.1 routing, F4)
    if (f.finish === "length" && !reasoningOnly) {
      if (!config.lengthContinue.enabled || config.lengthContinue.max === 0) return none
      if (state.lengthContinues >= config.lengthContinue.max) return none // cap exhausted: end normally, no error (spec §5.1)
      state.lengthContinues++
      return {
        decision: { action: "continue", trigger: "length", attempt: state.lengthContinues, text: config.lengthContinue.text ?? DEFAULT_CONTINUE_TEXT },
        state,
      }
    }

    // stop (or length routed here as reasoning-only): nudge family, shared counter + shared single grace
    const isEmptyAfterThinking = reasoningOnly
    const isNoTool = f.finish === "stop" && !f.textEmpty && !f.hasProviderExecutedTools && f.pendingTodos
    if (!isEmptyAfterThinking && !isNoTool) return none
    const family = isEmptyAfterThinking ? ("empty_after_thinking" as const) : ("no_tool" as const)
    const familyEnabled = isEmptyAfterThinking ? config.emptyAfterThinking.enabled : config.noToolNudge.enabled
    if (!familyEnabled) return none

    const limit = config.noToolNudge.limit // shared limit for the nudge family (spec §5.2/§5.3)
    const unlimited = limit === 0
    if (!state.graceUsed && config.noToolNudge.graceRetry) {
      state.graceUsed = true
      return { decision: { action: "nudge_grace", trigger: family, attempt: 0, reasoningOnly, text: nudgeText(config, family) }, state }
    }
    if (!unlimited && state.noProgressCount >= limit) {
      return { decision: { action: "halt", trigger: family, attempts: state.noProgressCount, limit }, state }
    }
    state.noProgressCount++
    return { decision: { action: "nudge", trigger: family, attempt: state.noProgressCount, reasoningOnly, text: nudgeText(config, family) }, state }
  }

  function nudgeText(config: Config, family: "no_tool" | "empty_after_thinking"): string {
    return (family === "no_tool" ? config.noToolNudge.text : config.emptyAfterThinking.text) ?? DEFAULT_NUDGE_TEXT
  }

  // Progress reset (spec §5.0): executed tool call on a later assistant message
  export function onProgress(state: State): State {
    return { ...state, noProgressCount: 0, graceUsed: false }
  }
}
```

- [ ] **Step 2: Table tests (write ALL failing first, then run):** cover every spec row — one `test.each` table per group:
  - Gates: disabled / agentDisabled / json_schema / compactionPending / doomLoopPending / hasToolCalls / hasError / content-filter / error → `none`.
  - Step eligibility: `step=4, maxSteps=5` → none; `maxSteps=Infinity` → eligible.
  - Unknown finish → `observed` exactly once shape (stateless — same state back).
  - Length: attempts 1..max, cap exhaustion → none; `max: 0` → none; reasoning-only length → routed to `empty_after_thinking` (decision.trigger check).
  - Nudge family: grace first (`nudge_grace`, counter 0), then nudge 1..limit, then `halt`; `graceRetry:false` → first is counted `nudge`; `limit: 0` → never halts; shared counter across `no_tool` and `empty_after_thinking` alternation; provider-executed-tools-only turn → none; `pendingTodos:false` + non-empty text → none.
  - turnKey change resets all counters; `onProgress` resets nudge counters but NOT `lengthContinues`.
Run: `cd packages/opencode && bun test test/stop-recovery.test.ts` → PASS (after implementing).

- [ ] **Step 3: Typecheck + commit.** `cd packages/opencode && bun typecheck` → clean.
`git add -A && git commit -m "feat(fork): stop-recovery — pure decision module + table tests (spec 5.0-5.6)"`

---

### Task 7: Compaction exclusion predicate

**Parallel:** yes
**Touches:** `packages/opencode/src/session/compaction.ts`, its test file

Spec §5.1/§6: recovery continuations must be excluded from turn accounting like `compaction_continue`.

- [ ] **Step 1: Locate the three call sites.**
Run: `rg -n "isCompactionContinuation" packages/opencode/src/session/compaction.ts`
Expected: definition (~:62-67) + call sites (~:100, ~:325, ~:336).

- [ ] **Step 2: Generalize (spec-chosen design: shared predicate):**

```ts
// compaction.ts — replace the body of the existing private predicate usage
function isSyntheticContinuation(part: { synthetic?: boolean; metadata?: Record<string, unknown> }): boolean {
  return part.synthetic === true &&
    (part.metadata?.compaction_continue === true || part.metadata?.stop_recovery_continue === true)
}
```
Keep `isCompactionContinuation` name at the definition site if narrower call sites need compaction-only semantics — check each of the 3 call sites: turn-budget exclusion (`:100`) and candidate selection want the SHARED predicate; any compaction-resume-specific site keeps the narrow one. Decide per call-site semantics, not blanket rename.

- [ ] **Step 3: Test (failing → passing):** in the compaction test suite, a synthetic user message with `stop_recovery_continue: true` is excluded from `turns()` accounting exactly like a `compaction_continue` one (B3).
Run: `cd packages/opencode && bun test test/<compaction-test-file>.test.ts` → PASS.

- [ ] **Step 4: Commit.** `git commit -am "feat(fork): stop-recovery — exclude stop_recovery_continue from compaction turn accounting"`

---

### Task 8: Effect shell — facts gathering, injection, telemetry

**Parallel:** after Tasks 4, 5, 6
**Touches:** `packages/opencode/src/session/stop-recovery.ts` (shell section appended)

- [ ] **Step 1: Implement `decide` (the single entry point `prompt.ts` will call).** Inputs: everything already in scope at the guard (`sessionID, msgs, lastUser, lastAssistant, lastAssistantMsg, step`) plus services (`sessions`, `events`, config accessor, `Todo`, `permission`, `agents`). Responsibilities:
  1. Resolve config (root block; default disabled) + agent override (`agents.get(lastUser.agent)` → `stopRecovery === false` disables; also `agent.steps ?? Infinity` for maxSteps).
  2. Resolve `turnKey`: walk `msgs` user messages backward past ANY message whose parts are all `synthetic: true` (generic real-user predicate — spec §5.0; the task-summary nudge carries no marker). If no real user found (compaction pruned the anchor): fabricate `turnKey = lastUser.id` and reset (bounded-risk row).
  3. Build `TurnFacts`: `finish`/`error` from `lastAssistant`; `hasToolCalls` recomputed with the SAME expression as `prompt.ts:1106-1109`; `hasProviderExecutedTools` = any tool part with `metadata?.providerExecuted`; `textEmpty` = joined `type === "text"` parts `.trim() === ""`; `reasoningPresent` = any `type === "reasoning"` part OR `lastAssistant.tokens?.reasoning > 0`; `pendingTodos` = `Todo.Service.get(sessionID)` has status `pending | in_progress`; `doomLoopPending` = pending `doom_loop` permission ask for this session (Step 2); `compactionPending` = caller passes whether a compaction task was queued this iteration.
  4. Run `StopRecovery.evaluate` against module-held per-session state (a `Map<SessionID, State>` inside the shell, cleared when `decide` observes a new turnKey and on `halt`; in-memory only per spec).
  5. Act on the decision:
     - `observed` → publish event only (`action: "observed"`, `trigger: "unknown_finish"`), return `"end"`.
     - `continue` / `nudge` / `nudge_grace` → inject (Step 3), publish event with `attempt/limit`, `reasoning_only`, and `tokens`/`cost` copied from `lastAssistant`, return `"injected"`.
     - `halt` → publish event; set a user-visible error on the assistant message (define `StopRecoveryError` via the same `NamedError.create` pattern as `ContentFilterError` in `packages/core/src/v1/session.ts`, register beside it; HTTP error middleware registration checked in Task 11), return `"end"`.
     - `none` → return `"end"`.

- [ ] **Step 2: doom_loop pending check (plan obligation 2 — decision: Permission.list()).**
Run: `rg -n "list|pending" packages/opencode/src/permission/index.ts | head -20`
If the permission service exposes a pending-request list: filter `permission === "doom_loop" && sessionID`. If it does not, fall back to the documented alternative: a module-level `Set<SessionID>` flag set/cleared by the processor's doom-loop ask site (`processor.ts:371` region) — one-line fork touch. Record which mechanism was used in FORK_CHANGES (Task 12).

- [ ] **Step 3: Injection — mirror compaction exactly (`compaction.ts:487-515`):**

```ts
const continueMsg = yield* sessions.updateMessage({
  id: MessageID.ascending(),
  role: "user",
  sessionID,
  time: { created: Date.now() },
  agent: realUser.agent,          // COPY from originating REAL user message (spec §5.0; agent-not-found is fatal otherwise)
  model: realUser.model,
  format: realUser.format,        // copy if present on the user message type
})
yield* sessions.updatePart({
  id: PartID.ascending(),
  messageID: continueMsg.id,
  sessionID,
  type: "text",
  metadata: {
    stop_recovery_continue: true,
    stop_recovery: { trigger: decision.trigger, attempt: decision.attempt },
  },
  synthetic: true,                 // NEVER ignored: true (must reach the model)
  text: decision.text,
  time: { start: Date.now(), end: Date.now() },
})
```

- [ ] **Step 4: Unit tests for the shell** (mock services, no real loop): injection copies agent/model/format; observed publishes without injecting; halt sets `StopRecoveryError`; turnKey walk-back skips a marker-less all-synthetic user message (task-summary shape); pruned-anchor fabrication.
Run: `cd packages/opencode && bun test test/stop-recovery.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.** `cd packages/opencode && bun typecheck` → clean.
`git commit -am "feat(fork): stop-recovery — effect shell: facts, injection, telemetry, halt error"`

---

### Task 9: runLoop wiring

**Parallel:** after Tasks 7, 8
**Touches:** `packages/opencode/src/session/prompt.ts` (ONE block inside the exit guard + service wiring)

- [ ] **Step 1: Wire services.** Make `Todo` (and the permission accessor from Step 8.2 if needed) available in the `SessionPrompt` context — mirror how `sessions`/`agents`/`permission` are provided (check the module's service acquisition preamble and `SessionPrompt.node` layer; `permission` is already in scope, used at `:1236`).

- [ ] **Step 2: Insert the recovery block inside the exit guard (`prompt.ts:1111-1130`), before the orphan logging/`break`:**

```ts
if (
  lastAssistant?.finish &&
  !["tool-calls"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastUser.id < lastAssistant.id
) {
  // fork(stop-recovery): bounded premature-stop recovery — evaluates once per
  // would-be turn end; injects a synthetic continue/nudge and re-enters, or
  // falls through to the normal break. docs/artifacts/01-07-2026_premature-stop-recovery/spec.md §5
  const recovery = yield* stopRecovery.decide({
    sessionID, msgs, lastUser, lastAssistant, lastAssistantMsg, step,
    compactionPending: tasks.some((t) => t.type === "compaction"),
  })
  if (recovery === "injected") continue

  /* existing orphan logging + break, unchanged */
}
```
Keep the fork diff to this single block + one import — upstream-merge hygiene (the guard is a hot upstream region; FORK_CHANGES recipe in Task 12).
Note: `tasks` is consumed by `pop()` later in the iteration — read compaction-pending BEFORE the guard consumes anything (at guard time `tasks` is untouched; verify and adjust if upstream moved it).

- [ ] **Step 3: `observed` hook for unknown finishes.** The guard condition requires `lastAssistant.finish` truthy, and `"unknown"` passes it — so unknown-finish turns DO reach the guard and `decide` handles them via the `observed` branch (telemetry only, returns `"end"`, loop breaks). Confirm with a targeted unit test in Task 11 (E9). No extra wiring needed.

- [ ] **Step 4: Progress reset.** In `decide`, before evaluation: if the newest assistant message since the last recovery evaluation contains an executed (non-providerExecuted, non-orphan) tool part → `onProgress` reset. (State shape from Task 6; this is shell logic, but its call site is per-iteration — verify it observes post-injection iterations.)

- [ ] **Step 5: Smoke-run the package suites.**
Run: `cd packages/opencode && bun test test/stop-recovery.test.ts test/event-manifest.test.ts && bun typecheck` → PASS/clean.
Also run the session suites most likely to catch regressions: `bun test test/session` (or the nearest existing session/prompt test files found via `ls test`).
Expected: all green — with `stopRecovery` absent from config the guard block is a no-op (D3).

- [ ] **Step 6: Commit.** `git commit -am "feat(fork): stop-recovery — wire recovery decision into runLoop exit guard"`

---

### Task 10: TUI rendering

**Parallel:** yes (contract: marker key literal)
**Touches:** `packages/tui/src/routes/session/visible-user-text.ts`, its test (create beside existing TUI tests)

- [ ] **Step 1: Extend the visibility predicate** (spec §6 — exact mechanism):

```ts
// visible-user-text.ts
export function isVisibleUserTextPart(part: Part): boolean {
  if (part.type !== "text") return false
  if (!part.synthetic) return true
  if (part.metadata?.[MCP_VISIBLE_METADATA.visible] === true) return true
  if (part.metadata?.stop_recovery_continue === true) return true   // fork(stop-recovery)
  return false
}
```
(Adapt to the file's actual current shape — `:4-18`; keep `muted: true` handling in `visibleUserTextParts` so recovery parts render muted, and extend the automated-source header the same way the MCP caller header works: label `auto · stop recovery <trigger> <attempt>/<limit>` from `part.metadata.stop_recovery`.)

- [ ] **Step 2: Unit test:** part with `stop_recovery_continue: true` → visible + muted + header text; plain synthetic part → still hidden; MCP-visible part → unchanged.
Run: `cd packages/tui && bun test <test-file>` → PASS. `cd packages/tui && bun typecheck` → clean.

- [ ] **Step 3: Commit.** `git commit -am "feat(fork): stop-recovery — TUI visible-muted-automated rendering for recovery messages (UC4)"`

---

### Task 11: Integration / acceptance tests (spec §9 B, C, E blocks)

**Parallel:** after Task 9
**Touches:** `packages/opencode/test/stop-recovery-loop.test.ts` (create)

Use the repo's existing session-loop test harness (find precedent: `rg -l "runLoop|SessionPrompt" packages/opencode/test`) with a scripted fake model/processor. Each AC is one focused test:

- [ ] **Step 1: B-block (length):** B1 truncated turn → synthetic continue with marker + copied agent/model/format, loop re-enters, completes; B2 truncated pending tool part was already finalized error+interrupted by cleanup and never executes (assert on the fixture from the no-part AND pending-part shapes — plan obligation 3); B4 flag off → `finish:"length"` ends turn exactly as today; B6 reasoning-only length routes to nudge family with `reasoning_only: true` on the event.
- [ ] **Step 2: C-block (nudges):** grace → nudge → halt sequence with `StopRecoveryError` surfaced at limit; `graceRetry:false` counts first nudge; `limit:0` never halts; pendingTodos=false suppresses; provider-executed-only turn suppresses; step-boundary: `maxSteps = step+1` suppresses injection (C5/E8).
- [ ] **Step 3: E-block (negatives/interactions):** E1 master-off → zero injections AND zero events; E2 json_schema turn untouched; E3 compaction priority (compaction task queued + trigger true → recovery yields, one synthetic max); E4 abort during recovery-injected turn → no re-injection; E7 shared counter across families; E9 unknown finish → exactly one `observed` event, no injection, turn ends.
- [ ] **Step 4: HTTP error middleware for `StopRecoveryError`** — verify serialization: find the session error handler (`rg -n "ContentFilterError|session-errors" packages/opencode/src/server`) and assert the new error round-trips with a proper status/name (add registration if the middleware enumerates error types).
Run: `cd packages/opencode && bun test test/stop-recovery-loop.test.ts` → ALL PASS.
- [ ] **Step 5: Commit.** `git commit -am "test(fork): stop-recovery — acceptance suite (B/C/E blocks)"`

---

### Task 12: FORK_CHANGES entry + full validation sweep

**Parallel:** after Task 11
**Touches:** `FORK_CHANGES.md`

- [ ] **Step 1: Write the feature entry** following the existing feature-section format: summary, config surface, file inventory, and MERGE RECIPES for the two hot upstream files this feature touches: `packages/opencode/src/session/prompt.ts` (the single guard block — recipe: re-graft block inside the exit guard after upstream changes; the block's only coupling is `lastAssistant/lastUser/msgs/step/tasks` names) and `packages/opencode/src/session/compaction.ts` (shared predicate). Add both to the hot-file watchlist. Note the doom_loop mechanism chosen in Task 8, and the SDK regen step.

- [ ] **Step 2: Full sweep (per package, never root):**
```
cd packages/schema  && bun typecheck && bun test
cd packages/core    && bun typecheck && bun test
cd packages/opencode && bun typecheck && bun test
cd packages/tui     && bun typecheck && bun test
```
Expected: all green (known machine-specific exceptions: umask/locale tests — pre-existing, unrelated).

- [ ] **Step 3: Spec cross-check.** Walk spec §9 acceptance criteria; check each off against a test name; anything untestable → add to spec §11 as explicit accepted gap (doc edit).

- [ ] **Step 4: Final commit.** `git commit -am "docs(fork): stop-recovery — FORK_CHANGES entry + merge recipes"`

---

## Out of scope (do not implement — spec non-goals / open human items)

- L2 streaming loop detector, L3 fallback escalation, stall watchdog, LLM-as-judge, hidden nudges.
- Web/app rendering of recovery messages (documented v1 exclusion — HUMAN F16 pending).
- Fallback-takeover spec reconciliation (HUMAN F1 pending — do not port either feature across runners).
- `mapFinishReason` repetition-string mapping: BLOCKED on Phase 0 capture of the raw vLLM value (recipe doc, Task 3.1.5). Until then `observed` telemetry covers it.

## Risks the executor must respect

- `prompt.ts` guard is a hot upstream-merge region: keep the fork diff to ONE block + import.
- Feature must be a provable no-op when `stopRecovery` is absent/disabled (D3/E1 tests are the gate).
- Never let a synthetic injection run when `step + 1 >= maxSteps` (MAX_STEPS degenerate loop).
- Injection MUST copy `agent`/`model` from the real user message or the loop dies with agent-not-found.
