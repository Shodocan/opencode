# Background wait compatibility and explicit native quiescence

Independent test author: `/root/runtime_tests`. Source author: `/root`.

The unchanged existing `test/background/job.test.ts` (SHA256
`9a4b98f6a3dd4bf3274fe818e414466ac2991dc968f7a58ee8b67ab0c27afc29`)
passes 11/11 on inherited source `7b06adb89e7642cc27c640e48152aa84d0495336`
and fails 1/11 on the release candidate: failure settlement waits for a held
extension finalizer, while its caller needs the settled failure to release it.
Logs: `/tmp/native-background-job-{baseline,candidate}-author.log`.

New tests preserve the generic settlement-only wait contract and specify an
explicit `quiescent: true` option for callers that need local cleanup completed.
An explicit wait remains pending until the finalizer is released; timeout zero
reports settled error with `timedOut: true` while cleanup remains pending, then
returns without timeout after cleanup completes. A default wait allows retrying
the ID while stale cleanup is held, and stale completion cannot settle that
replacement. Test cleanup always releases the controlled finalizer, including
on assertion failures. The original 11 tests are unchanged.

Two native Task tests execute actual foreground/background paths and observe
the real background service's wait requests. Both foreground completion and
background parent notification must explicitly request `quiescent: true`.

Sealed before source changes:

- `packages/opencode/test/background/workflow-wait-quiescence.test.ts`:
  `4043cf593b501b8caf0dfe80090457bb08341b7812833b4225cd90c86a5878c4`
- `packages/opencode/test/tool/workflow-task-quiescent-wait.test.ts`:
  `0a7aa95f5b98b1165b7bb402d127d87efe167241541eea0c5fdd1aba8dbe36da`

Candidate author RED: 3 failed / 2 passed, with the failures exactly default
settlement compatibility plus the two missing native opt-in requests.
`/tmp/native-wait-quiescence-author-red.log` records the unchanged test run.
The inherited source independently passes the default compatibility test and
fails the two explicit quiescence tests (1 passed / 2 failed), as expected for
an API without the new opt-in; `/tmp/native-wait-quiescence-baseline-author-red.log`.

Command from `packages/opencode`:

```sh
bun test --timeout 10000 --only-failures test/background/workflow-wait-quiescence.test.ts test/tool/workflow-task-quiescent-wait.test.ts
```
