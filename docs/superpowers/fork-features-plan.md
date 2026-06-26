# Fork features plan — compaction-enhardening + fallback-model

Implementation spec for two `fork/main` features. Designed conflict-minimizing:
all logic in **new fork-owned files**; the hot-file footprint is a handful of
additive hooks, each catalogued in `FORK_CHANGES.md` with a re-graft recipe.

Worktree: `/home/wdcas/projects/pessoal/opencode-mcp-pr`, branch `fork/main`.
Decisions (2026-06-26): branch `fork/main`; PR #30019 closed; **C1 deferred**;
fallback = **chain + overflow**.

---

## Feature (5) — Compaction-enhardening

**Goal:** harden opencode's summarize-and-truncate compaction against the
context-compression survey's failure modes — **F2** (in-compression loss of code
structure/diffs/paths) and **F3** (post-compression unrecoverability). opencode is a
coding agent, so structural fidelity + recoverability matter most.

**Scope:** **C3 tool-output tiering (head-only)** + **C2 `session_recall` backstop**.
C1 (load-bearing extraction) **deferred**. C5 (`compact` tool) + R1 (loop bound)
optional later phases. Engine target: **v2** (`runner/llm.ts`). Kill-switch:
`OPENCODE_COMPACTION_ENHARDEN=0` ⇒ pure pass-through.

### New fork-owned files

- `packages/core/src/session/enharden/tiering.ts`
  ```ts
  export type Tier = "verbatim" | "summarize" | "drop"
  export const TIER_CAPS = { verbatim: 4_000, summarize: 1_600, global: 16_000 } as const
  export const DEFAULT_TIERS: Record<string, Tier> = {
    edit:"verbatim", write:"verbatim", apply_patch:"verbatim", patch:"verbatim",
    read:"verbatim", lsp:"verbatim", glob:"verbatim", skill:"verbatim",
    bash:"summarize", shell:"summarize", grep:"summarize",
    webfetch:"summarize", websearch:"summarize", task:"summarize", list:"summarize",
    todowrite:"drop", question:"drop",
  }
  // tierToolOutput(name, content, fallback): string
  //   off / unknown tool  -> fallback(content)            // BYTE-IDENTICAL legacy truncate
  //   verbatim            -> head+tail anchored <= cap, "[… N chars elided — recover via `session_recall` …]"
  //   summarize           -> first+last window <= cap + "[full output via `session_recall`]"
  //   drop                -> "[<name> output omitted — recover via `session_recall`]"
  //   global ceiling applied last
  ```
  - Mutation diffs (`edit/write/apply_patch/patch`) are the priority **verbatim** class — they're irreplaceable context.
  - `verbatim` is **head+tail anchored** (legacy `truncate` keeps head only) so the end of a diff/file survives.
  - Every non-verbatim branch names `session_recall` so the model knows recovery exists.
  - **`TIER_CAPS.verbatim = 4_000`** (≈2× legacy 2000, NOT 16k) so tiering can't inflate the unbounded summary head past the `compaction.ts:189` "summary prompt too big → refuse" threshold on small-context models. **Required test: a ~32k-context config still compacts with several verbatim outputs in the head.**
  - `DEFAULT_TIERS` hardcoded for the initial landing. Optional `OPENCODE_COMPACTION_TIERS` env override must be parsed **once at module load**, wrapped in `try/catch` → `DEFAULT_TIERS` on bad JSON (never `JSON.parse` inside `serialize()`/`select()` — a config typo must not kill compaction on a hot path).

- `packages/core/src/session/enharden/recall.ts` — DB helper. Imports only stable
  core exports: `latestCompaction` (`core/session/history.ts:13`), `SessionMessageTable`,
  `serializeToolContent` (`compaction.ts:84`). Uses `Database.Service` DI. Renders rows
  **without full `SessionMessage` decode** (schema-drift resilient). Returns only rows
  **below** the latest-compaction boundary (the pre-compaction head).

- `packages/core/src/tool/session-recall.ts` — `Tool.define("session_recall", { query, tool?, limit?=5, context_chars?=400 })`.
  `init` yields `Database.Service.db`. Output under a **hard 8,000-char ceiling**,
  footer `…N more matches`. This is a **CORE tool** (not v1/opencode) — the v2 runner
  materializes from the core registry, so a v1-registered tool would be unreachable.

### Hot-file hooks (the entire compaction surface)

| # | File:anchor | Touch | Risk | Recipe |
|---|---|---|---|---|
| T1 | `core/session/compaction.ts` head/recent split (~L139–161, **post-split**) | re-serialize **head** completed tool-results through `tierToolOutput(name, …, truncate)`; **`recent` stays byte-identical legacy `truncate`** | med | re-apply head-only tiering pass; never tier `recent`; tripwire test guards it |
| T2 | `core/src/tool/builtins.ts` `locationLayer` | append `session_recall` to the builtins list | low | append-only |

> **Why head-only:** the naive single hook inside `serialize()` (L105) fires *before* the
> head/recent split, so it would degrade the live `recent` working window (summarize cap
> 1600 < legacy 2000; drop deletes live status output). Read `select()` first and apply
> tiering only to head — either re-serialize head after the split, or parameterize
> `serialize(msg, {aggressive})` and pass `aggressive:true` only for head messages.

### F3 framing (honest)

Recall is **best-effort, not guaranteed**: `revert` (`projector.ts:430`) hard-deletes
messages above a boundary. Recall reads the **v2 `SessionMessageTable` only** (no v1
compaction recovery). Don't claim "rows are never deleted."

### Tests (fork-owned)

`enharden/tiering.test.ts` (unknown-tool ≡ `fallback` byte-for-byte; verbatim>cap is
head+tail; recent-equivalent input never below legacy 2000; 5 MB → ≤ global ceiling;
kill-switch pass-through; **bad-JSON env → DEFAULT_TIERS, no throw**);
`tool/session-recall.test.ts` (in-mem DB; no `seq ≥ boundary` row returned; ≤8k ceiling;
**F3 acceptance: a pre-compaction `edit` path is recoverable**);
`compaction-fidelity.test.ts` (**F2 acceptance** + **32k-context still compacts**);
`enharden/merge-tripwire.test.ts` (source still contains `tierToolOutput(`).

---

## Feature (6) — Fallback-model

**Goal:** when the active model's request fails with a **retriable** error, automatically
re-run the turn on a configured **fallback chain** instead of failing the turn.

**Triggers (scope = chain + overflow):**
- request-time HTTP failure where `LLMError.retryable === true` (rate-limit, 5xx, 529 overload), **OR**
- a context-overflow that **survives** the existing one-shot compaction recovery.

**NOT covered (documented limitation):** retriable errors arriving **mid-stream as in-band
SSE `provider-error`** (e.g. Anthropic `overloaded_error`, `anthropic-messages.ts:794`) —
these set `providerFailed=true` so the H7 gate declines, and `ProviderErrorEvent` carries no
`retryable` field. Mid-stream classification is out of scope (schema lacks `retryable`).

**Fatal (never fall back):** auth, quota, content-policy, no-route, non-overflow
invalid-request, **and user-abort/interrupt**.

### New fork-owned file

- `packages/core/src/session/runner/fallback.ts` — pure, no Effect:
  ```ts
  export const MAX_FALLBACKS = 4
  export const MAX_TURN_TRANSITIONS = 8
  export const keyOfRef = (r: ModelV2.Ref) => `${r.providerID}/${r.id}${r.variant?`#${r.variant}`:""}`
  export const shouldFallback = (f: unknown) =>
    (f instanceof LLMError && f.retryable) || isContextOverflowFailure(f)
  export const nextFallbackModel = (info, failure, tried: ReadonlySet<string>): ModelV2.Ref | undefined
  //   declines on: no chain / !shouldFallback / tried.size > MAX_FALLBACKS / all tried
  ```
  (`LLMError`, `isContextOverflowFailure` barrel-exported from `@opencode-ai/llm`.)

### Hot-file hooks `packages/core/src/session/runner/llm.ts` (all additive)

The spine: override + `tried`-set + `transitions` counter **ride on the recursion params**
of `runTurn`/`runAfterOverflowCompaction`. The two existing `TurnTransition` variants /
constructors / throw-sites stay **byte-for-byte**; add exactly **one** variant
`ContinueWithFallbackModel`.

| # | Anchor | Touch | Risk |
|---|---|---|---|
| H1 | imports | `import { SessionRunnerFallback } from "./fallback"` | none |
| H2 | `TurnTransition` union (~145–149) | append `ContinueWithFallbackModel` member (+ `transitions`) | low |
| H3 | ctors (~after 159) | `continueWithFallbackModel(step, model, tried, transitions)` | low |
| H4 | `runTurnAttempt` sig (~166–171) | append `modelOverride?, tried?, transitions?` | low |
| H5 | model resolve (~192) | `models.resolve(modelOverride ? {...session, model:modelOverride} : session)` | med |
| H6 | publisher variant (~217) | `(modelOverride ?? session.model)?.variant` | med |
| **H7** | **before L282** (between overflow `return` and `publish(overflowFailure)`) | the trigger block ↓ | **med — highest** |
| H8 | `RunTurn` type (~341–345) | append `modelOverride?, tried?, transitions?` | low |
| H9 | `runAfterOverflowCompaction` (~347–359) | thread params + new arm → `runTurn`; re-thread ambient on compaction arms; **increment `transitions`** | med |
| H10 | `runTurn` catchDefect (~361–373) | thread params + fallback arm first; re-thread ambient on existing recursions; **increment `transitions`** | med-high |

**H7 trigger (with the interrupt guard — mustFix from review):**
```ts
// immediately before llm.ts:282  (publish(overflowFailure))
const fallbackFailure = overflowFailure ?? failure
if (!Cause.hasInterrupts(stream.cause)        // user-abort racing a retriable error must NOT fall back
    && !publisher.hasAssistantStarted()       // nothing emitted yet -> safe to re-run
    && !publisher.hasProviderError()
    && transitions < SessionRunnerFallback.MAX_TURN_TRANSITIONS) {
  const currentRef = modelOverride ?? session.model
  const triedNext = new Set([...(tried ?? []),
    ...(currentRef ? [SessionRunnerFallback.keyOfRef(currentRef)] : [])])
  const next = SessionRunnerFallback.nextFallbackModel(agent.info, fallbackFailure, triedNext)
  if (next) return yield* Effect.die(continueWithFallbackModel(currentStep, next, triedNext, transitions + 1))
}
// else -> existing publish(overflowFailure)/failAssistant (282-287)
```

**Termination:** `tried` grows by exactly 1 per fallback hop; compaction transitions do
**not** grow it but do increment the shared `transitions` budget; `MAX_TURN_TRANSITIONS`
bounds compaction+overflow+fallback combined; the existing "cannot recover another
overflow" guard (`llm.ts:352`) backstops the overflow cascade. Override survives compaction
because compaction arms re-thread the **ambient** `modelOverride`/`tried`/`transitions`;
only `ContinueWithFallbackModel` swaps the model.

**Prompt-cache-key:** non-issue — `promptCacheKey` (`llm.ts:197`) is session-id-derived and
model-independent, so a model swap neither corrupts nor mis-attributes the OpenAI cache hint.

### Config (additive)

- `core/src/config/agent.ts` — `fallback: Schema.Array(Schema.String).pipe(Schema.optional)`
- `schema/src/agent.ts` — `fallback: Schema.Array(Model.Ref).pipe(optional)`
- `core/src/config/plugin/agent.ts` — add `"fallback"` to `agentKeys` (**load-bearing**: gates
  V2-vs-V1 routing; without it a markdown agent with `fallback:` frontmatter is mis-routed to
  the legacy decoder) + a parse block mirroring the `item.model` parse (`ModelV2.parse`).

### Tests

`core/test/session-runner-fallback.test.ts` — `shouldFallback` true for
RateLimit/ProviderInternal/overflow, false for Authentication/QuotaExceeded/ContentPolicy/NoRoute;
`nextFallbackModel` dedup/cap/exhaustion; `keyOfRef` variant-sensitive. Runner integration:
(1) RateLimit→fallback[0]; (3) Authentication→no fallback, one `failAssistant`; (5) chain
exhaustion→terminal, no loop; (6) post-compaction overflow→fallback; (7) assistant-started→no
fallback; (8) anti-ping-pong (compaction mid-fallback stays on fallback); (9) no-config→
byte-identical back-compat; **mid-stream non-overflow provider-error → no fallback**;
**composite Interrupt+Fail cause → no fallback**.

---

## Phased build order + verification

**Verification gate (after every phase):**
```bash
bun turbo typecheck
cd packages/core && bun test
cd packages/opencode && bun test test/agent/   # + touched suites
# build smoke: bun script/build.ts --single --skip-embed-web-ui --skip-install ; opencode --version
```

1. **Infra (done)** — branch `fork/main`, PR #30019 closed, `FORK_CHANGES.md`, this doc.
2. **Fallback Phase 0** — `fallback.ts` + config (additive) + unit/config tests. Ships **dark**
   (parses into `AgentV2.Info`, nothing reads it). Independently mergeable. → gate.
3. **Compaction Phase 1** — `tiering.ts` (4k cap, env-once parse, kill-switch) + head-only T1 +
   tiering tests + tripwire + **32k-context test**. → gate.
4. **Compaction Phase 2** — `recall.ts` + `session-recall.ts` (core) + `builtins.ts` append +
   recall test (F3 acceptance). Activates the elision markers Phase 1 emits. → gate.
5. **Fallback Phase 1** — H1–H4, H8, param-threading in H9/H10 (no new arm) + `RunTurn` type +
   `transitions` plumbing. Behavior identical (defaults undefined/0). Full runner suite → prove
   zero regression. → gate.
6. **Fallback Phase 2** — H5, H6, H7 (interrupt + budget guards), `ContinueWithFallbackModel`
   arms, combined-budget increments + integration tests. Only behavior-changing phase; gated
   behind a configured `fallback` chain. → gate. **MinIO publish milestone.**
7. _(optional later)_ Compaction C5 `compact` tool; R1 loop bound (only if livelocks observed);
   Fallback per-entry variant + telemetry; v1 compaction parity.

After each landed phase: add its rows to `FORK_CHANGES.md`, regen SDK if schema changed,
update memory.
