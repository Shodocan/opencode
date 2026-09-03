# opencode WSL Handoff

Date: 2026-05-21

## Locations

- Windows source repo: `C:\Users\wdcas\projects\pessoal\opencode`
- WSL clone: `/home/wdcas/projects/personal/opencode`

## Git status

- Working branch: `feat/mcp-channel-auto-submit`
- Fork remote: `origin` -> `https://github.com/Shodocan/opencode.git` in WSL, `git@github.com:Shodocan/opencode.git` on Windows
- Upstream remote: `upstream` -> `git@github.com:anomalyco/opencode.git`
- Fork branch head copied/cloned into WSL: `f4c64d405b6d667a1313e79a9decf25c499ec44b`
- `origin/feat/mcp-channel-auto-submit` is at the same commit.
- The local tracked Git state is committed and pushed to the fork branch.
- `gh pr view 19211 --repo anomalyco/opencode` currently reports the PR as `CLOSED` and still shows old PR head `083f84bafeb1e2fa2e9b4f97c51f011f1ef83bc2`; do not assume the GitHub PR page reflects the fork branch head.
- In WSL, after fetching current `upstream/dev`, branch divergence was `144 18` from `git rev-list --left-right --count upstream/dev...HEAD`; the fork branch is still outdated against the latest `dev`.

## Local-only files copied to WSL

Copied from Windows to `/home/wdcas/projects/personal/opencode`:

- `dist-custom/`
  - includes `install.sh`, release/upload helpers, and `opencode-custom-pr-19211-linux-x64.tar.gz` (~48 MiB)
- `packages/opencode/script/build-custom.ts`
  - ignored by `packages/opencode/.gitignore` via `script/build-*.ts`
- `.opencode/package.json`
- `.opencode/package-lock.json`
- `.claude/settings.local.json`

Not copied intentionally:

- `node_modules/` trees, `.turbo/` logs, generated Husky shims, and `tsconfig.tsbuildinfo`; regenerate these in WSL.
- `.vscode` was not kept copied because those files are tracked examples in the clone and copying from Windows made the WSL worktree dirty.

## WSL setup notes

The WSL clone does not currently have dependencies installed. `bun` was not found in WSL during this handoff. The repo expects `bun@1.3.11` from root `package.json`.

Recommended setup:

```sh
cd /home/wdcas/projects/personal/opencode
curl -fsSL https://bun.sh/install | bash
exec "$SHELL"
bun --version
bun install
```

Expected Bun version: `1.3.x`, ideally `1.3.11`.

## Continue syncing the branch

The branch has a prior merge commit but is behind the latest upstream `dev`. Continue in WSL:

```sh
cd /home/wdcas/projects/personal/opencode
```

If conflicts appear, resolve them, then run focused checks from package directories. Do not run tests from repo root.

Useful checks:

```sh
cd /home/wdcas/projects/personal/opencode/packages/opencode
bun typecheck
bun test test/mcp/lifecycle.test.ts
```

If SDK generated files conflict or become stale, regenerate the JavaScript SDK from repo root with:

```sh
./packages/sdk/js/script/build.ts
```

## Custom build and MinIO upload path

The local custom distribution files target a separate `opencode-custom` install so it does not conflict with canonical `opencode`.

Build Windows and Linux x64 custom binaries after dependencies are installed:

```sh
cd /home/wdcas/projects/personal/opencode/packages/opencode
bun run script/build-custom.ts --skip-install
```

Expected outputs:

- `packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`
- `packages/opencode/dist/opencode-linux-x64/bin/opencode`

Release helper:

```sh
cd /home/wdcas/projects/personal/opencode
MINIO_S3_ENDPOINT="https://s3.casonatto.dev" \
MINIO_S3_ACCESS_KEY="<from secret store>" \
MINIO_S3_SECRET_KEY="<from secret store>" \
bun dist-custom/release.ts
```

The helper rebuilds unless `SKIP_BUILD=1`, refreshes `dist-custom/install.sh` SHA256, locally installs the Windows exe only on Windows, tars the Linux binary, and uploads to `shared/opencode-custom/`.

Existing Linux install script:

```sh
curl -fsSL https://s3.casonatto.dev/shared/opencode-custom/install.sh | sh
```

Current bundled Linux tarball URL:

- `https://s3.casonatto.dev/shared/opencode-custom/opencode-custom-pr-19211-linux-x64.tar.gz`

Current bundled SHA256 in `install.sh`:

- `fae8ddb00fad9f8de66ce6039f03f746411d265fe0fb192a3e56d036f1d3a818`

## Remaining work

1. Install Bun in WSL and run `bun install`.
2. Re-sync `feat/mcp-channel-auto-submit` with latest `upstream/dev` if still desired.
3. Resolve any merge conflicts and push the fork branch only after validation.
4. Build Windows x64 with `packages/opencode/script/build-custom.ts`.
5. Upload refreshed artifacts to MinIO using secrets from the secret store, not from the repo or shell history.
6. Create a Windows installation script if still required; only a Linux `install.sh` exists in `dist-custom/` right now.
