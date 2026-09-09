# Independent before-hook recovery notification isolation

The real native plugin chain loads a failing error observer, the real workflow
plugin, then an admission-rejecting plugin. The workflow durably claims the
dispatch before the final admission hook rejects it. No Task body executes.

Every installed error observer must still receive the affirmative native
`started: false, localQuiescence: true` proof if a different observer throws.
The real workflow must record that the claimed attempt never started, avoid
acceptance/sealing, and recover through public status without reconciliation.
The original admission rejection must remain visible to the caller.

Expected RED against the first before-chain repair: its notification loop stops
at the first observer failure, leaving the workflow claim without terminal
proof. This test is separate from the already sealed before-chain regression.

All project/config/plugin/journal fixture files are disposable temporary files;
the real native Task body is an execution counter and must remain uncalled.
