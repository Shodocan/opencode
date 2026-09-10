# Explicit cancellation, generation identity, and startup ownership

Independent test author: `/root/runtime_tests`. Source author: `/root`.
These are separate tests; the five wait-contract tests remain unchanged.

Sealed before the corresponding source changes:

| Test file under `packages/opencode/test/` | SHA256 |
| --- | --- |
| `background/workflow-terminal-cancel-compatibility.test.ts` | `aa1567856fc3e10718ba1adf65dd37003beeb9bcb7062677fc0d63f83a3c7288` |
| `background/workflow-wait-timeout-generation.test.ts` | `2c898b3773f8e3e65cd91c8941dab7677c22bdfed5a9d3447d47d3a8dc6a8491` |
| `session/workflow-cancel-quiescence.test.ts` | `fe60049cf9a846b9146ae8cd14b43b22436407e570e2510ef0b10ac2aa25a60f` |
| `tool/workflow-task-cancel-quiescence.test.ts` | `c83abd7e3b166ce4a115483457b64eb42136f54b3e2627020e23ffd88a550df6` |
| `tool/workflow-task-start-ownership.test.ts` | `8a3ccad972d2d4d79880d56168418c5f3e9595a34278503fdf642aa8e10e5e00` |

Author RED: **7 failed / 2 passed**, nine cases across five files, recorded in
`/tmp/native-cancel-timeout-start-author-final-red.log`.

The contracts are:

- Generic cancellation of an already failed job returns its existing terminal
  snapshot without waiting for cleanup held by its caller. A standalone first
  version of this test passed on inherited source and failed on the candidate;
  `/tmp/native-terminal-cancel-compatibility-baseline-author-green.log` and
  `/tmp/native-terminal-cancel-compatibility-author-red.log` preserve that proof.
- `cancel(id, { quiescent: true })` waits for the captured job generation's
  cleanup, even if another job reuses the ID while that cleanup is held. It must
  neither wait on nor cancel the replacement generation.
- A positive quiescent wait started while running reports the captured job's
  settled failure if its cleanup remains pending at timeout. The same result is
  required after ID reuse; a stale running snapshot or replacement state is wrong.
- Native session cancellation and deletion wait for matching failed-job cleanup.
  The session row remains present until cleanup completes; deletion then removes
  it. A terminal status alone is not cleanup proof.
- Foreground Task interruption explicitly requests quiescent cancellation of
  its owned background job and records a cancelled, locally quiescent receipt.
- Interruption after the real registry starts a child but before foreground wait
  admission or background handoff must join that child and record one terminal
  callback/receipt. The fixture gates the return of real `background.start`, not
  the child execution. It requests real Effect-fiber interruption, releases the
  gate, and captures the child-finalizer/receipt/callback evidence before manual
  fixture teardown. Both foreground and background-intended paths are covered.
  Existing post-handoff background-survival tests are unchanged.

The first unsealed Task-cancel callsite fixture interrupted at startup and
therefore discovered the separate ownership gap. Its failure is preserved in
`/tmp/native-cancel-callers-author-red.log`. The callsite fixture now waits for
the real foreground wait boundary; its final RED is specifically the missing
quiescent option, `/tmp/native-cancel-task-callsite-author-red.log`. The startup
gap is covered independently in the sealed two-case ownership file above.

## Narrow amendment to the existing cancellation oracle

The independent compatibility reviewer and parent approved exactly two argument
changes in the existing `workflow-task-terminal-accuracy.test.ts` concurrent
cancel/wait case: second `cancel(id, { quiescent: true })`, and
`wait({ id, quiescent: true })`. The first cancel, held finalizer, and every
assertion are unchanged. This names the new explicit API while retaining the
same strong cleanup oracle.

- Original SHA: `26164b29220d0ae30045389b6385dd34c7953934fc19a20ac1f866e28400f5b1`.
- Amended SHA: `e3012753eb9f5a573dfc3e2e7b1ca61d82c8d115a2c966cf65a8375d1cf73251`.
- The separate verifier's pre-amendment combined result was 237 passed / one
  failed: `/tmp/native-quiescence-final-independent-green.log` (despite its
  historical filename, this run was RED).
- The amended targeted case still fails against inherited source without the
  required cleanup behavior: `/tmp/native-terminal-accuracy-opt-in-baseline-red.log`.

Run the new cases from `packages/opencode`:

```sh
bun test --timeout 10000 --only-failures test/background/workflow-terminal-cancel-compatibility.test.ts test/background/workflow-wait-timeout-generation.test.ts test/session/workflow-cancel-quiescence.test.ts test/tool/workflow-task-cancel-quiescence.test.ts test/tool/workflow-task-start-ownership.test.ts
```
