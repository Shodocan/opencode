# Native cancellation across process restart

Test author: compatibility_audit. Native Task source author: root.

The independent public-process canary is `scripts/native-workflow-cancellation-canary.mjs` in the workflow plugin repository, SHA256 `dd304ce9ebbfde95cbfc8de522beed9cb143e5f2d50983f857a6a3bbfd3eab60`.

It holds one real worker HTTP request before response headers, cancels through the conductor's public workflow tool, reads the protected native receipt through the session API, restarts OpenCode with the same state, and checks same-owner and foreign-owner status. Only the inference provider is a deterministic local fixture. No private workflow state is edited.

Independent RED: `/tmp/native-workflow-cancellation-canary-independent-red.log`; run `run-mtun3jlr-9y6adzyr`; the request closed and local status was cancelled, but the receipt incorrectly asserted remote completion. A cancelled prompt may return a normal session message, so Task now checks its cancellation signal before interpreting that return as remote completion.

Unchanged canary GREEN: `/tmp/native-workflow-cancellation-canary-green.log`; run `run-mtun5dwa-nd171xa5`; 8.792 seconds; one worker request and one closed connection; confirmed local cancellation with unknown remote outcome; unchanged closed run after restart; accurate cross-session ownership denial; no new dispatch. Binary SHA256 `45cf04d36f7d7c31de156d97f5f7f58115b89e6e8a24bacb93b2bb502b27ffd4`.

Existing terminal/accuracy/background tests: 19 passed, 131 assertions (`/tmp/native-cancel-truth-regressions.log`). This canary does not interrupt the process between receipt persistence and plugin callback delivery; separate crash/recovery regressions cover those barriers.
