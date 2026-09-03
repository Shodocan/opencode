# Route-Aware Context Budgeting and Bounded Qwen Compaction Plan

**Review status:** iteration-2 approved after required amendments (2026-08-31).

## Authority, repository, and frozen invariants

- **Executing repository:** `/home/wdcas/projects/pessoal/opencode`; commands named `cwd packages/opencode` run from `/home/wdcas/projects/pessoal/opencode/packages/opencode`.
- **Plan artifact:** `/home/wdcas/projects/pessoal/opencode/specs/qwen-context-budget-plan.md`. Authoritative inputs are sibling `qwen-context-budget.md` and frozen `qwen-context-budget-choices.md` (`QCB-001..007`); this plan does not edit or override them.
- Keep normal generation at 32,000 output tokens; only compaction is capped at 4,096. Add no public config, generated schema, protocol, or routing policy. Preserve the durable transcript; compacting projections are non-destructive.
- The four-chars/token estimator is heuristic; the guarantee is deterministic final-payload formula admission plus bounded overflow repair.
- **QCB-005 interpretation (advisor-bound, confidence 0.94):** an `attempt` is a chargeable route/model/provider attempt. Workflow `attempt_reserved`, candidate-card emission, `task` invocation, and child creation are necessary non-chargeable preparation because the exact final payload exists only after child creation. Never claim zero workflow reservation/invocation or that the plugin can rebuild the exact payload before reservation.
- OpenCode V1 introduces no in-flight fallback producer. Companion T07 in `/home/wdcas/projects/pessoal/opencode-workflows` owns candidate-route fallback; the child OpenCode process owns final-payload admission.

## Dirty-tree admission and preservation

The authorized dirty tree is baseline. At run start record path/status/bytes/SHA-256 for every dirty/untracked path recursively; recheck each stage and fail closed on drift. Never reset/clean/revert. Protected paths are `packages/opencode/src/session/{prompt.ts,session.ts,tools.ts}`, `packages/opencode/src/tool/{registry.ts,task.ts,tool.ts}`, `packages/opencode/test/session/{prompt.test.ts,session.test.ts}`, `packages/opencode/test/tool/task.test.ts`, `packages/plugin/src/{index.ts,tool.ts}`, plus current untracked `handoff.md`, QCB spec/choices/plan, and quote-slash entries.

T06 alone may edit dirty `prompt.ts`. T07 alone may narrowly edit dirty `task.ts`, `tools.ts`, plugin `index.ts`, and, only if needed for matching types/tests, plugin `tool.ts` and `task.test.ts`. T05/T06 never edit dirty `session.ts`; no other task edits protected paths. Exact pins:

| Path | SHA-256 |
|---|---|
| `packages/opencode/src/session/prompt.ts` | `fcecdbf12cfa9084158fb0cdbe0c7adaf74243cf8efb2381e8c8e24815a48d63` |
| `packages/opencode/test/session/prompt.test.ts` | `0742969974b56d5351d5f742d0375df40e31d77d2469455fc1f5b510b22af182` |
| `packages/opencode/test/session/compaction.test.ts` | `af2bf5a3750c6de88bd6cc1d6244326a36587f8e4703beb683616abe628d4874` |
| `packages/schema/test/event-manifest.test.ts` | `c97d32463b778085f80b1366db2e4529c148a0c47b2817267827ef75f3f2ea4f` |
| `packages/opencode/src/tool/task.ts` | `ad9a38c2581cff12593145f9eeac8a6a6223944990b2f7c1874cf5be46580a4d` |
| `packages/opencode/src/session/tools.ts` | `ee148f4a9d7a1c61b25d4bda0c09bfdb05828be3e5cb05b6154e98f95680f085` |
| `packages/opencode/test/tool/task.test.ts` | `b76d0f91e6722265fce012fc1f3dba45f91f1e2d09bdda773c4bbc0f8b42bcc8` |
| `packages/plugin/src/index.ts` | `dec609e63977d34c5f0e72a47ccb3932092bcaa836bff9e00613eb0f65dfb218` |
| `packages/plugin/src/tool.ts` | `edb2b6453e9cc23be3bd69b2ff1c014ba3c8c224e450b1f30aa2ce750f9f9a48` |

Require exact equality before owning work. `prompt.test.ts` stays byte-identical. T06 seals prompt/hunk preservation; after T06, T07 remeasures the full manifest and its five host pins, then records exact pre/post manifests while preserving prior dirty hunks.

## Named design seams

- **Budget owner:** `ContextBudget.evaluate` in `packages/opencode/src/session/overflow.ts`; normal and compaction requests use it exclusively.
- **Compatibility:** retain `usable`/`isOverflow` signatures and auto-compaction semantics as adapters. Keep public `SessionV1.ContextOverflowError` shape/text, including pinned `"Input exceeds context window of this model"`; map internal errors only at the session boundary.
- **Limit decode:** absent limits may use allowed `Infinity`; present non-finite/negative/invalid values fail closed. Zero follows frozen absent/unknown semantics.
- **Tools:** `Prepared.tools` stays executable. Separate immutable `budgetProjection.tools` is data-only `{name,description,inputSchema}` and never drives dispatch.
- **Final pre-network payload:** preparation builds shared semantic input, but admission derives from the exact final model-visible payload at the last branch seam. Native uses the post-`LLMRequest.update` value after tool definitions are appended; projection, admission, and `llmClient.stream` receive that same final value, while `LLMNative.request` is only the pre-update base request. AI SDK refactors the existing middleware transform into one named final-transform helper: that helper is the sole owner of `ProviderTransform.message`, the middleware delegates to or is replaced by it, and budgeting plus `streamText` reuse its single transformed result immediately before dispatch. Both branches expose canonical golden projections; neither estimates an earlier approximation.
- **Request identity:** SHA-256 of selected provider/model/runtime plus canonical final projection; route identity qualifies evidence but is not prompt content.

## Independent TDD contract

Each task runs tests-only `test-writer` (`glm-5.3-flash`, max), read-only `red-verifier` (`deepseek-v4-flash`, max), source-only `implementer` (`qwen3.8-thinking`, xhigh), read-only `green-verifier` (`deepseek-v4-flash`, max), then read-only `task-reviewer` (`glm-5.3-flash`, max). The writer states expected RED and records SHA-256 for every accepted test/fixture; after RED those files are immutable. A task needing another path stops for plan amendment. T03/T05 serialize compaction files; T04/T06 serialize the LLM seam; T05 then T06 serialize internal-event inventory/manifest tests; T06 then T07 serialize dirty OpenCode work.

`packages/opencode/test/session/compaction.test.ts` belongs only to T05: remeasure its pin, add only execution/persistence assertions, then seal the accepted hash. T01 owns only new `overflow.test.ts`; T01-T04 otherwise run it unchanged. `packages/schema/test/event-manifest.test.ts` is a sequential handoff: T05 remeasures the pinned baseline and seals its +1-internal-event version; T06 remeasures that accepted hash and seals its +2 version. `prompt.test.ts` is never a test touch-set.

Common read set: both authoritative specs, `AGENTS.md`, `packages/opencode/src/session/llm/AGENTS.md`.

## Behavior tasks

### T01 — Budget algebra, compatibility, canonical estimator

- **Behavior / RED:** implement the sole evaluator; RED is absent route-complete math and invalid-limit handling.
- Pin `G=16_384`, `M=4_096`, `H=20_480`, default reserve `20_000`, and `O=min(valid route output, requested runtime output)`. Compute `contextBudget=C>0 ? C-max(Rcfg,O+H) : Infinity`, `inputBudget=I>0 ? I-max(Rcfg,H) : Infinity`, `B=max(0,min(...))`; explicit input does not subtract output twice. Admit `E<=B`, reject `E>=B+1`; Qwen boundary is 209,664/209,665.
- Absent limits follow frozen `Infinity` semantics; present non-finite/negative values fail closed with typed evidence. Test zero/absent separately from invalid. Canonical serialization sorts object keys, preserves arrays, excludes functions/`undefined`, and estimates `ceil(chars/4)`.
- Preserve `usable`/`isOverflow`, `auto:false`, and public error shape/text.
- Evidence includes route/runtime, phase, estimate, budget, limits, allowance, chunk count, request hash, and reason. Add internal `ContextBudgetExceededError` and `CompactionImpossibleError` only.
- **test_touch_set:** new `packages/opencode/test/session/overflow.test.ts` only. Existing `compaction.test.ts` is related, byte-unchanged validation until T05.
- **source_touch_set:** `packages/opencode/src/session/overflow.ts`.
- **Dependencies/validation:** none; parallel T02; high risk; run `overflow.test.ts` plus unchanged `compaction.test.ts`.

### T02 — Shared preparation, executable tools, conservative media

- **Behavior / RED:** separate runtime preparation from canonical data projection; RED is executable tools conflated with an incomplete estimate.
- Keep `Prepared.tools` executable and unchanged for GitLab inline execution, native `ToolRuntime`, and AI SDK. Add `budgetProjection` with transformed system/messages, current input/tool calls/results, max-step additions, active tool name/description/JSON schema, serialization-affecting options, and output allowance. Functions never enter the projection.
- Budget media without raw binary: strings/bytes use type/name, length and SHA-256; URI/data/blob/provider handles use type/name/source-kind and max(known encoded length, deterministic envelope overhead). Never dereference media; unknown size fails closed. Compaction may use frozen placeholders.
- Run plugin system/params/headers before projecting normalized immutable branch inputs. Normal output stays 32,000; compaction uses `min(4_096, route output, runtime cap)`.
- Tests prove late system/plugin/tool-schema/media growth affects `E` and an inline GitLab workflow tool still executes through `Prepared.tools[tool].execute` (not the data-only projection).
- **test_touch_set:** `packages/opencode/test/session/llm-request-budget.test.ts` (new).
- **source_touch_set:** `packages/opencode/src/session/llm/request.ts`.
- **Dependencies/validation:** none; parallel T01; high risk; focused test plus `llm.test.ts`/`message-v2.test.ts`.

### T03 — Pure bounded compaction planner

- **Behavior / RED:** create a nonpersistent, complete-turn planner; RED is unbudgeted slice selection and no rolling-summary bound.
- Replace media with deterministic placeholders and cap historical tool output at 2,000 chars without altering durable rows. Preserve latest user turn intact. Tail settings are maxima. Group older history on user-turn boundaries; never split tool call/result; only split one oversized text part with role/order metadata.
- Plan at most four chunks. For **each** proposed request, include fixed transformed compaction overhead, next chunk, latest intact turn/tail, and a conservative worst-case prior rolling summary of up to 4,096 output tokens. Pin the serialized prior-summary reserve as `4_096 * 4 = 16_384` characters plus canonical message-wrapper overhead measured by the same projection; do not plan a chunk that only fits when the prior summary is empty.
- Evaluate fixed overhead/latest turn before calls; a fifth chunk is `chunk-limit`. Deterministic boundaries/hashes must be stable.
- **test_touch_set:** `packages/opencode/test/session/compaction-budget.test.ts` (T03 owns planner cases).
- **source_touch_set:** `packages/opencode/src/session/compaction.ts`.
- **Dependencies/validation:** T01,T02; parallel T04, never T05; high risk; focused plus unchanged compaction/message tests.

### T04 — Exact final-payload gate and native/AI-SDK parity

- **Behavior / RED:** gate both branch-final payloads at their last pre-network seams; RED is AI SDK late middleware/native lowering drift.
- Add canonical adapters at lowering seams. Native projects the exact post-`LLMRequest.update` value sent to `llmClient.stream`; AI SDK uses the sole named final transform and projects the exact `streamText` params it returns. Include model-visible/provider serialization fields, tools, choice and allowance; exclude auth/transport-only data and functions.
- Recompute after any route/runtime change. A rejection makes zero native, `streamText`, HTTP, or attempt calls. A route-qualified in-memory ledger blocks a repeated `(route,requestHash)` after provider overflow during that invocation; durable lineage ownership comes in T06.
- Tests compare golden canonical payloads at both seams, catch drift, preserve executable tools, and prove normal 32,000/compaction 4,096. `auto:false` never bypasses admission.
- **test_touch_set:** `packages/opencode/test/session/llm-context-budget.test.ts` (new), native/AI parity golden fixtures under `packages/opencode/test/fixtures/context-budget/`.
- **source_touch_set:** `packages/opencode/src/session/llm.ts`, `packages/opencode/src/session/llm/native-request.ts`, `packages/opencode/src/session/llm/native-runtime.ts`; `packages/opencode/src/provider/transform.ts` only if the named final AI transform cannot be exported without it.
- **Dependencies/validation:** T01,T02; parallel T03; critical; focused plus LLM/native/recorded suites.

### T05 — Rolling-summary execution and replayable atomic finalization

- **Behavior / RED:** execute T03 safely and persist only a proven final summary; RED is early persistence and missing atomic/replay behavior.
- For one-to-four chunks, build the actual request from prior rolling summary plus next chunk and rerun T04 admission. A prior summary exceeding its 4,096-token/serialized reserve, or a real request no longer fitting, stops `mid-execution-over-budget` with no later call. Keep all intermediate summaries, objects, markers, usage, and projections in memory; abort leaves durable rows byte-equivalent to entry.
- Require `E_after<E_before` and `E_after<=B`, then publish one versioned internal durable `CompactionFinalized` full-state event carrying deterministic IDs, complete assistant/message/parts, marker, usage, recent text, and before/after projection. Its dedicated Core projector writes existing rows directly in the event transaction; do **not** route it through public `SessionMessageUpdater` or edit `message-updater.ts`. Notifications/autocontinue follow commit. Cold replay into a fresh DB reconstructs rows once; a commit fault leaves neither event nor rows. `PublishOptions.commit` is never serialized replay authority.
- Add it only to new `SessionEvent.InternalDurableDefinitions`, never `Definitions` or `DurableDefinitions`. `packages/schema/src/durable-event-manifest.ts` unconditionally includes that inventory for storage replay. Public OpenAPI/SDK/root/generated files and public definition counts stay byte-identical; only durable internal count changes.
- **test_touch_set:** existing `packages/opencode/test/session/compaction.test.ts` (exclusive owner), T03's `compaction-budget.test.ts` execution cases, new `packages/core/test/session-compaction-finalization.test.ts`, focused `packages/core/test/session-projector.test.ts`, and `packages/schema/test/event-manifest.test.ts`.
- **source_touch_set:** `packages/opencode/src/session/compaction.ts`, `packages/schema/src/session-event.ts`, `packages/schema/src/durable-event-manifest.ts`, `packages/core/src/session/projector.ts`. No `session.ts` or message-updater scope.
- **Dependencies:** T03,T04. **Parallelizable:** none. **Risk:** critical. **Validation:** focused suites; transaction fault; cold replay; T03/manifest hash handoffs; public/generated byte identity.

### T06 — Event-log lineage, one-shot repair, and recorded proof

- **Behavior / RED:** replace prior-usage admission with one durable-lineage compact/rebuild cycle. Add versioned internal durable `ContextBudgetLineage` full-state events keyed in payload by `{sessionID,userMessageID}`, carrying expected/new `generation`, `compaction_count` (0/1), sorted route ledger `(providerID,modelID,runtime,requestHash,outcome)`, overflow hashes, exact pre-dispatch entries, and durable-output watermark.
- Lineage is **event-log only**: no SQL table, migration, or materialized lineage row. Add it only to `SessionEvent.InternalDurableDefinitions`, never public `Definitions`/`DurableDefinitions`, and unconditionally register it through `durable-event-manifest.ts`. A Core internal read/fold helper queries the latest event with the existing `(aggregate_id,type,seq)` index (`ORDER BY seq DESC LIMIT 1`), validates/folds the serialized full state, and performs bounded reads; cold replay folds ordered events.
- T04 exports an awaited final-pre-network callback receiving exact final route/runtime/projection/hash. Under session serialization, publish the next full-state lineage event; use immediate-transaction `PublishOptions.commit` **only** to compare expected generation with the latest indexed event (CAS). Serialized events remain replay authority. CAS mismatch/replay conflict means zero native/`streamText`/HTTP/provider call and zero chargeable route/model/provider attempt. After overflow, record outcome/watermark before repair; require unchanged watermark, counter 0, and no durable assistant/tool/step output.
- Oversized preflight with auto compaction consumes the one counter, reloads, compacts, rebuilds, and admits once. `auto:false` writes no compaction and calls no provider. Second overflow, changed watermark, unavailable compaction, same hash, no reduction, or oversized rebuild is terminal. Restart cannot redispatch known pending/overflow hashes; prior usage remains telemetry.
- Test initially fitting then late overflow across a fresh runtime; prove generation/watermark/ledger/hash/counter prevent duplicate transport/compaction. Retain native/AI, reserve `12000`, <=4,096 summary, 32,000 rebuild, and `E<=209,664` proofs. Recordings are credential-free no-regression evidence, not fallback proof.
- **test_touch_set:** new `packages/opencode/test/session/prompt-context-budget.test.ts`, `qwen-context-budget-recorded.test.ts`, new `packages/core/test/session-context-budget-lineage.test.ts`, T05-accepted `packages/schema/test/event-manifest.test.ts`, and recordings under `packages/opencode/test/fixtures/recordings/session/`.
- **source_touch_set:** dirty `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/processor.ts`, T04 seam `packages/opencode/src/session/llm.ts`, `packages/schema/src/session-event.ts`, `packages/schema/src/durable-event-manifest.ts`, and new internal `packages/core/src/session/context-budget-lineage.ts`. No message-updater/projector table or migration and no public/generated schema.
- **Dependencies:** T04,T05. **Parallelizable:** none. **Risk:** critical. **Validation:** focused/Core/schema suites; indexed latest scan and cold fold; CAS-failure zero-network/restart proof; protected pins/manifest.

### T07 — Candidate-child fallback and principal-bound model handoff

- **Repositories / prerequisite:** companion `/home/wdcas/projects/pessoal/opencode-workflows` and narrow OpenCode additions. Depends on T06 and completed, validated, restarted liveness bootstrap **B0**; serialize after T06.
- `ModelRoutingStore.nextRoute()` supplies the durable candidate for journaled/reserved `TaskDispatchCard.model`. Reservation, Task invocation, and child creation are non-chargeable; each child admits its exact T04/T06 payload.
- **Principal capability:** `Plugin.applyPlugin` resolves `{resolvedPluginID,source,canonical package name/file target,configured spec}`. Its per-activation registrar works only for the expected workflows principal, normally `opencode-workflows-v2` from `@shodocan/opencode-workflows`; ID alone is insufficient. For npm activation the host requires the canonical resolved package name to equal the package name parsed from the configured spec; for file activation it requires the resolved entry realpath to equal the configured-file realpath. Any mismatch rejects before registration. No caller identity; exactly one resolver registers; malicious/mismatched first or duplicate registration fails activation, teardown removes it, reload starts empty, and others get no authority. `packages/plugin/src/index.ts` defines capability types.
- Resolver replaces generic hook output and returns closed `not_applicable | bound | reject`. Host passes only host-minted `{sessionID,callID,taskOrigin}`. Plugin strict replay proves parent/call/attempt/node/phase/card/hash/model exactly. Ambiguous partial ownership is `reject`; unbound non-workflow is `not_applicable`. Host catalog validates `bound`; only `bound` outranks agent default. Invalid workflow binding fails closed; capability data stays host-only.
- Final preflight incompatibility makes zero native, `streamText`, HTTP, provider, or chargeable attempt call and yields typed `route_incompatible` `{route,requestHash,evidence,reason}`. Foreground `TaskTool` catches it and returns success-shaped internal metadata so after-hook runs; metadata is wakeup/cross-check only. Background `running` is nonterminal; terminal evidence comes from historical catch-up plus live internal lineage events. Add no host durable event: T06 `ContextBudgetLineage` is sole restart authority. Plugin verifies child `TaskOrigin`, persisted attempt/card, route/hash/card hash.
- One workflow-journal CAS append atomically records typed child record plus `route_budget_skip`. Dedup by lineage-event identity plus attempt/route/hash: exact duplicate no-ops; conflict rejects. Emit no `model_result_recorded`; increment no route/provider/correction/dispatch/repair/proxy counter. Next card follows commit; catch-up handles crashes.
- **Cursor:** skip sets `route_index+1`, `route_attempts=0`, preserving unrelated counters. Last skip persists one-past-end `route_index===chain.length`, `route_attempts=0`; `nextRoute()` returns `null`.
- **workflow touch sets:** tests: new `test/v02/context-budget-fallback.test.ts`; additions to `model-routing-store.test.ts`, `model-routing-scheduling.test.ts`, `exact-card-adapter.test.ts`, `dispatch.test.ts`, `child-events.test.ts`, `server.test.ts`, `integration.test.ts`, `route-advance.test.ts`, and schema/replay tests. Source: `src/v02/{model-routing-store,model-routing-schemas,coordinator,dispatch,exact-card-adapter,child-events,route-advance,store,schemas}.ts`, `server/index.ts`, `tool/workflow.ts`, `types/{state,packet}.ts`; catch-up/live: `src/v02/server/index.ts` consumes OpenCode `packages/core/src/event.ts` and `packages/opencode/src/event-v2-bridge.ts` . Catch-up tests: `server.test.ts`, `integration.test.ts`, `packages/core/test/event.test.ts`, plus plugin tests.
- **OpenCode test_touch_set:** dirty `packages/opencode/test/tool/task.test.ts`; new `packages/opencode/test/plugin/task-model-binding.test.ts` and `packages/opencode/test/session/workflow-route-incompatible.test.ts`. Cover same-ID wrong package/file, first malicious registration, duplicate, teardown/reload, forged/cross-call origin, partial ownership, `not_applicable` default, foreground, background running, delayed completion, crash-before-plugin, restart catch-up, exact/conflicting duplicates. T04/T06 tests are immutable.
- **OpenCode source_touch_set:** dirty `packages/opencode/src/tool/task.ts`, `packages/opencode/src/session/tools.ts`, `packages/plugin/src/index.ts`; `packages/opencode/src/plugin/index.ts` and any config/plugin-loading principal type needed; event plumbing as needed. Dirty `packages/plugin/src/tool.ts` only if protected `TaskOrigin` typing changes. T07 owns these additions.
- **Dependencies:** T06,B0. **Parallelizable:** none. **Risk:** critical. **Validation:** focused tests/typechecks/build; prove principal isolation, catalog precedence, completion/restart/dedup, exhaustion, zero network/charge/counter effects, and one fitting larger-route send.

## Dependency and parallelism map

```text
T01 || T02
  \     /
   T03 || T04
     \   /
       T05 -> T06 ----\
B0 (liveness bootstrap) -> T07 -> one cross-repo whole-change APR
```

T01 owns new overflow tests; T05 owns/seals existing compaction tests. T03->T05 serialize compaction; T04->T06 serialize LLM; T05->T06 serialize internal inventory/manifest; T06->T07 serialize dirty OpenCode work. B0 is an external hard prerequisite. No overlapping writes run concurrently.

## Final validation

Before/after every stage compare the complete manifest and allow only declared paths. From package directories run every focused T01-T07 test plus related compaction, LLM/native/recorded, message, processor, prompt, session, task, plugin-trigger, Core finalization/lineage/projector, and Schema manifest suites; run the recorded Qwen scenario and `bun typecheck`. Inspect status/diff and lint changed Qwen source only. Require no config/public Definitions/OpenAPI/SDK/generated diff, exact bounds, direct atomic final projector, event-only lineage/CAS restart proof, host-only card-model precedence, and all dirty pins/hunks preserved (`prompt.test.ts` exact).

**cwd `/home/wdcas/projects/pessoal/opencode-workflows`:** after B0 GREEN and plugin restart, run T07 focused/related model-routing, dispatch, exact-card, child-event, server/integration/native-adapter suites, then `npm run typecheck && npm run build`. Require reservation/child preparation evidence but zero chargeable provider attempt/network call for incompatible routes, durable skip replay, and an independently fitting larger-cap send. Recorded fixtures cannot replace this gate; T07 and one final cross-repo APR must be GREEN.
