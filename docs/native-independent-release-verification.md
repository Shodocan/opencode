# Independent native release verification

Test author/reviewer: `runtime_tests`; implementation was written by other agents.
No original checkout was modified. Candidate: `/tmp/opencode-v4.3.0`.
Native baseline commit: `7b06adb89e7642cc27c640e48152aa84d0495336`.

## Existing suite coverage

From `packages/opencode`, Bun 1.3.14:

```
bun test --timeout 30000 --only-failures test/session test/tool test/config test/server
```

Result: **1,476 pass, 12 skip, 1 todo, 2 fail** across 117 files (249.05s).
Log: `/tmp/native-broad-independent.log`.
This invocation preceded the newly authored before-chain tests below.

The two failures reproduce on a disposable `git archive` of the baseline
commit, `/tmp/native-release-baseline-z01oymvp`. Workspace package links point
to that baseline's source; only external dependencies are shared with the
candidate. Running the two original files there produced 16 pass / 2 fail.
Log: `/tmp/native-existing-failures-baseline.log`.

| Existing failure | Baseline evidence | Classification |
| --- | --- | --- |
| `test/tool/write.test.ts`, sensitive-data file mode | Both baseline and candidate expect 0644 but receive 0664 with inherited umask 0002 | Environment assumption. Candidate rerun with umask 0022 passes all 15 tests; `/tmp/native-write-umask-green.log`. |
| `test/server/session-actions.test.ts`, metadata reset | Both baseline and initial candidate retain prior metadata after `PATCH {metadata:{}}` | Pre-existing native API defect subsequently repaired by the separate source author; original test retained. |

Those original tests were not changed, excluded, or weakened.

The metadata reset repair now returns an explicit empty public metadata object
while preserving host-owned task fields. Independent regression verification:
the original session-actions file plus receipt interleaving pass **8/8**;
`/tmp/native-metadata-reset-independent-green.log`. Durable Task receipt tests
pass **2/2** separately in `/tmp/native-metadata-receipts-independent-green.log`.

Separate existing plugin coverage:

```
bun test --timeout 30000 --only-failures test/plugin
```

Result: **184 pass / 0 fail**, 18 files, 550 assertions.
Log: `/tmp/native-plugin-independent.log`.

## Independently reviewed fixes

- Receipt projection merges immutable per-call Task receipts and origin inside
  the existing immediate SQLite event transaction. It preserves distinct calls,
  rejects conflicting proofs, and upgrades the legacy latest receipt into
  history. Independent rerun: **5 pass / 0 fail**, 11 assertions,
  `/tmp/native-receipt-interleaving-independent-green.log`.
- Task cancellation checks the abort state after prompt completion and before
  assigning completed remote outcome. Provider abort before a response keeps
  the remote outcome unknown.
- Session cancellation stops producers before collecting fresh descendant
  tasks; background-job completion waits for finalizers. The caller's own
  background job is excluded to avoid self-wait.
- Ordered plugin admission could reserve a workflow task and then fail in a
  later plugin before execution. The independent real-plugin-chain regression
  captures that gap and requires affirmative native not-started evidence.
- Recovery notifications must continue after an unrelated error observer fails.
  A separate real-chain test captures that second failure boundary.

The two before-chain test contracts and their RED evidence are documented in
`workflow-before-chain-expected-red.md` and
`workflow-before-observer-isolation-expected-red.md`. Independent final rerun
of both new tests plus all six existing tool-terminal tests: **8 pass / 0 fail**,
63 assertions, `/tmp/native-before-chain-independent-green.log`.
Both seals remain unchanged:

- Before-chain: `8d9529d93948a8347bd77ae47f919afdcc4f167757e5fe365586e8c000b652fa`.
- Observer isolation: `87a2bb6708200a0f6effe07fb7fbc7344b1082fafadf11b705f946f066b98493`.

Native package `bun typecheck` passes after that source repair:
`/tmp/native-release-independent-typecheck.log`.

## Final shared error-notification verification

One final independent test covers native Task validation failing after its real
prepare hook, after the workflow has claimed the dispatch, but before child
creation. An earlier failing error observer must not prevent the workflow from
receiving native not-started proof. The original native validation diagnostic
must remain visible. Contract: `workflow-validation-observer-isolation-expected-red.md`.
Seal: `a8dba1d87019c8cbb866245ad324c8babc6297da2b8fae9733696c932db4f594`.
Author and source verifier independently reproduced RED before the repair.

The source now uses one shared observer notification helper for both generic
tool errors and failed Task admission, preserving every observer opportunity
and original failure diagnostics. Final independent verification after that
refactor and the metadata reset fix:

- Existing plugin suite plus all nine new/existing callback cases:
  **193 pass / 0 fail**, 627 assertions across 22 files;
  `/tmp/native-plugin-callbacks-final-independent-green.log`.
- Native package `bun typecheck`: pass;
  `/tmp/native-release-final-independent-typecheck.log`.
- All three new native callback test seals above remain unchanged.

This closes the assigned native source review and independent regression gate;
the native binary build and deployed canaries are separate release checks.
