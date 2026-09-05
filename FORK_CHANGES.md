# FORK_CHANGES.md — Shodocan/opencode dev branch

This branch carries personal features on top of `upstream/dev`
(`anomalyco/opencode`, base v1.18.27). This file is the
**conflict-resolution map** for every `git merge upstream/dev`: per file, what
the fork changed and how to re-graft it.

> Workflow on each upstream sync: `git fetch upstream dev && git merge upstream/dev`.
> For any conflicted file below, apply its **Future-merge recipe**. After resolving,
> regenerate the SDK when schema/server APIs changed and run `bun turbo typecheck`.

History note: the pre-v1.18.28 fork line (`fork/main`, base v1.17.x) carried 7
features documented in `git show 173b2b03c5:FORK_CHANGES.md`. The dev rebuild
on the v1.18.27 base carried forward only the QCB + MCP-channel features; the
rest were intentionally dropped. **Feature (7) MinIO auto-update was
accidentally dropped in that rebuild and re-grafted in this file's scope —
check it on every sync.**

## Feature map

| Feature | Status | Hot files |
|---|---|---|
| QCB — durable context-budget lineage, one-shot repair, recorded proof | live | `packages/opencode/src/session/overflow.ts`, `src/session/prompt.ts`, `test/session/prompt-context-budget.test.ts`, `test/session/qwen-context-budget-recorded.test.ts` |
| MCP channel features | live | see rc.1 merge commit d5e25ebbfd |
| Configurable auto-compaction threshold (`compaction.threshold` fraction + per-model `compaction.thresholds` fractions) | live | `packages/core/src/v1/config/config.ts`, `packages/core/src/config/compaction.ts`, `packages/core/src/v1/config/migrate.ts`, `packages/opencode/src/session/overflow.ts` |
| **(7) MinIO auto-update** | live (re-grafted) | `packages/opencode/src/installation/index.ts`, `test/installation/custom-minio.test.ts` |

## Feature (7) — MinIO auto-update (custom distribution)

The opencode-custom MinIO build installs the binary at
`<PREFIX>/lib/opencode-custom/opencode` (PREFIX defaults to
`~/.opencode-custom-hindsight`; wrapper `och` in `<PREFIX>/bin`). Upstream's
`Installation.method()` does not recognize that path → returns `"unknown"` →
`upgrade()` bails, so the build never auto-updates.

`packages/opencode/src/installation/index.ts` fork additions:
- `isCustomMinioInstall()` / `customLibDir()` helpers +
  `CUSTOM_INSTALL_MARKER` / `CUSTOM_MANIFEST_URL` / `CustomMinioManifest`
  consts (near the top, after `getReleaseType`).
- `method()` returns `"curl"` for the custom-hindsight install path.
- `latest()` fetches `manifest.json` (`{version,url,sha256}`) from MinIO for
  the custom install — one source of truth shared with `upgrade()`.
- `upgradeCustomMinio` (defined after `upgradeCurl`): download tarball,
  verify sha256, extract, `install -m 0755` over `<LIB_DIR>/opencode` — an
  in-place binary swap; wrapper + user PREFIX customizations untouched.
  `upgrade()`'s `case "curl"` routes to it when `isCustomMinioInstall()`.

**Future-merge recipe**: all four additions are small, isolated blocks
commented `// FORK FEATURE (7)`. On conflict, keep every FORK block adjacent to
its upstream counterpart (helpers after `getReleaseType`, `upgradeCustomMinio`
after `upgradeCurl`, the three gates inside `method()`/`latest()`/`upgrade()`).
Tests: `packages/opencode/test/installation/custom-minio.test.ts` (path
detection, manifest latest(), in-place swap, RC version scheme).

## Version scheme for the custom distribution

Clean release = `X.Y.Z`; bug-fix republishes on the same release =
`X.Y.Z-RC1`, `-RC2`, … (RC resets to RC1 each upstream release). The
auto-update gate is string-equality + `getReleaseType` (major/minor compare),
so `X.Y.Z → X.Y.Z-RCn` correctly triggers a patch upgrade (auto-apply).
Manifest + tarball + sha256 live at `shared/opencode-custom/` on
`https://s3.casonatto.dev` (see `handoff.md` for the publish path).
