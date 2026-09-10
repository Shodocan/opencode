# Independent native regression evidence

Test author: lifecycle_audit. Source implementer: harness_release_audit.
Tests are immutable after the SHA-256 seals below. No existing tests or runtime
source were edited by this test-author task. Expected failures were declared in
`workflow-reliability-gap-expected-red.md` before authoring.

| Test file (under packages/opencode) | Initial result | SHA-256 |
| --- | --- | --- |
| test/tool/workflow-task-gaps.test.ts | 4 expected failures, 2 controls passed | c6f53d8543676df11261dac091eb9728d6312f437b0b96e3444437bf8a24d0eb |
| test/session/workflow-task-receipts.test.ts | 1 expected failure, 1 control passed | a5049f1a2554371a01d66ceaa2e519a96364e926826c601f2d0e8b0b1195f562 |
| test/session/workflow-prompt-cleanup.test.ts | 1 positive integration guard passed | e7e6565623baaf2c0eec2c44cbd51443f410f9149536b6bcbf298c8ee56a510d |
| test/tool/workflow-task-retry-budget.test.ts | 2 expected failures, 2 controls passed | 31fd47f95d886aed2c8509a910b757b2e99ef2b59cac2dbe6928f4c64a2af196 |
| test/tool/workflow-task-native-retry-budget.test.ts | 1 expected failure, 1 control passed; native eligibility asserted | 56b934516bfd4be9cba1fc48de83d6b5d3f385b144d4bc029f59b675da7e5df1 |

Commands run from packages/opencode: `bun test --timeout 10000` with each gap,
receipt, or prompt-cleanup file; `bun test --timeout 30000` with the retry file.
`bun typecheck` passed after fixture preparation. The HTTP tests require a local
listener; the sandbox rejected that listener, so they were rerun with the approved
command outside the sandbox. Only localhost fixture traffic is generated.

Logs: `/tmp/native-gap-red.log`, `/tmp/native-receipts-red.log`,
`/tmp/native-prompt-cleanup.log`, `/tmp/native-retry-budget-red.log`,
`/tmp/native-retry-budget-typecheck.log`. The source implementer independently
reproduced the failing gap, receipt, and retry cases before implementing changes.
Canonical post-implementation results belong to the root reviewer.

The first retry suite proves actual HTTP counts through TaskTool, SessionPrompt,
SessionProcessor and SDK. Its native-enabled case intentionally remains sealed
even after a post-seal audit found that this fixture provider ID causes SDK
fallback. It is not evidence for the native RequestExecutor path; a separate
native-supported provider suite addresses that gap.
Its meaningful RED is logged in `/tmp/native-real-retry-budget-red.log`; the
managed invocation sends two actual HTTP requests instead of one, while the
ordinary invocation sends two and completes. Package typecheck passed in
`/tmp/native-real-retry-budget-typecheck.log`.

Two old task.test.ts expectations are obsolete under the required behavior:
whole-object child metadata equality must preserve the immutable creation origin
while allowing additive protected terminal receipts; parent abort must return a
failed/interrupted Task with a cancelled receipt, even if the provider returns
normally after cancellation. Positive controls independently test both updated
expectations. Existing assertions were not edited here.
