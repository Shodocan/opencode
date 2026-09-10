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
