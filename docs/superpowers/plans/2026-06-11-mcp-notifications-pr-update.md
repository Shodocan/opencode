# MCP Notifications PR Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update PR #30019 to latest `upstream/dev`, preserve MCP/TUI notification behavior, and publish an updated MinIO artifact.

**Architecture:** Merge the public branch forward, then adapt the PR’s notification events to upstream’s new TUI data context. Keep upstream file deletions for obsolete `sync-v2` paths and place feature behavior in current session/data files.

**Tech Stack:** TypeScript, Bun, Effect, SolidJS, GitHub CLI, MinIO `mc` CLI.

---

## File Structure

- Modify `packages/opencode/test/mcp/lifecycle.test.ts`: merge upstream capability tests with PR notification tests.
- Modify `packages/tui/src/context/data.tsx`: add handling for synthetic prompt events.
- Modify `packages/tui/src/routes/session/index.tsx` and nearby session rendering files if needed: render visible synthetic MCP messages.
- Keep deleted upstream paths deleted: `packages/tui/src/context/sync-v2.tsx`, `packages/tui/src/feature-plugins/system/session-v2.tsx`.
- Regenerate SDK files under `packages/sdk/js/src/**/gen/`.

### Task 1: Merge base and resolve conflicts

**Files:**
- Modify: `packages/opencode/test/mcp/lifecycle.test.ts`
- Modify: `packages/tui/src/context/data.tsx`
- Modify: `packages/tui/src/routes/session/index.tsx`
- Delete: `packages/tui/src/context/sync-v2.tsx`
- Delete: `packages/tui/src/feature-plugins/system/session-v2.tsx`

- [ ] **Step 1: Merge latest upstream**

Run: `git merge upstream/dev`

Expected: conflict only in the known MCP lifecycle and deleted TUI v2 files, unless upstream changed again.

- [ ] **Step 2: Resolve lifecycle test conflict**

Keep upstream additions for capability discovery and tool-list notification schema. Restore the PR tests named `MCP TUI notifications publish the matching bus events` and `agent state events notify connected MCP servers` with the PR fake-client notification storage.

- [ ] **Step 3: Resolve TUI v2 delete conflicts**

Accept upstream deletions for `sync-v2.tsx` and `session-v2.tsx`. Port only the PR-specific synthetic visible message behavior to current TUI files.

- [ ] **Step 4: Mark conflicts resolved**

Run: `git status --short`

Expected: no `UU`, `DU`, or `UD` entries.

### Task 2: Validate and regenerate

**Files:**
- Modify: generated SDK files under `packages/sdk/js/src/`

- [ ] **Step 1: Regenerate SDK**

Run: `./packages/sdk/js/script/build.ts`

Expected: command exits 0 and generated SDK diffs reflect current server API schemas.

- [ ] **Step 2: Run package-local validation**

Run from `packages/opencode`: `bun typecheck`

Expected: exit 0.

Run from `packages/tui`: `bun typecheck`

Expected: exit 0.

- [ ] **Step 3: Run focused tests**

Run package-local focused tests for MCP lifecycle and TUI prompt/session behavior.

Expected: selected tests exit 0.

### Task 3: Publish PR branch and custom artifact

**Files:**
- No source edits expected beyond resolved merge and generated SDK output.

- [ ] **Step 1: Review diff and commit**

Run: `git status`, `git diff`, and `git log --oneline -10`.

Expected: diff only contains merge resolution, generated SDK output, and workflow plan/spec artifacts.

- [ ] **Step 2: Push PR branch**

Run: `git push origin feat/mcp-notifications`

Expected: PR #30019 updates to the pushed head.

- [ ] **Step 3: Build and upload custom artifact**

Use the repository's existing custom release/upload tooling and MinIO `mc` CLI to publish a new `opencode-custom-pr-30019-linux-x64-<timestamp>.tar.gz` and update `install.sh` with its URL and SHA256.

Expected: `mc stat` confirms the uploaded tarball and install script are present.

- [ ] **Step 4: Monitor PR**

Use the PR monitor workflow for PR #30019.

Expected: checks/review state are observed or a concrete blocker is reported.
