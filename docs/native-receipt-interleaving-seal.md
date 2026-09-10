# Native durable receipt interleaving oracle

Test author: root. Native source ownership: runtime_fix (separate author).

Final test SHA256: 6aa1fb93a48f83a7390b98fdf69b47b4de0ef3c576237ce2a508ecbcee9ec960
File: packages/opencode/test/session/workflow-receipt-interleaving.test.ts

The native session service reads a snapshot, merges a patch, then publishes the complete Updated event. Its semaphore only serializes one service instance. Tests publish a snapshot read before another receipt commits through the actual EventV2Bridge and database projector, representing delayed native updates from overlapping hosts. They do not claim to be a full two-process HTTP concurrency test.

Final author RED: /tmp/native-receipt-interleaving-author-red.log, 4 failed / 1 passed (2026-09-09). Lost per-call receipts, downgraded latest receipt, conflicting same-call replacement, and changed task origin are forbidden. Exact duplicate terminal publication remains valid. The first two assertions were sealed before adding three requested controls; no source changes occurred between the two test generations.
