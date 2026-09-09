# Native terminal accuracy RED seal

Independent test author: identity_runtime_audit. Source implementer: harness_release_audit. Canonical GREEN: root/independent author.

Command from packages/opencode: `bun test --timeout 30000 test/tool/workflow-task-terminal-accuracy.test.ts`.

Author RED: 9 tests, 6 fail, 3 pass. Expected failures reproduce returned transport API error certainty, non-HTTP status0 certainty, UnknownError classification, returned child abort classification, concurrent cancellation/wait acknowledgement before cleanup, and a late descendant that survives SessionRunState.cancel. Success, definitive HTTP429, and completed child tool failure controls pass. All tests use live implementations, Deferred synchronization, and clean their fixtures. No production changes. `bun typecheck` passes.

These tests are sealed and immutable. Independent RED must precede source implementation.

SHA256:
26164b29220d0ae30045389b6385dd34c7953934fc19a20ac1f866e28400f5b1  packages/opencode/test/tool/workflow-task-terminal-accuracy.test.ts
128f744902c3d9b3131fa7e2ddb970c074f47624cec392f1a2aec8be1c4dcefb  docs/workflow-terminal-accuracy-expected-red.md
bbaaaf206a4eedbf9cba0f346bada5110154b175c35d5895d5512082b4a3c1b0  docs/workflow-terminal-accuracy-red.log
