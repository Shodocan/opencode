# MCP Notifications PR Resync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the current PR #30019 merge conflict by merging latest `upstream/dev` into `feat/mcp-notifications` and pushing the updated branch.

**Architecture:** Use a merge commit because the PR branch is public. Keep upstream MCP session/auth fixes and preserve the PR's MCP TUI notification behavior in `packages/opencode/src/mcp/index.ts`.

**Tech Stack:** TypeScript, Bun, Effect, MCP SDK, GitHub PR branch workflow.

---

## File Structure

- Modify `packages/opencode/src/mcp/index.ts`: resolve the single content conflict.
- Test `packages/opencode/test/mcp/lifecycle.test.ts`: verify MCP lifecycle and notification behavior still pass.
- Modify generated SDK files only if required by merge output or SDK regeneration.

### Task 1: Resolve MCP merge conflict

**Files:**
- Modify: `packages/opencode/src/mcp/index.ts`
- Test: `packages/opencode/test/mcp/lifecycle.test.ts`

- [ ] **Step 1: Merge latest upstream**

Run: `git merge upstream/dev`

Expected: content conflict in `packages/opencode/src/mcp/index.ts`.

- [ ] **Step 2: Resolve `packages/opencode/src/mcp/index.ts`**

Keep upstream changes for expired MCP session recovery and authorization headers on fetch requests. Keep PR notification handlers for:

```ts
TuiPromptAppendNotificationSchema
TuiPromptSyntheticNotificationSchema
TuiCommandExecuteNotificationSchema
TuiToastShowNotificationSchema
TuiSessionSelectNotificationSchema
```

Expected: no conflict markers remain and `git ls-files -u` prints nothing.

- [ ] **Step 3: Validate MCP package**

Run from `packages/opencode`: `bun typecheck`

Expected: exit 0.

Run from `packages/opencode`: `bun test test/mcp/lifecycle.test.ts --timeout 30000`

Expected: all tests pass.

- [ ] **Step 4: Commit and push**

Run: `git status`, `git diff --cached --check`, `git commit -m "chore: merge upstream dev into mcp notifications"`, and `git push origin feat/mcp-notifications`.

Expected: remote branch head updates and GitHub no longer reports a merge conflict.
