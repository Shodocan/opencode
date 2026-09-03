# Route-Aware Context Budget and Compaction

**Status:** brainstorm complete; ready for implementation planning
**Date:** 2026-08-30
**Target:** OpenCode V1 session/provider path

## Goal

Guarantee before every provider dispatch that the complete, route-normalized request plus requested
output and safety headroom fits the selected route. Compact once, before dispatch or same-cap
fallback, when it does not fit.

The motivating failure is Qwen with a 262,144-token context and 32,000 requested output tokens:
the prior-turn usage check can admit roughly 232,000 input tokens after in-turn tool and system
growth, producing an oversized request locally and again on the same-cap Yolo fallback. The
compaction request itself is currently capable of overflowing.

## Non-goals

- Do not lower normal Qwen output below 32,000 tokens.
- Do not add public config knobs or generated API/schema changes.
- Do not replace the estimator with a model-specific exact tokenizer in this repair.
- Do not persist destructive transcript pruning; the full transcript remains durable.
- Do not change model routing policy, charge skipped routes as attempts, or retry context overflow
  through the transient retry schedule.
- Preserve all pre-existing dirty-tree task-origin/MCP changes in `prompt.ts` and its tests.

## Budget formula

For a selected route:

```text
G = 16,384               projected in-turn growth headroom
M = 4,096                safety margin
H = G + M
Rcfg = compaction.reserved ?? 20,000
O = min(route output limit, requested runtime output limit)

contextBudget = C > 0 ? C - max(Rcfg, O + H) : Infinity
inputBudget   = I > 0 ? I - max(Rcfg, H)     : Infinity
B = max(0, min(contextBudget, inputBudget))
```

`C` is the route context window. `I` is an explicit input limit when supplied. The input formula
does not subtract output twice from providers whose explicit input limit already excludes output.

Dispatch is allowed only when the late canonical estimate `E <= B`; compaction is required at
`E >= B + 1`. For `C=262,144`, no explicit `I`, and `O=32,000`, exactly 209,664 is admitted and
209,665 compacts.

Configured `reserved` is a floor: a smaller value cannot weaken `O + H`, while a larger value
compacts earlier. `compaction.auto: false` disables automatic compaction but never disables the
provider dispatch gate.

## Late pre-dispatch estimate

Estimate at the last common seam before network/provider execution and before charging a route
attempt. The projection must include the actual selected route and:

- transformed system text, including agent, project, MCP, skills, and plugin changes;
- normalized model-visible messages, current user input, tool calls, and tool results;
- max-step additions;
- active tool names, descriptions, and JSON input schemas; and
- provider message normalization/options that affect serialized prompt content.

Executable functions are excluded. Use deterministic canonical serialization and ceiling division
for the existing four-characters-per-token estimator. Prior assistant usage is telemetry only, not
the admission decision.

Recompute after route changes, tool/system growth, compaction, and reactive overflow recovery.

## Compaction request safety

Compaction uses an explicit output allowance:

```text
Oc = min(4,096, route output limit, runtime output cap)
```

Every summary request passes the same route-aware formula with `Oc`. Normal generation remains at
32,000.

Before summary generation, build a nonpersistent compacting projection that replaces media with
placeholders and caps historical tool output at the existing 2,000 characters. Preserve the latest
user turn intact. Tail settings are maxima, not requirements.

Older history is chunked only on complete turn boundaries without separating tool calls from their
results. Only an individually oversized text part may be split. Fold at most four budget-checked
chunks through a rolling summary.

Reject before any summary provider call if fixed overhead or the latest turn cannot fit. Reject
after compaction if the rebuilt normal request remains oversized or the estimate did not shrink.

## Retry and fallback behavior

- One logical provider turn/request lineage may run at most one compaction operation.
- A provider context-overflow response before durable assistant or tool output may consume that one
  compaction and one rebuilt attempt on the original route.
- Never dispatch the same `(route, requestHash)` again after context overflow.
- Evaluate each fallback against its own context, input, output, and final estimate.
- Skip an incompatible route without a provider call and without consuming an attempt. A same-cap
  Yolo route must never receive unchanged oversized input.
- A fitting larger-cap fallback may receive only its recomputed fitting request.
- A second overflow, unavailable compaction, or overflow after durable output is terminal.
- Existing transient retry behavior is unchanged; context overflow remains non-retryable there.

## Internal outcomes

Use internal typed errors without expanding the public schema:

- `ContextBudgetExceededError` for a route-local preflight incompatibility; and
- `CompactionImpossibleError` for terminal bounded compaction failure.

Evidence includes route, phase, estimate, budget, context/input limits, output allowance, chunk
count, and one reason:

```text
fixed-overhead | latest-turn-too-large | chunk-limit |
no-reduction | post-compaction-over-budget
```

Route incompatibility is a nonexception routing outcome. If every route is exhausted, map the final
result to the existing public `ContextOverflowError`.

## Expected implementation surface

Subject to the reviewed plan, keep the change narrow:

- `packages/opencode/src/session/overflow.ts`: pure route budget and estimate helpers;
- `packages/opencode/src/session/llm/request.ts` and/or `session/llm.ts`: final canonical preflight
  seam before native or AI SDK dispatch;
- `packages/opencode/src/session/compaction.ts`: bounded safe compaction projection/chunking;
- `packages/opencode/src/session/prompt.ts`: only the minimum orchestration hook needed to compact
  and rebuild while preserving current uncommitted baseline edits;
- focused tests under `packages/opencode/test/session/`.

Do not spread admission math across multiple owners. The reviewed plan must name one authoritative
helper used by normal and compaction requests.

## Acceptance tests

- 209,664/209,665 Qwen boundary;
- explicit input limit without double output subtraction;
- configured reserve below/above the safety floor;
- normal output remains 32,000;
- late system/tool/plugin growth crosses the boundary despite low prior usage;
- `auto: false` produces zero compaction and zero provider calls for an oversized request;
- compaction output is at most 4,096 and every chunk fits its route;
- complete-turn/tool-pair chunking and four-call maximum;
- fixed-overhead and latest-turn failures produce zero summary calls;
- one rebuild and no second compaction;
- same-cap fallback skipped with zero hit/attempt;
- larger-cap fallback receives only a fitting recomputed request;
- reactive second overflow terminates;
- terminal error evidence is complete; and
- all existing task-origin/MCP dirty-baseline tests remain unchanged and green.

## Validation

Run focused RED/GREEN tests and `bun typecheck` from `packages/opencode`, never repository root.
Run related session/LLM/compaction tests and the package's required lint/type gates. Then exercise a
recorded Qwen/Yolo integration fixture using the harness's existing `compaction.reserved: 12000` to
prove core clamps the unsafe value, compacts before local dispatch, and does not burn same-cap
fallback.

## Compatibility

This is a separate reviewed change set from workflow liveness and Architect/GitHub lifecycle
autonomy. Their final end-to-end qualification depends on this request gate, but their behavior is
not implemented here.
