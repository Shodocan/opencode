# Subagent-spawning subagents & `--agent` for subagents

Fork-local feature on `feat/mcp-notifications` (PR #30019). Three capabilities:

1. A subagent can dispatch its own subagents (default: denied; opt in per-agent).
2. An agent can declare an allow-list of which subagent_types it may dispatch.
3. `opencode --agent <subagent>` launches a subagent directly as the root agent.

## Background — why subagents can't spawn by default

When the `task` tool spawns a subagent, `packages/opencode/src/tool/task.ts` builds a `childToolDenies` list and adds `{ permission: "task", pattern: "*", action: "deny" }` **unless** the subagent's own `permission` already has a `task` rule (`packages/opencode/src/agent/subagent-permissions.ts`). So by default a subagent's `task` tool is denied → it cannot nest. There is no depth/nesting guard; the permission rule is the only gate.

## 1. `can_spawn_subagents` — let a subagent spawn subagents

```jsonc
{
  "agent": {
    "my_driver": {
      "mode": "subagent",
      "can_spawn_subagents": true
    }
  }
}
```

When `true`, opencode grants the `task` tool permission (a blanket `task: { "*": "allow" }`) **unless** the agent already declares `permission.task` — in which case your explicit scoping wins. Primary agents can always spawn (the deny only applies to agents spawned via the `task` tool); this field is meaningful for `mode: "subagent"`.

### Scoping which child types it may spawn

Two ways, use either or both:

**a) `subagents` allow-list (declarative, recommended):**
```jsonc
{
  "agent": {
    "my_driver": {
      "mode": "subagent",
      "can_spawn_subagents": true,
      "subagents": ["worker", "explore"]
    }
  }
}
```
Enforced at dispatch time in `task.ts`: if the parent agent has a `subagents` list, dispatching a `subagent_type` not in it is rejected with a clear error. If `subagents` is unset, any known agent is allowed.

**b) `permission.task` (low-level escape hatch):**
```jsonc
{
  "agent": {
    "my_driver": {
      "mode": "subagent",
      "can_spawn_subagents": true,
      "permission": { "task": { "*": "deny", "worker": "allow" } }
    }
  }
}
```
The existing `permission.task` ruleset (evaluated per `subagent_type`). When present, `can_spawn_subagents` does **not** add its blanket allow — your scoping wins.

Both apply: an allow-list hit still needs the `task` permission to be allowed.

## 2. `--agent <subagent>` — launch a subagent as root

```sh
opencode run --agent general
opencode --agent explore
```

Previously refused with "agent is a subagent, not a primary agent. Falling back to default agent." Now accepted. A subagent launched as root runs with its **own** `permission` (not the `childToolDenies` that `task.ts` applies — those only apply when spawned via the task tool). So e.g. `--agent general` gets `general`'s permission (`*: allow` minus `todowrite: deny`), which already permits `task`.

`can_spawn_subagents` is **not** consulted here — it's a subagent-of-subagent gate, relevant only to `task.ts` dispatch.

## 3. Preset driver/orchestrator agents

See `.opencode/opencode.jsonc`. Five primary agents:

| Agent | mode | can_spawn_subagents | subagents | Tier |
|---|---|---|---|---|
| `operator` | primary | true | — | primary_visible |
| `architect` | primary | true | — | primary_visible |
| `autonomous-implementer-driver` | primary | true | `implementer, explore, general` | primary_driver_agents |
| `adversarial-plan-review-driver` | primary | true | `plan-reviewer, explore` | primary_driver_agents |
| `adversarial-pr-review-driver` | primary | true | `pr-reviewer, explore` | primary_driver_agents |

### `agent_policy` mapping

The `agent_policy` concept maps directly onto existing + new fields — no separate config block:

- `primary_visible` → `mode: "primary", hidden: false` (operator, architect)
- `primary_driver_agents` → `mode: "primary", can_spawn_subagents: true` (+ `subagents` allow-list) (the three `*-driver` agents)
- `hidden_subagents` → `mode: "subagent", hidden: true` (leaf helpers like `implementer`, `plan-reviewer`, `pr-reviewer` — define these yourself; they don't need to exist for the driver presets to be valid)

## Rationale: why drivers stay `mode: primary`

If subagents couldn't launch another subagent, driver/orchestrator agents would have to stay `mode: primary` to remain directly invocable and able to dispatch. With this feature, you can flip a driver to `mode: subagent` and it will still spawn children (via `can_spawn_subagents: true`) — but keeping them primary is the safe default so they're always reachable from the top level.

## Rollback

Purely additive. `git revert <commit>` removes the two config fields, the allow-list check, the `--agent` guard relaxation, and the presets. No data migration.