# FORK_CHANGES.md — Shodocan/opencode personal fork

This fork (`fork/main`) carries personal features on top of `upstream/dev`
(`anomalyco/opencode`). This file is the **conflict-resolution map** for every
`git merge upstream/dev`: per file, what the fork changed and how to re-graft it.

> Workflow on each upstream sync: `git fetch upstream dev && git merge upstream/dev`.
> For any conflicted file below, apply its **Future-merge recipe**. After resolving,
> always regenerate the SDK (see §Generated SDK) and run `bun turbo typecheck`.

Branch history: this was `feat/mcp-notifications` (head of the now-closed upstream
PR #30019). Renamed to `fork/main` on 2026-06-26 — it is a personal integration
branch, no longer a clean single-feature PR.

---

## Feature commit map

| Feature | Substantive commits |
|---|---|
| **(1) MCP/TUI notifications** | `20946781a2` (add), `77e0444a86` (port into @opencode-ai/schema), `d605c010f5` + `b1d32b10f1` (SDK regen / restore after schema refactor #33571) |
| **(2) subagent-spawning + `--agent`** | `cb044d2052` |
| **(3) getLegacyPlugins fix** | `95e18ef489` |
| **(4) app stream tolerance** | `4777f4f0fb` |
| **(5) compaction-enhardening** | `44661eec44` (tiering), `6f3cf62db9` (recall) |
| **(6) fallback-model** | `0a3136a9bb` (config, dark), `dd56f3eb44` (threading), `b07050661f` (H7 trigger), `0be3e3a73b` (v1 AgentSchema + KNOWN_KEYS) |
| **(7) MinIO auto-update** | `173b2b03c5` (install detection + manifest latest + in-place binary swap) |
| **(8) session.status AbortError suppress** | `ac5c41d51a` (fan-out `notify()` helper suppresses `AbortError` when transport closes mid-send + regression test) |

The other ~40 commits are `upstream/dev` merge commits + `regen SDK` follow-ups.

---

## Hot-file watchlist (the merge magnets)

Highest conflict exposure — review these first on every merge:

- `packages/opencode/src/mcp/index.ts` — 5 notification handlers + 2 fan-out blocks
- `packages/tui/src/component/prompt/index.tsx` — hidden-prompt queue + onAppend refactor
- `packages/tui/src/routes/session/index.tsx` — `<For>`-based UserMessage rewrite
- `packages/schema/src/tui-event.ts` — the `Event.inventory(...)` arg list
- `packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts` — `TuiPublishPayload` union
- `packages/core/src/v1/config/agent.ts` — `AgentSchema` + `KNOWN_KEYS`
- `packages/opencode/src/cli/cmd/run.ts` — deleted subagent guards
- `packages/core/src/session/compaction.ts` — head-only tiering hook
- `packages/core/src/session/runner/llm.ts` — fallback H7 + the two `catchDefect` arms
- `packages/opencode/src/installation/index.ts` — **Feature (7)**: custom-MinIO path detection (`isCustomMinioInstall`/`customLibDir`), `manifest.json` branch in `latest()`, `upgradeCustomMinio` in-place binary-swap branch in `upgrade()`'s `case "curl"`

---

## Per-file resolution table

Risk = how actively upstream edits the file. New files (no upstream counterpart)
are structurally zero-conflict.

### Feature (1) — MCP/TUI notifications

| File | Risk | What the fork changed | Future-merge recipe |
|---|---|---|---|
| `packages/opencode/src/mcp/index.ts` | **high** | 5 zod `NotificationSchema` handlers (`prompt/append,prompt/synthetic,command/execute,toast/show,session/select`) decoding into `TuiEvent` + 2 `events.listen` fan-out blocks (SessionStatus, AgentState) with finalizers, both routed through a `notify()` helper that suppresses `AbortError` (expected when transport closes mid-send). Imports `NotificationSchema`, `zod/v4`, `SessionStatus`. | Keep all 5 handlers + both fan-out blocks; re-graft into upstream's restructured client-setup + `addFinalizer`; ensure the 3 imports survive. Keep the `notify()` helper + AbortError suppress. |
| `packages/schema/src/tui-event.ts` | med | `PromptSynthetic` (`tui.prompt.synthetic`) + `AgentState` (`tui.agent.state`) defines added to the single `Event.inventory(...)` call. | Keep both `define()` blocks; **union** upstream's + fork's event types into one `Event.inventory(...)` arg list. |
| `…/httpapi/groups/tui.ts` | med | `EventTuiPromptSynthetic` + `EventTuiAgentState` struct schemas added to `TuiPublishPayload` union. | Add the fork's two struct consts + union members alongside any upstream-added tui structs. |
| `…/httpapi/handlers/tui.ts` | med | Two `if`-branches in `publish` forwarding PromptSynthetic + AgentState. | Keep both branches next to the existing PromptAppend/CommandExecute/ToastShow/SessionSelect ones. |
| `packages/core/src/session/message-updater.ts` | low | `metadata: event.metadata` added to the synthetic text-part builder. | Re-add the single `metadata: event.metadata` line to the synthetic part case. |
| `packages/tui/src/component/prompt/index.tsx` | **high** | Per-session hidden-prompt queue + `drainHiddenPromptQueue` (delivers synthetic prompts with `synthetic:true` + `MCP_VISIBLE_METADATA`); `createPromptEventHandlers` wiring; `tui.prompt.append` → `promptEvents.onAppend` (adds submit + auto-input); `tui.prompt.synthetic` handler. | Preserve the queue, `drainHiddenPromptQueue`, `createPromptEventHandlers`, both `event.on` handlers; re-apply `onAppend` over upstream's rewrite; keep `MCP_VISIBLE_METADATA` import. |
| `packages/tui/src/component/prompt/events.ts` | low | **New file** — `createPromptEventHandlers` factory, structural payload types, sessionID filtering. | New file — keep as-is. |
| `packages/tui/src/context/local.tsx` | med | `createEffect` (dedupe key `lastPublishedAgentState`) publishing `tui.agent.state` on agent/model/variant change. | Re-insert the createEffect after upstream's local-context setup; keep the JSON-key dedupe guard. |
| `packages/tui/src/context/sync.tsx` | med | Hoists `server.instance.disposed` out of the switch into an early `Reflect.get(event,'type')` check that calls `bootstrap()` + returns. | Keep the early `Reflect.get` disposed branch above the switch; drop upstream's in-switch `disposed` case if present. |
| `packages/tui/src/routes/session/index.tsx` | **high** | `visibleUserTextParts(props.parts)` replaces the text createMemo; `<For>` over `{header,text,muted}` parts (muted + MCP caller header for synthetic-visible). | Re-apply the `visibleUserTextParts` import + `<For>`-based UserMessage body over upstream's UserMessage; keep the `text().length>0` Show guard. |
| `packages/tui/src/routes/session/visible-user-text.ts` | low | **New file** — `isVisibleUserTextPart` + `visibleUserTextParts`. | New file — keep as-is. |
| `packages/tui/src/util/mcp-visible-message.ts` | low | **New file** — `MCP_VISIBLE_METADATA` keys + `mcpCallerHeader()`. | New file — keep as-is. |

### Feature (2) — subagent-spawning + `--agent`

| File | Risk | What the fork changed | Future-merge recipe |
|---|---|---|---|
| `packages/core/src/v1/config/agent.ts` | med | Optional `can_spawn_subagents` (bool) + `subagents` (string[]) on `AgentSchema`; both keys added to `KNOWN_KEYS`. | Re-add both fields to `AgentSchema` + both strings to `KNOWN_KEYS` alongside upstream-added fields. |
| `packages/opencode/src/agent/agent.ts` | med | `canSpawnSubagents`/`subagents` on runtime `Info`; merge copies them onto `item` and, when `can_spawn_subagents` set + no explicit `permission.task`, merges blanket `task:{'*':'allow'}`. | Re-add the two `Info` fields + the merge+conditional-task-grant block right after upstream's `permission.merge` line. |
| `packages/opencode/src/tool/task.ts` | med | After the unknown-agent-type check, fails dispatch if `parent.subagents` set and excludes the requested `subagent_type`. | Keep the parent allow-list guard right after the unknown-agent-type validation. |
| `packages/opencode/src/cli/cmd/run.ts` | med | Removes the two `mode==='subagent'` refusal blocks (both agent-resolution paths) so `--agent <subagent>` launches as root. | Keep both refusal blocks deleted; if a merge restores the guard, delete again + keep the fork comment. |
| `.opencode/opencode.jsonc` | low | Adds an `agent` map of primary driver agents (`operator`, `architect`, `*-driver`) with `mode:primary`, `can_spawn_subagents:true`, per-driver `subagents` allow-lists. | Repo-local, no upstream counterpart; keep the fork's `agent` block, merge any upstream additions to the same JSON object. |

### Feature (3) — getLegacyPlugins fix

| File | Risk | What the fork changed | Future-merge recipe |
|---|---|---|---|
| `packages/opencode/src/plugin/index.ts` | med | `getLegacyPlugins` only treats `default`/`server` exports as entrypoints (skip non-plugins with `continue` instead of throwing); broad `Object.values(mod)` scan only as fallback when no entrypoint found. | Keep the candidates loop + continue-on-non-plugin + empty-result broad-scan fallback; re-apply if upstream rewrites `getLegacyPlugins`. |

### Feature (4) — app stream tolerance

| File | Risk | What the fork changed | Future-merge recipe |
|---|---|---|---|
| `packages/app/src/context/server-sdk.tsx` | low | `event.payload.type === 'sync'` → `Reflect.get(event.payload,'type') === 'sync'`. | Keep the `Reflect.get(...,'type')==='sync'` guard. |
| `packages/opencode/src/cli/cmd/run/stream.transport.ts` | low | `payload.type==='sync'` + `…==='server.instance.disposed'` → `Reflect.get(payload,'type')` reads in `globalPayloadEvent`/`isMatchingDisposeEvent`. | Keep both `Reflect.get` type reads. |

### Tests (fork-added)

`packages/opencode/test/mcp/lifecycle.test.ts` (low — keep added notification cases),
`packages/opencode/test/v2/session-message-updater.test.ts` (low — keep `metadata` test),
`packages/tui/test/prompt-events.test.ts` (new file),
`packages/tui/test/visible-user-text.test.ts` (new file),
`packages/tui/test/cli/tui/use-event.test.tsx` (low — keep `as GlobalEvent['payload']` cast),
`packages/opencode/test/agent/can-spawn-subagents.test.ts` (new file),
`packages/opencode/test/cli/run/stream.transport.test.ts` (low — keep widened `TestGlobalPayload` union),
`packages/core/test/session-recall.test.ts` (new file — Feature 5 compaction recall),
`packages/core/test/session-runner-fallback.test.ts` (new file — Feature 6 fallback).

---

## Generated SDK — never hand-merge

`packages/sdk/js/src/gen/types.gen.ts`, `packages/sdk/js/src/v2/gen/sdk.gen.ts`,
`packages/sdk/js/src/v2/gen/types.gen.ts` are codegen output.

**On any conflict here: discard both sides, then re-run SDK generation** against the
merged schema/groups sources:

```bash
bun ./packages/sdk/js/script/build.ts   # runs `bun dev generate` then regenerates types/sdk
git add packages/sdk/js/src/**/gen/*.ts && git commit --no-verify -m "chore: regenerate JS SDK"
```

> Verify all 6 TUI event types survive: `grep -oE "EventTui(PromptAppend|PromptSynthetic|CommandExecute|ToastShow|SessionSelect|AgentState)" packages/sdk/js/src/v2/gen/types.gen.ts | sort -u` must list all 6. (The #33571 schema refactor once dropped 2 of them — see commit `b1d32b10f1`.)

---

## Docs / process artifacts (fork-only, never conflict)

`docs/superpowers/plans/*.md`, `docs/superpowers/specs/*.md`, `docs/superpowers/subagent-spawning.md`,
and this file. Planning/spec notes with no upstream counterpart — keep as-is.

---

### Feature (5) — compaction-enhardening

New fork-owned files (zero-conflict): `packages/core/src/session/enharden/tiering.ts`,
`packages/core/src/session/enharden/recall.ts`, `packages/core/src/tool/session-recall.ts`,
and their tests. Hot touches:

| File | Risk | What the fork changed | Future-merge recipe |
|---|---|---|---|
| `packages/core/src/session/compaction.ts` | med | `serialize(msg, tier?)` param + `select(entries, tokens, tier?)` re-tiers the HEAD only (recent stays byte-identical legacy `truncate`); call site passes `CompactionTiering.tierToolOutput` when `ENHARDEN_ENABLED`. | Re-apply the `tier?` param on `serialize`/`select`, the head-only re-serialize + `CompactionTiering.capHead`, and the tier arg at the `select(...)` call. `compaction-tiering.test.ts` tripwire red-fails if dropped. Never tier `recent`. |
| `packages/core/src/tool/builtins.ts` | low | `SessionRecallTool.node` appended to the `deps` array of the `node = makeLocationNode({ name: "built-in-tools", deps: [...] })` aggregate (the reachable v2 tool path). | Keep the import + the `SessionRecallTool.node` entry in the `deps` array (append-only). Post-v1.17.12 the aggregate is a `makeLocationNode` (PR #34621), not `locationLayer`; re-graft into whatever shape upstream's aggregate takes. |
| `packages/core/src/tool/session-recall.ts` | low | Fork-owned file; exports `node = makeLocationNode({ name: "tool/session-recall", layer, deps: [ToolRegistry.toolsNode, Database.node] })`. | Fork-owned (zero-conflict). If upstream renames `makeLocationNode` or changes `LayerNode` deps shape, update this export to match; `ToolRegistry.toolsNode` provides `Tools.Service`, `Database.node` provides `Database.Service`. |

Kill-switch: `OPENCODE_COMPACTION_ENHARDEN=0` ⇒ pure legacy pass-through.

### Feature (6) — fallback-model

New fork-owned file (zero-conflict): `packages/core/src/session/runner/fallback.ts` + its tests.
Config (additive): `fallback` on `packages/schema/src/agent.ts` (AgentV2.Info) +
`packages/core/src/config/agent.ts` (ConfigV2.Agent) + `packages/core/src/config/plugin/agent.ts`
(**`agentKeys` MUST include `"fallback"`** — load-bearing v2-routing gate — plus the parse block) +
`packages/core/src/v1/config/agent.ts` (commit `0be3e3a73b` — v1 `AgentSchema` field + `KNOWN_KEYS`
entry; **load-bearing for legacy/frontmatter agents** that route through the v1 decoder +
`ConfigMigrateV1.migrateAgent`, which must carry `fallback` through v1→v2 or the chain is lost).

| File | Risk | What the fork changed | Future-merge recipe |
|---|---|---|---|
| `packages/core/src/session/runner/llm.ts` | **med-high** | H1 import; H2 `ContinueWithFallbackModel` transition variant; H3 ctor; H4 `runTurnAttempt` gains `modelOverride/tried/transitions`; H5 model-resolve honors override; H6 publisher reports active variant; **H7 trigger before the overflow-publish**; H8 `RunTurn` type; H9/H10 `runAfterOverflowCompaction`+`runTurn` thread params, add the fallback arm, re-thread ambient override across compaction, increment the transition budget. | **MANDATORY merge-review focus.** The post-stream block was reworked by upstream (`820c984d47` / `f8f648e5ce`, "fix(core): recover v2 context overflow"); re-insert H7 between the overflow-recovery `return` and `if (overflowFailure) yield* publish(overflowFailure)`. Preserve all 4 gate predicates (interrupt / assistant-started / provider-error / transition-budget). Mirror the existing `ContinueAfterOverflowCompaction` arm shape for H9/H10. Gate semantics drift silently with NO compile error — the `session-runner.test.ts` FORK tests are the safety net. |
| `packages/core/src/config/plugin/agent.ts` | med | `"fallback"` added to `agentKeys` + a parse block (mirrors `item.model`). | Keep both. Without the `agentKeys` entry a markdown agent with `fallback:` frontmatter mis-routes to the legacy v1 decoder. |
| `packages/schema/src/agent.ts`, `packages/core/src/config/agent.ts`, `packages/core/src/v1/config/agent.ts` | low | additive `fallback` field (v2: `AgentV2.Info` + `ConfigV2.Agent`; v1: `AgentSchema` field + `KNOWN_KEYS` entry via `0be3e3a73b`). | Re-add alongside upstream agent fields; regen SDK after. The v1 field is load-bearing for legacy/frontmatter agents — `ConfigMigrateV1.migrateAgent` must carry `fallback` through v1→v2. |

Triggers only on retriable HTTP failures (rate-limit/5xx/overload) or a context-overflow that
survives compaction. Does NOT cover mid-stream in-band SSE provider-errors (documented limitation).
See `docs/superpowers/fork-features-plan.md`.

### Feature (7) — MinIO auto-update

The personal `opencode-custom` MinIO distribution installs the binary at
`<PREFIX>/lib/opencode-custom/opencode` (PREFIX default `~/.opencode-custom-hindsight`).
Upstream `Installation.method()` does not recognize that path → returns
`"unknown"` → `cli/upgrade.ts` bails (`if (method === "unknown") return`), so
the build never auto-updated.

| File | Risk | What fork changed | Future-merge recipe |
|---|---|---|---|
| `packages/opencode/src/installation/index.ts` | med | `isCustomMinioInstall`/`customLibDir` helpers + `CUSTOM_INSTALL_MARKER`/`CUSTOM_MANIFEST_URL`/`CustomMinioManifest` consts; `method()` returns `"curl"` for the custom path; `latest()` fetches `manifest.json` (version) when curl+custom; `upgrade()`'s `case "curl"` routes to `upgradeCustomMinio` (download tarball, verify sha256, extract, `install -m 0755` over `<LIB_DIR>/opencode`). | Keep the helpers + consts; keep the 3 call-site branches (method/latest/upgrade). All are gated on `isCustomMinioInstall()` so upstream curl/npm/brew paths are untouched. Re-graft after upstream's `method()`/`latest()`/`upgrade()` restructures. |
| `packages/opencode/test/installation/custom-minio.test.ts` | low | **New file** — detection, manifest latest(), in-place swap upgrade, RC version scheme. | New file keep as-is. |

**Version scheme:** clean release = `X.Y.Z`; bug-fix republishes on the same
release = `X.Y.Z-RC1`, `-RC2`, … (RC resets to RC1 each upstream release). The
auto-update gate is string-equality + `getReleaseType` (major/minor compare), so
`X.Y.Z → X.Y.Z-RCn` is a patch → auto-upgrade fires. `OPENCODE_VERSION` stamps
the build (e.g. `OPENCODE_VERSION=1.17.11-RC1`).

**Publish recipe** (see memory `opencode-custom-publish`): build with
`OPENCODE_VERSION=<ver>`, tar to a **version-stable** key
`opencode-custom-linux-x64.tar.gz` + `.sha256`, write `manifest.json`
`{ version, url, sha256 }`, flip `install.sh` `DEFAULT_URL`/`DEFAULT_SHA256`.
The binary's `latest()` reads `manifest.json`; `upgrade()` swaps the binary in
place (wrapper + user PREFIX customizations untouched).
