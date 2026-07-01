import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, Agent.node])))

// `deriveSubagentSessionPermission` is the helper task.ts uses to build a
// subagent's session permission. These tests cover the can_spawn_subagents
// field, which flips the default-deny on the `task` tool when set.

it.instance(
  "can_spawn_subagents: true grants task permission when no explicit task rule is set",
  () =>
    Effect.gen(function* () {
      const my = yield* Agent.use.get("spawner_any")
      expect(my).toBeDefined()
      expect(my!.canSpawnSubagents).toBe(true)

      const effective = Permission.merge(
        my!.permission,
        deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: my! }),
      )

      // No explicit task rule → can_spawn_subagents merged a blanket task:allow.
      expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
      expect(Permission.evaluate("task", "anything_else", effective).action).toBe("allow")
    }),
  {
    config: {
      agent: {
        spawner_any: {
          mode: "subagent",
          can_spawn_subagents: true,
        },
      },
    },
  },
)

it.instance(
  "can_spawn_subagents: true preserves explicit task scoping (permission.task wins)",
  () =>
    Effect.gen(function* () {
      const my = yield* Agent.use.get("spawner_scoped")
      expect(my).toBeDefined()
      expect(my!.canSpawnSubagents).toBe(true)

      const effective = Permission.merge(
        my!.permission,
        deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: my! }),
      )

      // Explicit task rule present → can_spawn_subagents did NOT add a blanket allow.
      expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
      expect(Permission.evaluate("task", "other", effective).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        spawner_scoped: {
          mode: "subagent",
          can_spawn_subagents: true,
          permission: {
            task: {
              "*": "deny",
              worker: "allow",
            },
          },
        },
      },
    },
  },
)

it.instance(
  "can_spawn_subagents absent → task remains denied (default-deny regression guard)",
  () =>
    Effect.gen(function* () {
      const my = yield* Agent.use.get("no_spawner")
      expect(my).toBeDefined()
      expect(my!.canSpawnSubagents).toBeUndefined()

      const effective = Permission.merge(
        my!.permission,
        deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: my! }),
      )

      // No can_spawn_subagents, no explicit task rule → task denied.
      expect(Permission.evaluate("task", "worker", effective).action).toBe("deny")
      expect(Permission.evaluate("task", "anything", effective).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        no_spawner: {
          mode: "subagent",
        },
      },
    },
  },
)

it.instance("subagents allow-list is carried through to Agent.Info", () =>
  Effect.gen(function* () {
    const driver = yield* Agent.use.get("my_driver")
    expect(driver).toBeDefined()
    expect(driver!.subagents).toEqual(["worker", "explore"])
  }),
  {
    config: {
      agent: {
        my_driver: {
          mode: "primary",
          can_spawn_subagents: true,
          subagents: ["worker", "explore"],
        },
      },
    },
  },
)