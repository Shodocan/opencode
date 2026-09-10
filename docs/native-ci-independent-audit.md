# Native hosted CI audit

This records the independently observed CI findings for PR6. It does not
qualify a replacement artifact or treat cancelled runs as passing gates.

The hosted-runner commit `daf9bc967e1e8b3bf04eaa223d5a93c0aa63c233`
started the previously unavailable native gates. Typecheck, Nix evaluation,
storybook, and Linux E2E passed. Linux E2E reported 101 passing cases and five
cases that passed only on retry; no final failing cases.

Actual E2E logs show the workflow selected Node24.15.0, then the setup-bun
composite selected cached Node24.20.0. The intended E2E version was therefore
overridden. Chromium extraction nevertheless completed in eight seconds in
this run; the override is not established as the cause of any observed retry.
Evidence: `/tmp/native-pr6-e2e-linux-complete-author.log`.

Linux native unit tests completed with 3743 passed, 19 skipped, one todo, and
six failures. Three real-plugin integration tests lacked the companion plugin
checkout/dependencies that their fixtures require. Two failures were existing
event-manifest and default-keymap assertions; their adjudication belongs to the
separate compatibility reviewer. The remaining failure was a real regression
in the candidate BackgroundJob wait behavior, independently reproduced with the
unchanged original test. Evidence:
`/tmp/native-pr6-unit-linux-original-author.log`.

The original background suite passes 11/11 on inherited source
`7b06adb89e7642cc27c640e48152aa84d0495336` and fails 1/11 on the candidate.
Its deferred extension cleanup deliberately waits for a signal that the
caller sends after observing the settled job error. Globally changing wait
to await cleanup created a cycle. The independent tests and sealed opt-in
quiescence contract are recorded in `workflow-wait-quiescence-expected-red.md`.
The originally built binary with SHA256
`1a07574949b4f6d37334162c82f9409c8ab9a73a38d92fc817dabd13ec3028cf`
was consequently rejected for release despite its earlier targeted canary
passes. Those receipts remain historical evidence, not replacement-artifact
qualification.

The superseded Windows unit job was cancelled. Its partial log includes
Ripgrep/Snapshot five-second timeouts while extracting the downloaded Ripgrep
archive through PowerShell, as well as the known manifest and background wait
failures. Cancellation prevents treating it as a complete validation result;
the extraction issue needs separate environment diagnosis. Logs:
`/tmp/native-pr6-unit-windows-superseded-author.log` and
`/tmp/native-pr6-e2e-windows-superseded-author.log`.

The next CI head, `68fa5697aece92db0a49487ba9cb764b28f9c988`, provisions
the real plugin fixture and preserves the E2E Node version. The three real
plugin tests now pass. Typecheck, storybook, Nix evaluation, and Linux E2E pass.
Linux native unit results are 3745 passed and four failures: the known manifest,
keymap, and background cases plus an unknown-model CLI subprocess taking
15,434ms against its 15-second limit. That CLI case passes independently on
both candidate (3.92s) and inherited source (4.09s); its CI-only failure cause
is not established. Windows core tests report 1091 passed and five Ripgrep
extraction timeouts; Turbo interrupts remaining native work. Windows E2E remains
pending. Logs: `/tmp/native-pr6-68fa-unit-{linux,windows}-author.log` and
`/tmp/native-unknown-model-{candidate,baseline}-author.log`.

A controlled two-run comparison reproduced the unknown-model failure on the
untouched inherited source with CPU affinity restricted to two CPUs. The
unchanged 13-case CLI file at Bun's default concurrency of 20 produced 12 passes
and one failure: the unknown-model subprocess took 15,258ms against the unchanged
15,000ms limit. The same file with `--max-concurrency=2` passed all 13 cases. Both
runs executed 47 assertions, taking 43.90s and 43.28s respectively. Its SHA256
remained `77f87af8e7da987bb33a0ec847c29b62770a6f30427e930c7c211107e5457255`,
and its bytes exactly match inherited commit
`7b06adb89e7642cc27c640e48152aa84d0495336`. No assertions, deadlines, source,
or test files were changed for this comparison.

This demonstrates a local resource-contention mechanism reproducing the CI
symptom without candidate source. It supports limiting native CLI/test
concurrency in hosted CI; it does not establish every scheduling factor behind
the original hosted failure. The two planned runs are preserved in
`/tmp/native-cli-contention-{default,two}-author.log`, with commands, environment,
result counts, and log hashes in
`/tmp/native-cli-contention-result-author.json`. The passing run's quiet output
does not report individual subprocess durations, so none is inferred.

The CI unit command now runs the other Turbo test tasks unchanged, then runs the
native package's existing script with concurrency two. Independent Turbo graph
comparison preserved all nine other executed commands and their dependency edges.
Native test discovery, assertions, the 30-second test timeout, and inherited
workflow-fixture environment remain unchanged.

The earlier Windows CI candidate prepared the official ripgrep 15.1.0 executable before tests,
verifying the release archive SHA256 before extraction. This avoids first-use
download/extraction inside short test deadlines. The Windows browser job uses
the existing `PLAYWRIGHT_WORKERS` setting with two workers; Linux retains five.
The previous Windows browser run had 97 passes, eight cases passing on retry,
and one final file-content visibility failure, with several teardown stalls.
Reduced scheduling contention is a bounded investigation, not proof that this
browser failure is repaired. Both platforms' complete final-head checks must
pass before release under that earlier support scope; no assertions, retries, or test deadlines were weakened.

The operator subsequently explicitly withdrew Windows support: "i dont have a
windows machine anymore" and "so we dont need to support windows". This custom
release and its target hosts are Linux-only. The final CI matrix therefore
retains Linux unit and browser tests and removes Windows jobs and their unused
ripgrep setup helper. Every Linux command, assertion, dependency fixture,
timeout, and worker count remains unchanged. Typecheck, Storybook, Nix and PR
checks remain required. All final-head checks must pass before release.

The Windows installation failures remain preserved as failures. Both attempts
at `fb25df529149b6dc174ec8972cea1adf5e88ac3e` failed before tests while Bun 1.3.14
renamed a patched package into its cache. The failure reproduced without a
restored dependency cache; no Windows validation is claimed. Investigation and
retries stopped when the operator removed that platform from scope. This
support decision changes CI only; the qualified Linux runtime and artifact
inputs remain byte-identical to the successful Linux `fb25df5291` build.
