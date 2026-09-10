# Background lifetime — sealed RED

Test: `packages/opencode/test/tool/workflow-background-lifetime.test.ts`

SHA-256: `180fef0edefbe804dfcc5ab2e556d807557edfcfb55b8e7dc6643c626c6c2f37`

Author command from `packages/opencode`:
`bun test --timeout 10000 test/tool/workflow-background-lifetime.test.ts`

Result: **1 expected failure, 3 controls passed**.

Log: `/tmp/native-background-lifetime-author-red.log`.

The normal stream-closure case returns a cancelled background job instead of
completed. Explicit native parent cancellation, explicit native child
cancellation, and abort during awaited background startup all pass.
Package `bun typecheck` passes (`/tmp/native-background-lifetime-typecheck.log`).

No source edits by this test author. This test is immutable after sealing;
the source owner must independently reproduce RED before the lifetime fix.
