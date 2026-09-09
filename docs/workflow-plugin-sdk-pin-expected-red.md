# Compiled plugin SDK pin test declaration

The runtime binary version and the published plugin SDK version are distinct.
Custom builds must explicitly embed the reviewed OPENCODE_PLUGIN_VERSION pin;
configuration dependency installation must use that pin when the SDK is absent.
An explicitly declared project SDK dependency must retain its declared range.

Before source changes, a real Config service executed with compiled defines for
1.18.28-harness.4.3.0-canary / SDK 1.17.11 requests the unpublished runtime version
as the SDK version and overwrites explicit SDK declarations. Expected RED is a
wrong install request, not a download/network error. Only the Npm side-effect
service is replaced with a capture; Config, Instance and filesystem reads are real.

An outer test launches isolated Bun runtimes with the compiled constants so the
test cannot pass accidentally under the ordinary local development version.

Build-script fail-fast tests run the actual script with a deliberately absent
models snapshot as a side-effect barrier. Missing/blank SDK pins must fail with
an OPENCODE_PLUGIN_VERSION diagnostic before touching that snapshot. A valid pin
must pass validation and reach the snapshot barrier. The current source reaches
the snapshot barrier for every case, so the missing/blank cases are expected RED.

Sealed files:

- `test/config/workflow-plugin-sdk-pin.test.ts`: `b65ffc93403640c9ba33e54ae3f39ea0d1d94a251b3fca3f2f8effcc21289a95`.
- `test/config/fixtures/workflow-plugin-sdk-pin.fixture.ts`: `f1dfb5b42807ece0df01493d9f25f98696d9d7bb0567e39bf237ffde9249565d`.
- `test/config/workflow-build-sdk-pin.test.ts`: `a4056bf739b3527badc089bef81b317f63b6e4b7a09c6e609eabfa8bbd472dec`.

Author Config RED: 0 passed / 3 failed; `/tmp/native-sdk-pin-author-red.log`.
Author build RED: 1 passed / 3 failed; `/tmp/native-build-sdk-pin-author-red.log`.
Native `bun typecheck` passed after fixture authoring. Source belongs to the
separate native implementer; no source changes were made by this test author.

After separate source implementation, this author reran all unmodified SDK and
targeted-status tests together: 11 passed / 0 failed, 37 assertions, in
`/tmp/native-targeted-sdk-author-green.log`. All sealed hashes match.
