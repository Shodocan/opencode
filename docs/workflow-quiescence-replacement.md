# Native cleanup compatibility replacement

The unpublished `v1.18.28-harness.4.3.0` candidate is rejected. Its general
background-job wait also awaited cleanup, deadlocking a caller that needed the
settled result before releasing a finalizer. The original 11-test suite passed
on the pre-release base and reproduced that deadlock on the candidate.

The replacement preserves general settlement behavior and adds explicit
`quiescent: true` waits and cancellation. Native Task completion, interruption,
session cancellation, and removal request that stronger guarantee. A timeout
reads its captured generation's settlement, even if the job ID has been reused.
Task startup acquires ownership under a cleanup guard before launching work;
interrupted startup joins the child, while a successful background handoff
allows the child to survive the completed parent turn.

Independent source validation passed 247 tests with 873 assertions across 36
files, plus core and native typechecking. Independent semantic review passed
38 targeted tests with 160 assertions. The groups overlap. Fourteen new tests
were sealed before source changes. The original generic job suite is unchanged.
The older strict-cleanup test's two call arguments now explicitly request
quiescence after independent adjudication; its assertions remain unchanged.

See `workflow-wait-quiescence-expected-red.md` and
`workflow-cancel-timeout-start-expected-red.md` for the test seals and RED proof.
Two unrelated inherited expectations were corrected after reproducing them on
the base: the public manifest already has 90 events, and submit already accepts
return, linefeed, and keypad enter. Neither correction changed runtime behavior.

The intended replacement is `1.18.28-harness.4.3.0.1`. It requires a fresh build,
real native canaries, final CI, and fleet acceptance before publication. Old
artifacts, tags, journals, and failed receipts remain preserved; no old native
receipt qualifies this replacement binary.
