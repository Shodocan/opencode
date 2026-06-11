# MCP Notifications PR Update Design

## Goal

Update PR #30019 (`feat/mcp-notifications`) to the latest `upstream/dev`, preserve the MCP/TUI notification feature, and publish an updated custom build artifact to MinIO for local installation.

## Current State

- Worktree: `/home/wdcas/projects/pessoal/opencode-mcp-pr`.
- Branch: `feat/mcp-notifications`.
- Base: `upstream/dev`.
- The branch is behind `upstream/dev` and conflicts with the upstream TUI refactor that replaced `sync-v2` with `context/data.tsx`.

## Approach

Merge `upstream/dev` into the PR branch instead of rebasing, because the branch is public and already has merge commits. Resolve conflicts by keeping upstream deletions of obsolete TUI files and porting the PR-specific notification behavior into the replacement data/session UI paths.

## Components

- `packages/opencode/test/mcp/lifecycle.test.ts`: keep upstream MCP lifecycle/capability updates and restore PR tests for TUI notification publishing and agent-state outbound notifications.
- `packages/tui/src/context/data.tsx`: receive synthetic prompt events in the new data context so visible MCP messages enter the message stream.
- `packages/tui/src/routes/session/*`: render visible synthetic MCP messages in the current session UI with muted MCP caller labeling.
- Generated SDK files: refresh after merge and conflict resolution.

## Validation

- Regenerate SDK with `./packages/sdk/js/script/build.ts`.
- Run package-local typechecks/tests from package directories only.
- Push `feat/mcp-notifications` to update PR #30019.
- Build/upload a new MinIO artifact and update `install.sh` metadata.

## Risks

- The upstream TUI data-context refactor changes where synthetic MCP messages must be injected and rendered.
- Existing branch history includes repeated SDK generation commits; the new update should keep changes focused and avoid history rewrites.
