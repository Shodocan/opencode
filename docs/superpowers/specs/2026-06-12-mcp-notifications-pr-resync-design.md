# MCP Notifications PR Resync Design

## Goal

Update PR #30019 (`feat/mcp-notifications`) to the latest `upstream/dev` after GitHub reported a merge conflict.

## Current State

- Worktree: `/home/wdcas/projects/pessoal/opencode-mcp-pr`.
- Branch: `feat/mcp-notifications`.
- Latest branch head: `76fafbc194c5`.
- Latest `upstream/dev`: `7143bf8ff0b1`.
- Merge simulation reports one content conflict: `packages/opencode/src/mcp/index.ts`.

## Approach

Merge `upstream/dev` into the existing public PR branch. Resolve only the MCP server conflict by preserving upstream fixes for expired MCP session recovery and fetch authorization while retaining the PR's TUI notification handlers and synthetic visible-message behavior.

## Validation

- Regenerate SDK only if the merge changes OpenAPI/generated files.
- Run package-local validation from package directories:
  - `packages/opencode`: `bun typecheck`
  - `packages/opencode`: `bun test test/mcp/lifecycle.test.ts --timeout 30000`
- Push `feat/mcp-notifications` after validation.

## Artifact Policy

Rebuild and reupload the MinIO custom artifact only if source/build inputs changed. If only the merge commit changes code already included in upstream, publish a corrected artifact following the verified 2026-06-12 packaging pattern: bundled `node_modules` plus `NODE_PATH` wrapper.
