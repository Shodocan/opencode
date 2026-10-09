# Route-Aware Context Budget Choices

**Date:** 2026-08-30
**Status:** frozen for this repair

## QCB-001 - Late complete-request admission

The dispatch decision uses a route-normalized estimate at the final pre-network seam. Prior-turn
usage cannot authorize a request by itself.

## QCB-002 - Fixed safety constants

Projected growth is 16,384 tokens and the additional margin is 4,096. Configured reserve is a
safety floor. For a 262,144 context and 32,000 output, 209,664 input tokens fit and 209,665 do not.

## QCB-003 - Preserve normal output quality

Normal Qwen generation keeps its 32,000-token allowance. Compaction alone uses at most 4,096 output
tokens.

**Amendment, 2026-10-09 (owner decision; refs Shodocan/harness-opencode#660).** Production data: 31 of
99 compactions ended with finish reason `length` at exactly 4,096 output tokens (output plus
reasoning), and 4 produced no summary text. Reasoning took a median 30% (p90 55%) of the allowance,
and the session continued on the cut summary. The owner was asked with two options: "Raise the cap to
8,192 (amend QCB-003)" and "Keep 4,096, run the compaction call at low or no reasoning". Owner
answer: "Both".

Superseded: the 4,096 compaction output allowance above. Current: compaction output is at most
8,192 tokens and the compaction call runs at low reasoning effort. Normal generation stays at
32,000. The 4,096 safety margin in QCB-002 is unchanged.

## QCB-004 - Bounded compaction

One logical request lineage gets one compaction operation and at most four fitting summary chunks.
Fixed overhead, the latest turn, no reduction, or a still-oversized rebuilt request fails
terminally without looping.

## QCB-005 - Repair before failover

Context pressure is repaired before failover. Every fallback is independently budgeted, and an
incompatible route is skipped without a provider call or attempt charge. Same-cap Yolo never
receives unchanged oversized input.

## QCB-006 - Existing public contract remains stable

Internal typed budget/compaction errors map to the existing public context-overflow error. No new
public config fields or generated schema changes are introduced.

## QCB-007 - Dirty baseline is authoritative

The current uncommitted OpenCode worktree is the baseline authorized by the user. The repair layers
onto it and never reverts or rewrites unrelated task-origin, MCP, session, tool, or plugin changes.
