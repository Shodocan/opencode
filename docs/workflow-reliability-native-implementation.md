# Native workflow reliability implementation

This isolated candidate starts at `7b06adb89e7642cc27c640e48152aa84d0495336`.
The parent agent adopted the pre-existing native Task exact-model patch from
`/tmp/native-existing-model-patch.diff`; the original dirty checkout remains
untouched. Subsequent runtime edits follow independently authored behavioral
RED tests. Test files remain owned by their authors.

## Native contract

- The installed runtime explicitly advertises `workflowRuntime` version 1
  with `taskStart`, `taskTerminal`, and `toolError` capabilities.
- `task.execute.start` is awaited after native child creation and before
  prompt execution. Trusted input includes parent, native call ID, child ID,
  and the exact provider/model/optional variant tuple. Denial prevents work.
- A trusted start hook can mutate `managedRetry` to true. Both session and
  native HTTP transport retry limits then become zero for this invocation;
  the workflow owns its finite route budget. Ordinary Tasks keep their retry
  defaults. No public Task argument can grant this mode.
- `task.execute.end` is awaited after local runner and descendant cleanup.
  It carries completed/failed/cancelled status, affirmative local quiescence,
  independent remote-completion certainty, typed provider/tool error evidence,
  and successful output for legacy result intake.
- A protected terminal receipt is committed before the terminal hook. The
  latest receipt lives at `opencode.task.terminal`, and all invocation receipts
  are retained under `opencode.task.terminals[exactCallID]`. This internal
  authority cannot be written through public session metadata APIs or forks.
- Generic native tool failures, defects, and interruptions invoke the awaited
  `tool.execute.error` observer. It preserves the original cause and last
  metadata; callback failure remains surfaced. Special native subtask execution
  and MCP execution paths use the same observer.

## Cancellation and evidence

Native Task preparation records affirmative no-launch metadata before schema
decoding. A child registration covers the awaited-binding window; cancellation
there prevents all prompt/provider work. Queued background continuations emit
their own terminal callback even if cancelled before execution.

Background cancellation and waits share a scope-closure barrier. Concurrent
callers cannot treat a cancelled status as completed cleanup. Session
cancellation stops its active runner before scanning descendants, then scans
again after cleanup so descendants created before producer shutdown are also
accounted for. Internal cleanup excludes the Task's own background container.

HTTP status and typed native LLM errors survive the session boundary. A returned
HTTP response can establish remote completion; missing/invalid HTTP status,
aborts, and local unknown errors retain remote uncertainty. Local quiescence
never claims that a remote provider stopped processing.

Session updates serialize their read/merge/publish operation inside this
service instance. The shared session projector additionally merges protected
Task metadata against the current database row inside EventV2's SQLite immediate
transaction. Delayed snapshots cannot erase existing invocation receipts or
replace child provenance. A conflicting receipt for an existing native call is
rejected; identical repeats are safe. The latest receipt is selected by completion
time with a deterministic call-ID tie break, and older single-receipt metadata is
retained when the per-call history is first populated.

## Validation handoff

Independent tests cover normal/error/interrupted tools, awaited child binding,
success/provider/tool/abort terminal outcomes, callback persistence order,
queued cancellation, child cancellation during binding, invalid input,
effective variant fidelity, continuation origin, protected receipt races,
actual prompt cleanup, and real HTTP retry counts in SDK and native paths.

The parent canonical run now passes all 83 tests in
`/tmp/native-v43-independent-green.log`, including the real native HTTP typed
provider error regression. Four additional background lifetime tests pass in
`/tmp/native-background-lifetime-green.log`.

Targeted native status is opt-in through `/session/status?sessionID=...`.
It validates that the session exists in the requested directory before reporting
idle, busy, or retry status; the original unfiltered response remains sparse.
The four independent HTTP tests pass in `/tmp/native-targeted-status-green.log`.
The legacy SDK was regenerated through its canonical script, including the
optional targeted query and its 404 response. The client generator also passed.

Custom builds now require an explicit `OPENCODE_PLUGIN_VERSION` before model
generation. That compiled SDK version is independent of the binary version;
Config preserves an existing SDK dependency declaration and injects the compiled
default only when it is absent. The three compiled Config tests, four build
guard tests, and all 108 original Config tests pass in
`/tmp/native-sdk-pin-green.log`, `/tmp/native-build-sdk-pin-green.log`, and
`/tmp/native-config-regression.log` respectively.

The five independently authored receipt interleaving tests and two existing
receipt tests pass in `/tmp/native-receipt-interleaving-green.log`; the original
core projector suite passes all ten tests in `/tmp/native-projector-regression.log`.

The original session action route test also exposed a pre-existing metadata reset
failure: `PATCH` with `metadata: {}` retained the previous public fields because
the merge helper returned `undefined`, which projection treats as an omitted
update. The helper now retains the explicit empty object while preserving host
metadata. Independent RED is recorded in
`/tmp/native-session-metadata-reset-independent-red.log`; the original three route
tests and seven receipt/interleaving tests pass together (36 assertions) in
`/tmp/native-session-metadata-reset-green.log`. None of those tests changed.

Native package typecheck and `git diff --check` pass after the repair. The
intermediate Linux canary binary built with the real models.dev snapshot and
passed its version smoke test:

`packages/opencode/dist/opencode-linux-x64/bin/opencode`

Version: `1.18.28-harness.4.3.0-canary`

Compiled plugin SDK: `1.17.11`

SHA-256: `9085d4c736ba73d588564b3cdf81a480880a5909ffbeb3c00964c7fa66ffcc19`

This is a canary build without embedded web UI, not the final release artifact.
Publishing and host installation remain owned by the parent release agent.
