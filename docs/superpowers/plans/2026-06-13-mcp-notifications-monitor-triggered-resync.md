# MCP Notifications Monitor-Triggered Resync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the monitor-detected PR #30019 merge conflict against latest `upstream/dev` and keep the hourly monitor active.

**Architecture:** Merge `upstream/dev` into the public PR branch and resolve the single lifecycle-test conflict by preserving upstream MCP session recovery coverage plus PR notification expectations. Validate package-local tests, push the branch, then rebuild the custom artifact with the known `NODE_PATH` wrapper packaging if source changed.

**Tech Stack:** TypeScript, Bun, Git merge workflow, MinIO `mc`, OpenCode monitor plugin.

---

### Task 1: Resolve lifecycle merge conflict

**Files:**
- Modify: `packages/opencode/test/mcp/lifecycle.test.ts`

- [ ] **Step 1: Merge latest upstream**

Run: `git merge upstream/dev`

Expected: content conflict in `packages/opencode/test/mcp/lifecycle.test.ts`.

- [ ] **Step 2: Resolve lifecycle test conflict**

Keep upstream's latest lifecycle/session recovery tests and keep PR tests named `MCP TUI notifications publish the matching bus events` and `agent state events notify connected MCP servers`. Preserve the current `notificationHandlers()` order expected by the merged MCP server setup.

- [ ] **Step 3: Validate conflict resolution**

Run: `git ls-files -u`
Expected: no output.

Run from `packages/opencode`: `bun typecheck`
Expected: exit 0.

Run from `packages/opencode`: `bun test test/mcp/lifecycle.test.ts test/mcp/session-recovery.test.ts --timeout 30000`
Expected: all tests pass.

### Task 2: Publish update and monitor

**Files:**
- Modify generated SDK only if `./packages/sdk/js/script/build.ts` changes output.
- Create local artifact files outside git worktree only.

- [ ] **Step 1: Regenerate SDK**

Run: `./packages/sdk/js/script/build.ts`
Expected: command exits 0.

- [ ] **Step 2: Commit and push**

Run: `git diff --cached --check`, `git commit -m "chore: merge upstream dev into mcp notifications"`, `git push origin feat/mcp-notifications`.
Expected: push succeeds.

- [ ] **Step 3: Build artifact if source changed**

Use the corrected packaging pattern: build binary, package required externalized Babel dependencies under `node_modules`, install via wrapper that sets `NODE_PATH`, test `och -c` startup, upload tarball and `install.sh` to `casonatto/shared/opencode-custom/`.

- [ ] **Step 4: Monitor**

Run or verify `/tmp/opencode/pr-30019-conflict-watch.sh --interval 3600` under `opencode_monitor_monitor`.
Expected: active monitor job exists.
