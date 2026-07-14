---
artifact: plan
template_version: "1.1"
plan_id: "PLAN-pre-v1.17.20-merge-regression-tripwires-v1"
title: "Pre-v1.17.20 Merge Regression Tripwires Implementation Plan"
status: "completed"
created_at: "2026-07-14"
updated_at: "2026-07-14"
spec_id: "PLAN_SPEC-pre-v1.17.20-merge-regression-tripwires"
spec_path: "inline caller input; no repository spec artifact supplied"
spec_approved_commit: "e0521323c113a0437fafb9307722f6973a5f2ea5"
branch: "fork/main"
worktree: "/home/wdcas/projects/pessoal/opencode-mcp-pr"
visual_evidence_root: "artifacts/pre-v1.17.20-merge-regression-tripwires/evidence"
task_type_enum:
  - coding
  - coding-ui
  - documentation
  - research
  - review
  - tester
---

# Pre-v1.17.20 Merge Regression Tripwires

## 1. Goal, Immutable Scope, and Constraints

**Goal:** Add pre-v1.17.20-merge regression tripwires that pass on current clean fork/main and fail if fork-critical behavior is lost during merge.

**Architecture:** Add production-path assertions for TaskTool model resolution, vLLM extra-body transport, and the Codex OAuth fetch hook. Extract the component-local TUI hidden queue into a behavior-preserving, non-public primitive so its FIFO, session isolation, later activation, and metadata contract can be tested. Keep the retained prompt-event suite canonical and remove its duplicate.

**Tech stack:** Bun tests, TypeScript, Effect test fixtures, local `Bun.serve` HTTP captures, Solid TUI component code, and repository typechecks.

### Immutable scope and constraints

- Tests-only where possible; the TUI queue seam is the sole permitted production change and must preserve behavior.
- No upstream merge, release, commit, SDK generation, public API change, or unrelated cleanup.
- Use existing repository style, minimal helpers, no mocks or `globalThis` overrides, no `any`, and ASCII-only edits.
- Use `apply_patch` or manual edits only; run tests from package directories, never from repository root.
- Do not modify the known unrelated `packages/opencode/test/session/prompt.test.ts` LLM call-count failure.
- No external network: vLLM and Codex checks use local `Bun.serve` endpoints.
- The approved baseline is clean `fork/main` at `e0521323c113a0437fafb9307722f6973a5f2ea5`, with upstream `origin/fork/main`; this is a reference only, not a commit to create.
- The approved spec is immutable; spec impact is `none`. Frozen user-choice decision ledger is empty and no new human choice is permitted.

## 2. Frozen Decision Ledger and Provenance

- `plan_spec.status`: `approved`.
- Approval source: user explicit request, "prepare some tests, so we can ensure there are no regression before merge".
- `user_choices.status`: `frozen`.
- Decision ledger: empty; no additional choices.
- No merge, release, or commit is part of this plan.
- Spec source: frozen PLAN_SPEC supplied inline in caller messages; no repository artifact path was supplied.
- Baseline provenance: `fork/main` at `e0521323c113a0437fafb9307722f6973a5f2ea5` (approved reference); remote reference `origin/fork/main`.

## 2a. Worktree and Tracking Protocol

- Work only in the existing tracked checkout `/home/wdcas/projects/pessoal/opencode-mcp-pr` on `fork/main`.
- Do not create or switch worktrees or branches.
- Do not commit changes; this plan records worktree evidence only.
- Before implementation begins, verify `fork/main` is at the approved baseline and the worktree is clean.
- If the baseline is dirty before implementation, stop and escalate; do not modify or clean the unrelated changes.

## 3. Acceptance Criteria and Traceability

| AC ID | Exact acceptance criterion | Implemented by | Concrete validation | Status |
|---|---|---|---|---|
| AC-1 | TaskTool production execution: valid caller model+variant records selected variant/source; variant-only binds to parent or agent model; invalid model/variant fallback strips stale variant and records warning/source. Prefer existing task.test.ts helpers and public TaskTool execute path. | T010 | `cd packages/opencode && bun test --timeout 30000 test/tool/task.test.ts`; inspect captured prompt input and metadata assertions | pass |
| AC-2 | vLLM production path: replace/supplement copied stop-recovery L0 logic with a local HTTP capture through actual Provider SDK resolution; prove recognized/extraBody keys reach outgoing OpenAI-compatible JSON and hosted/non-compatible path is not wrapped. No global fetch override or external network. | T020 | `cd packages/opencode && bun test --timeout 30000 test/stop-recovery-l0-capture.test.ts`; local server request JSON and wrapper/non-wrapper assertions | pass |
| AC-3 | Codex OAuth production hook: prove original `/v1/responses` remaps to configured endpoint, request JSON body is preserved, stale incoming Authorization is replaced, account header is set. Extend existing local Bun.serve test. | T030 | `cd packages/opencode && bun test --timeout 30000 test/plugin/codex.test.ts`; captured path, body, Authorization, and account header assertions | pass |
| AC-4 | TUI production queue/event contract: retain one canonical prompt-events test, cover append session filtering and synthetic per-session FIFO/isolation/later activation using extracted production queue primitive only if component-local queue cannot be tested directly. Preserve visible/caller metadata shape. | T040 | `cd packages/tui && bun test --timeout 30000 test/prompt-events.test.ts` and `cd packages/tui && bun test --timeout 30000 test/cli/tui/prompt-submit-race.test.ts`; `cd packages/tui && bun typecheck` | pass |

## 4. Architecture and Test Strategy

- TaskTool tests call `TaskTool.execute` through existing `seed`, `stubOps`, `reply`, and `testEffect` fixtures; private `resolveTaskModel` is not tested directly.
- vLLM tests use a local dynamic-port `Bun.serve({ port: 0, fetch })`, actual `Provider.Service` SDK resolution, and request capture. The production `VLLM_EXTRA_BODY_KEYS` and `collectExtraBody` behavior is exercised transitively through that resolution rather than copied into the test.
- Codex extends the existing local server test around `CodexAuthPlugin`, passing stale input headers and JSON body, then asserting the configured endpoint receives the forwarded body and replacement headers.
- TUI extraction keeps `createPromptEventHandlers` unchanged in contract and moves only the component-owned queue mechanics behind an internal exact module interface. The component remains the sole adapter of `MCP_VISIBLE_METADATA.visible` and caller metadata; tests assert the same visible/caller shape.

## 5. File and Artifact Map

| Path | Action | Responsibility | Owning task |
|---|---|---|---|
| `packages/opencode/test/tool/task.test.ts` | modify | Public TaskTool execute regression assertions | T010 |
| `packages/opencode/test/stop-recovery-l0-capture.test.ts` | modify | Local HTTP capture through production Provider SDK resolution | T020 |
| `packages/opencode/test/plugin/codex.test.ts` | modify | Existing local Codex hook capture with path/body/header assertions | T030 |
| `packages/tui/src/component/prompt/hidden-prompt-queue.ts` | create | Internal production queue primitive extracted from prompt component | T040 |
| `packages/tui/src/component/prompt/index.tsx` | modify | Adapter wiring to extracted queue; preserve component behavior and metadata | T040 |
| `packages/tui/test/prompt-events.test.ts` | modify | Canonical prompt event and extracted queue contract suite | T040 |
| `packages/tui/test/prompt/prompt-events.test.ts` | delete | Duplicate prompt-events suite; retain canonical suite only | T040 |
| `artifacts/pre-v1.17.20-merge-regression-tripwires/plan.md` | create | This execution plan and evidence record | plan authoring |

No visual artifacts are applicable: this plan adds behavioral regression tests and an internal non-visual queue seam.

## 6. Definition of Done and Mandatory Validation

- [x] T010, T020, T030, and T040 each have exact assertions, targeted passing validation, and review evidence.
- [x] T990 passes all focused opencode tests, focused TUI tests including `prompt-submit-race`, both package typechecks, and `git diff --check`.
- [x] The known unrelated prompt call-count failure is not changed or treated as a plan failure.
- [x] T999 records completion-time action-verifier and task-reviewer-qwen evidence; no future gate is claimed in this authored plan.

**Mandatory validation AC:** "focused opencode tests; opencode typecheck; focused TUI tests including prompt-submit-race; TUI typecheck; git diff --check."

**Mandatory execution review gates:** "action-verifier proves new assertions invoke production behavior and all validations pass; task-reviewer-qwen (per-call GLM 5.2 override) reviews final diff against matrix."

## 7. Bounded Implementation Tasks

### T010 - Add TaskTool production model-resolution tripwires

- **task_type:** `tester`
- **Status:** `pass`; **Priority:** `P1`
- **Depends on:** `none`; **Parallel-safe:** `yes`
- **Covers:** AC-1
- **Exact files:** modify `packages/opencode/test/tool/task.test.ts` only.
- **Interfaces/symbols:** consume public `TaskTool.execute`, existing `seed`, `stubOps`, `reply`, `testEffect`, `stubModel`, and `Provider.Service`; capture `SessionPrompt.PromptInput` and resulting warning/source metadata.
- **Invariants:** no direct private resolver calls; valid caller model+variant wins; variant-only binds to parent or agent model; invalid model/variant removes stale variant and records warning/source; existing tests remain valid.
- **Action manifest:** `packages/opencode/test/tool/task.test.ts`; command `cd packages/opencode && bun test --timeout 30000 test/tool/task.test.ts`.
- **Verification instructions for action-verifier:** read the added cases and confirm each invokes `TaskTool.execute`; verify captured prompt input and metadata prove all three override outcomes; run the named test command and require pass.
- **Review instructions for task-reviewer-qwen:** check public-path coverage, source/warning assertions, fixture reuse, no private resolver testing, no mocks/global overrides, and no unrelated edits.
- **Completion criterion:** one focused test file passes with assertions that fail when the production TaskTool override behavior is removed.

Steps:

- [x] Add production `TaskTool.execute` cases using existing fixture helpers for valid model+variant, variant-only, and invalid model/variant fallback.
- [x] Capture prompt input and returned/session metadata, asserting selected model, variant, source, warning, and stale-variant removal exactly for each case.
- [x] Run `cd packages/opencode && bun test --timeout 30000 test/tool/task.test.ts` and require pass.
- [x] Review the diff for only this test file and record output in the completion record.

### T020 - Replace copied vLLM simulation with production SDK capture

- **task_type:** `tester`
- **Status:** `pass`; **Priority:** `P1`
- **Depends on:** `none`; **Parallel-safe:** `yes`
- **Covers:** AC-2
- **Exact files:** modify `packages/opencode/test/stop-recovery-l0-capture.test.ts` only.
- **Interfaces/symbols:** exercise `Provider.Service` SDK resolution transitively, including production `VLLM_EXTRA_BODY_KEYS` and `collectExtraBody` behavior, and capture the OpenAI-compatible SDK fetch path with `Bun.serve({ port: 0, fetch })` and `server.url`.
- **Invariants:** no copied production logic as the assertion subject; no `globalThis.fetch` override; no external network; recognized and extra keys are captured in outgoing JSON; hosted/non-compatible models are not wrapped.
- **Action manifest:** `packages/opencode/test/stop-recovery-l0-capture.test.ts`; local server only; focused Bun test command.
- **Verification instructions for action-verifier:** trace each assertion to actual Provider SDK resolution and confirm the local server received the JSON; confirm non-compatible behavior bypasses wrapping; run the named test command and require pass.
- **Review instructions for task-reviewer-qwen:** check actual production resolution, request-body key coverage, wrapper condition coverage, local server disposal, and absence of duplicated logic/global fetch mutation.
- **Completion criterion:** the copied simulation is replaced or supplemented by a focused local capture that fails when production extra-body routing regresses.

Steps:

- [x] Inspect the existing test and retain only useful scenario names while replacing assertions that mirror production logic.
- [x] Configure a local dynamic-port HTTP capture through actual Provider SDK resolution for recognized and extra-body keys.
- [x] Assert the OpenAI-compatible request JSON contains the expected keys and assert a hosted/non-compatible path is not wrapped.
- [x] Run `cd packages/opencode && bun test --timeout 30000 test/stop-recovery-l0-capture.test.ts` and require pass.
- [x] Review the diff for local-only networking and record captured request evidence.

### T030 - Extend the Codex OAuth endpoint/body/header tripwire

- **task_type:** `tester`
- **Status:** `pass`; **Priority:** `P1`
- **Depends on:** `none`; **Parallel-safe:** `yes`
- **Covers:** AC-3
- **Exact files:** modify `packages/opencode/test/plugin/codex.test.ts` only.
- **Interfaces/symbols:** consume `CodexAuthPlugin`, `loaded.auth.loader`, `loaded.fetch`, configured `codexApiEndpoint`, and existing local `Bun.serve` capture.
- **Invariants:** original `/v1/responses` maps to configured endpoint; JSON body is preserved; stale incoming Authorization is replaced by refreshed Bearer auth; account header is set; refresh deduplication remains covered.
- **Action manifest:** `packages/opencode/test/plugin/codex.test.ts`; local Bun server and focused test command.
- **Verification instructions for action-verifier:** confirm the request starts at the original OpenAI URL but the capture receives configured path, exact JSON body, replacement Authorization, and account header; run the named test command and require pass.
- **Review instructions for task-reviewer-qwen:** check body preservation via `RequestInit`, stale-header replacement, endpoint assertion, existing refresh assertions, and no production-file edits.
- **Completion criterion:** the existing local test fails if any endpoint remap, body forwarding, auth replacement, or account-header behavior is lost.

Steps:

- [x] Extend the existing capture record with request pathname and parsed JSON body.
- [x] Call `loaded.fetch` with a stale Authorization header and representative JSON `RequestInit` body.
- [x] Assert configured remapped path, unchanged body, refreshed Bearer header, and account header while retaining refresh deduplication assertions.
- [x] Run `cd packages/opencode && bun test --timeout 30000 test/plugin/codex.test.ts` and require pass.
- [x] Review the diff for existing-server-only changes and record request evidence.

### T040 - Extract and test the production TUI hidden queue contract

- **task_type:** `coding`
- **Status:** `pass`; **Priority:** `P1`
- **Depends on:** `none`; within this task, extraction and production wiring precede canonical test updates and duplicate deletion; **Parallel-safe:** `no`
- **Covers:** AC-4
- **Exact files:** create `packages/tui/src/component/prompt/hidden-prompt-queue.ts`; modify `packages/tui/src/component/prompt/index.tsx` and `packages/tui/test/prompt-events.test.ts`; delete `packages/tui/test/prompt/prompt-events.test.ts`.
- **Interfaces/symbols:** extract an internal `createHiddenPromptQueue` primitive with explicit per-session enqueue/drain/activation callbacks and FIFO state; export that internal module symbol for the canonical test to consume, without adding a package export; adapt `index.tsx` without changing its visible/caller metadata path or public exports.
- **Invariants:** per-session `Map` and in-flight `Set` semantics remain; FIFO order is preserved; sessions are isolated; later activation drains queued work; synthetic events do not mutate visible append path; `MCP_VISIBLE_METADATA.visible` and caller metadata shape are unchanged; no public API is added.
- **Action manifest:** `packages/tui/src/component/prompt/hidden-prompt-queue.ts`, `packages/tui/src/component/prompt/index.tsx`, `packages/tui/test/prompt-events.test.ts`, `packages/tui/test/prompt/prompt-events.test.ts`; focused TUI tests and typecheck.
- **Verification instructions for action-verifier:** compare old component queue behavior with the extracted primitive, confirm `index.tsx` uses it in the production path, run prompt-events and prompt-submit-race tests plus TUI typecheck, and require all pass.
- **Review instructions for task-reviewer-qwen:** check seam minimality, exact FIFO/session/later-activation behavior, metadata preservation, duplicate deletion, no public export, and no unrelated UI changes.
- **Completion criterion:** canonical suite covers append filtering and synthetic FIFO/isolation/later activation through the extracted production primitive; duplicate suite is deleted; focused tests and typecheck pass.

Steps:

- [x] Extract the existing component-local queue state and drain/activation behavior into `hidden-prompt-queue.ts`, exposing only the internal module symbol needed by the canonical test and no package export.
- [x] Replace the corresponding `index.tsx` queue implementation with the adapter while preserving `MCP_VISIBLE_METADATA.visible`, caller metadata, and synthetic/visible event routing.
- [x] After extraction and wiring, extend canonical `packages/tui/test/prompt-events.test.ts` to assert per-session FIFO, isolation, and later activation through the production primitive, retaining append filtering and synthetic path assertions.
- [x] After the canonical suite is updated, delete `packages/tui/test/prompt/prompt-events.test.ts` and confirm no test import depends on it.
- [x] Run `cd packages/tui && bun test --timeout 30000 test/prompt-events.test.ts`, `cd packages/tui && bun test --timeout 30000 test/cli/tui/prompt-submit-race.test.ts`, and `cd packages/tui && bun typecheck`; require pass.
- [x] Review the four-file diff for behavior-preserving scope and record evidence.

## 8. Mandatory Final Tasks

### T990 - Focused complete validation

- **task_type:** `tester`; **Status:** `pass`; **Priority:** `P0`; **Depends on:** T010, T020, T030, T040; **Parallel-safe:** `no`.
- **Covers:** AC-1, AC-2, AC-3, AC-4 and mandatory validation AC.
- **Files/artifacts:** read `packages/opencode/test/tool/task.test.ts`, `packages/opencode/test/stop-recovery-l0-capture.test.ts`, `packages/opencode/test/plugin/codex.test.ts`, `packages/tui/src/component/prompt/hidden-prompt-queue.ts`, `packages/tui/src/component/prompt/index.tsx`, `packages/tui/test/prompt-events.test.ts`, `packages/tui/test/prompt/prompt-events.test.ts`, and `artifacts/pre-v1.17.20-merge-regression-tripwires/plan.md`; update this plan's evidence only.
- **Validation matrix:**
  - `cd packages/opencode && bun test --timeout 30000 test/tool/task.test.ts` - TaskTool tripwires pass.
  - `cd packages/opencode && bun test --timeout 30000 test/stop-recovery-l0-capture.test.ts` - production local vLLM capture passes.
  - `cd packages/opencode && bun test --timeout 30000 test/plugin/codex.test.ts` - Codex path/body/header capture passes.
  - `cd packages/opencode && bun typecheck` - opencode typecheck passes.
  - `cd packages/tui && bun test --timeout 30000 test/prompt-events.test.ts` - canonical TUI contract passes.
  - `cd packages/tui && bun test --timeout 30000 test/cli/tui/prompt-submit-race.test.ts` - race regression passes.
  - `cd packages/tui && bun typecheck` - TUI typecheck passes.
  - `rtk git diff --check` - no whitespace errors.
- **Steps:**
  - [x] Run every matrix command from its package directory and capture pass/fail output.
  - [x] Confirm the known out-of-scope prompt call-count failure was not modified or included in the command set.
  - [x] Update AC statuses and evidence with actual outputs; reopen an implementation task before rerunning T990 if any check fails.
- **Completion criterion:** every matrix command passes and AC-1 through AC-4 are marked `pass` with reproducible evidence.
- **Verification/review:** action-verifier and task-reviewer-qwen evidence is required in T999, not claimed here.

### T999 - Diff and execution-gate review evidence

- **task_type:** `review`; **Status:** `pass`; **Priority:** `P0`; **Depends on:** T990; **Parallel-safe:** `no`.
- **Covers:** complete approved scope, file map, AC matrix, and no-go constraints.
- **Files/artifacts:** read final diff and this plan; record review evidence in this plan; no production/test edits are authorized by T999.
- **Required future gates:** schedule `action-verifier` at completion time to prove new assertions invoke production behavior and all T990 validations pass; schedule `task-reviewer-qwen` with a per-call GLM 5.2 override to review the final diff against the AC matrix. This authored plan does not claim either gate has run.
- **Steps:**
  - [x] Schedule and collect the required action-verifier result against T010, T020, T030, T040, and T990.
  - [x] Schedule and collect the required task-reviewer-qwen result using the per-call GLM 5.2 override.
  - [x] Compare final changed paths and assertions with the immutable scope, exact AC text, and no-go list; record findings by severity.
  - [x] Confirm no merge, release, commit, SDK generation, public API change, or unrelated cleanup occurred.
  - [x] Record both gate results and final disposition; any blocking result reopens work before T990.
- **Completion criterion:** both required gates pass, no blocking finding remains, and evidence demonstrates the tripwires use production behavior.

## 9. Dependencies, Risks, Rollback, and Evidence

**Dependencies:** T010, T020, and T030 are independent. T040 has an internal order of queue extraction, production wiring, canonical test updates, and duplicate deletion; its test assertions depend on the extraction and wiring steps. T990 depends on all four implementation tasks. T999 depends on T990 and the completion-time review gates.

**Risks and mitigations:**

- Provider setup may be configuration-sensitive; reuse production Provider resolution and local dynamic-port capture rather than a logic mirror.
- Queue extraction may alter scheduling; preserve the existing `Map`, `Set`, FIFO drain, later activation, and metadata adapter as explicit invariants, then run prompt-submit-race.
- Existing unrelated LLM call-count failure can obscure broad validation; use only the listed focused commands and document that boundary.
- OAuth refresh timing can race; retain the existing readiness helper and local server, and assert after both requests complete.

**Rollback:** If a task fails review, revert only that task's uncommitted edits using the worktree's normal non-destructive edit workflow, restore the original component-local queue for T040 when its focused tests fail, and rerun the affected focused command. Do not reset the approved baseline or alter the frozen spec.

**Evidence:** record command output, changed-path review, captured request assertions, AC status updates, action-verifier result, and task-reviewer-qwen result in this plan's completion records during implementation. No external artifact or secret is required.

## 10. Change Log

### Execution Evidence - 2026-07-14

- `packages/opencode`: `bun test --timeout 30000 test/tool/task.test.ts` passed with 29 tests and 135 assertions.
- `packages/opencode`: `bun test --timeout 30000 test/stop-recovery-l0-capture.test.ts` passed with 3 tests and 13 assertions.
- `packages/opencode`: `bun test --timeout 30000 test/plugin/codex.test.ts` passed with 16 tests and 34 assertions.
- `packages/opencode`: `bun typecheck` passed.
- `packages/tui`: `bun test --timeout 30000 test/prompt-events.test.ts` passed with 6 tests and 9 assertions.
- `packages/tui`: `bun test --timeout 30000 test/cli/tui/prompt-submit-race.test.ts` passed with 2 tests and 4 assertions.
- `packages/tui`: `bun typecheck` passed.
- Repository root: `rtk git diff --check` passed.
- Aggregate focused results: OpenCode 48 tests and 182 assertions; TUI 8 tests and 13 assertions.
- Intended path inventory: `packages/opencode/test/tool/task.test.ts`, `packages/opencode/test/stop-recovery-l0-capture.test.ts`, `packages/opencode/test/plugin/codex.test.ts`, `packages/tui/src/component/prompt/hidden-prompt-queue.ts`, `packages/tui/src/component/prompt/index.tsx`, `packages/tui/test/prompt-events.test.ts`, deleted `packages/tui/test/prompt/prompt-events.test.ts`, and this plan artifact.
- `packages/opencode/test/session/prompt.test.ts` was neither changed nor run.
- Per-task gates: T010, T020, T030, and T040 each passed independent `action-verifier` verification and GLM-5.2-overridden `task-reviewer-qwen` review with no findings.
- T040's final queue test explicitly proves a prompt parked for `s2` remains isolated while `s1` drains and is delivered when `s2` is drained later; this is queue-primitive coverage, not a claim of full route activation integration.
- Final T999 repair strengthened the invalid TaskTool fallback to the exact `session`/`xhigh` result and selects compatible-provider chat requests independently from the extra-body fields under assertion.
- Consolidated T999 gates: fresh `action-verifier` PASS and GLM-5.2-overridden `task-reviewer-qwen` PASS with no findings. Both verified all eight intended paths, AC-1 through AC-4, and the full T990 matrix.
- No merge, release, commit, SDK generation, public API change, or unrelated cleanup occurred. The prepared patch remains uncommitted.

| Revision | Date | Author | Change | Reason / evidence | Affected tasks | Spec impact |
|---|---|---|---|---|---|---|
| 1 | 2026-07-14 | plan-driver | Initial execution-ready plan from approved inline PLAN_SPEC | Approved baseline and supplied research evidence | T010, T020, T030, T040, T990, T999 | none |

## 11. Verified Planning Basis

- The supplied research evidence identifies the current `TaskTool.execute`, Provider SDK resolution, Codex hook, prompt queue, canonical test, duplicate test, and focused validation command paths used by this plan.
- T020 is bounded to the existing `packages/opencode/test/stop-recovery-l0-capture.test.ts` file and existing production/test infrastructure.
- The TUI seam is internal to the prompt component directory; its symbol may be imported by the canonical test without becoming a package export.
