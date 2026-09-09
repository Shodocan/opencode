# Independently authored native reliability gap expectations

Test author lifecycle_audit; source implementer harness_release_audit. Declared before
writing new gap tests. Existing sealed tests/source are not changed by the test author.

Expected RED on the current candidate:
- SessionRunState.cancel(child) while the awaited task.execute.start hook is blocked,
  with parent AbortSignal untouched, must fence later scheduler/provider admission.
  Current cancellation sees no runner/job and forgets intent, so prompt can launch.
- A resumed Task queued by real BackgroundJob.extend must get one cancelled native end
  callback even when cancelled before its prompt begins. Its terminal finalizer currently
  sits inside the queued effect, after the scheduler's Deferred predecessor wait.
- Invalid Task arguments rejected in Tool.wrap must expose provable no-launch metadata
  (started:false/localQuiescence:true) even though the Task run body is never entered.
- Ordinary selected-agent model/variant must match native start/terminal evidence, even
  when the model-visible Task argument has no explicit tuple.

Existing corrected behavior to preserve as positive guards:
- Origin metadata is immutable creation provenance; terminal metadata is an additive
  per-invocation sibling. A resumed child keeps original origin but terminal callID updates.
  Prior task.test whole-object equality is obsolete because a new protected receipt is
  now required. Replace only those old equality expectations; do not delete the test.
- Parent abort must yield a failed/interrupted Task and cancelled receipt. The old test's
  Exit.isSuccess=true assertion incorrectly reports cancellation as task success.

Next separate tests will cover real SessionPrompt.ops exclusion forwarding/self-cleanup
and concurrent metadata/title writes. No mock scheduler/session registry or private state
injection; synchronize racing boundaries with Deferred readiness, never fixed sleeps.

Before authoring workflow-task-receipts.test.ts: each native invocation requires a
protected receipt in opencode.task.terminals keyed by exact callID (latest convenience
alias retained). Two acknowledged concurrent terminal receipts plus unrelated title/
public metadata writes must all survive. Public callers may neither forge nor erase
this map. Current source has no map and read/patch races can discard protected receipts.
The separate real SessionPrompt.ops guard will obtain promptOps from the actual internal
subtask path and invoke cleanup from inside its own job while a real child Runner is
active. Excluding that job must still cancel the Runner and descendant jobs, without
self-deadlock. This is a positive guard for the forwarding fix already present.
# Managed retry budget: independent HTTP expectations

Post-seal source audit found that the first suite's `retry-test` provider makes the native adapter fall back to SDK even with the native flag enabled. Preserve that suite unchanged as SDK/fallback evidence. Before authoring the separate `workflow-task-native-retry-budget.test.ts`, require a native-supported provider ID and an explicit positive `LLMNativeRuntime.status` assertion; the managed count must still be one and the ordinary count two. This closes the RequestExecutor coverage gap without rewriting sealed expectations.

Before authoring `test/tool/workflow-task-retry-budget.test.ts`, the expected failure is that an awaited `task.execute.start` hook returning `{managedRetry:true}` still permits native retry layers to send a second HTTP request after a typed HTTP 429. Each managed Task invocation must send exactly one child-model request and return a failed provider terminal receipt. This applies with both the AI SDK transport and `experimentalNativeLlm` enabled. Ordinary Task admission with no managed flag must retain its retry behavior: one HTTP 429 followed by a successful response produces exactly two child-model requests and a completed receipt. The tests will drive actual TaskTool, SessionPrompt, SessionProcessor, and a local HTTP server, filtering unrelated auxiliary model requests. They will not set a caller-visible retry argument or stub the LLM/processor retry implementation.
