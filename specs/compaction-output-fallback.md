# Complete compaction fallback

Successor repair for `1.18.28-harness.4.3.0.7`, following `.6`.

The user requested a configurable large-context fallback whenever the current
model cannot compact. `.6` handled context overflow but stopped on output
exhaustion. It also capped the fallback at 4,096 tokens, including reasoning,
which can leave no capacity for the summary itself.

This is a narrow successor extension of historical QCB-003 and QCB-006. Their
frozen files remain unchanged. Primary compaction remains capped at 4,096;
normal generation keeps its existing allowance. The previously configured
`compaction.fallback_model` may run once after typed/local context overflow,
explicit LENGTH, or a successful STOP with empty/whitespace summary text.
The fallback receives the same source prompt, without carrying the failed
summary or the primary model's variant into its request.

`compaction.fallback_max_output_tokens` is an optional positive integer,
defaulting to 32,000. It applies only to that fallback and is clamped by model
and runtime output limits. The larger allowance is included in the actual
pre-dispatch context budget and sent consistently by both native and AI SDK
runtimes. A same-route fallback is skipped. This adds no retry for generic
errors, authentication, transport, quota, abort, filtering or unknown finish.

Every new checkpoint requires STOP, nonempty summary text, and no error,
including when no fallback is configured. The configured fallback path also
retains its original-session resume-fit check. Failure or interruption keeps
the previous checkpoint and original rows; no partial summary is accepted.
Terminal incomplete-summary diagnostics include model, finish reason and
output/reasoning counts without summary content.

Historical raw LENGTH, empty STOP and errored summary rows are ineligible as
history boundaries. One shared predicate governs boundary truncation, the
paired retained-tail reorder and prior-summary selection. This read-only
selection restores access to original rows behind invalid boundaries while
retaining preceding complete checkpoints. It neither rewrites old events nor
repairs older partial summaries already persisted with a forged STOP finish;
those still require separately reviewed session recovery.

Validation covers one bounded fallback, unchanged source and original rows,
terminal fallback exhaustion, same-model/unset/error exclusions, older valid
checkpoints before invalid retained-tail boundaries, both-runtime output caps
and admission reserve, configuration validation/migration, and existing
finalization rollback and cancellation behavior. No live provider inference
or production session mutation is part of source qualification.
