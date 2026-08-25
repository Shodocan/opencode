import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "../../src/v1/config/config"
import { ConfigMigrateV1 } from "../../src/v1/config/migrate"
import { Config as ConfigV2 } from "../../src/config"

// FORK FEATURE (13) autonomy-stack — goal/ralph config schema + migration tests.
// Covers spec D-13..D-16 and E-10.

const decodeV1 = Schema.decodeUnknownSync(ConfigV1.Info)
const decodeV2 = Schema.decodeUnknownSync(ConfigV2.Info)

describe("goal/ralph config schema (D-13, D-14)", () => {
  test("absent blocks parse — zero behavior change when unset", () => {
    const parsed = decodeV1({})
    expect(parsed.goal).toBeUndefined()
    expect(parsed.ralph).toBeUndefined()
  })

  test("v1 goal block parses with the C2 dual budget", () => {
    const parsed = decodeV1({ goal: { enabled: true, maxRounds: 20, maxTokens: 500_000 } })
    expect(parsed.goal?.enabled).toBe(true)
    expect(parsed.goal?.maxRounds).toBe(20)
    expect(parsed.goal?.maxTokens).toBe(500_000)
  })

  test("v1 ralph block parses", () => {
    const parsed = decodeV1({ ralph: { enabled: true, maxRounds: 8 } })
    expect(parsed.ralph?.enabled).toBe(true)
    expect(parsed.ralph?.maxRounds).toBe(8)
  })

  test("negative budgets are rejected", () => {
    expect(() => decodeV1({ goal: { maxRounds: -1 } })).toThrow()
    expect(() => decodeV1({ goal: { maxTokens: -1 } })).toThrow()
  })

  test("D-13: goal does NOT depend on stopRecovery being enabled", () => {
    // The whole point: these ship independently. A config enabling goal while
    // stop-recovery is off must be valid and must keep goal.enabled true.
    const parsed = decodeV1({ stopRecovery: { enabled: false }, goal: { enabled: true } })
    expect(parsed.stopRecovery?.enabled).toBe(false)
    expect(parsed.goal?.enabled).toBe(true)
  })

  test("v2 schema accepts the blocks directly", () => {
    const parsed = decodeV2({ goal: { enabled: true, maxRounds: 5 }, ralph: { enabled: false } } as never)
    expect(parsed.goal?.enabled).toBe(true)
    expect(parsed.ralph?.enabled).toBe(false)
  })
})

describe("v1 -> v2 migration (D-14)", () => {
  test("carries goal and ralph through", () => {
    const v1 = decodeV1({ goal: { enabled: true, maxRounds: 20, maxTokens: 500_000 }, ralph: { enabled: true, maxRounds: 8 } })
    const v2 = ConfigMigrateV1.migrate(v1)
    expect(v2.goal?.enabled).toBe(true)
    expect(v2.goal?.maxRounds).toBe(20)
    expect(v2.goal?.maxTokens).toBe(500_000)
    expect(v2.ralph?.maxRounds).toBe(8)
  })

  test("absent blocks stay absent after migration", () => {
    const v2 = ConfigMigrateV1.migrate(decodeV1({}))
    expect(v2.goal).toBeUndefined()
    expect(v2.ralph).toBeUndefined()
  })
})

describe("per-agent overrides (D-15, D-16)", () => {
  test("D-15 KNOWN_KEYS trap: a per-agent goal survives to the typed path", () => {
    // agent.ts normalize() sweeps every key NOT in KNOWN_KEYS into `options`,
    // and migrateAgent lists per-agent fields EXPLICITLY. Either omission makes
    // `goal: false` vanish silently. Asserted on the migrated value, not the schema.
    const v1 = decodeV1({ agent: { worker: { goal: false, prompt: "w" } } })
    const migrated = ConfigMigrateV1.migrate(v1)
    expect(migrated.agents?.worker?.goal).toBe(false)
    expect((migrated.agents?.worker?.request as never) ?? undefined).toBeUndefined()
  })

  test("per-agent ralph survives migration too", () => {
    const v1 = decodeV1({ agent: { worker: { ralph: false, prompt: "w" } } })
    expect(ConfigMigrateV1.migrate(v1).agents?.worker?.ralph).toBe(false)
  })

  test("D-16: the three per-agent flags are carried independently", () => {
    const v1 = decodeV1({ agent: { worker: { stopRecovery: false, goal: true, prompt: "w" } } })
    const worker = ConfigMigrateV1.migrate(v1).agents?.worker
    expect(worker?.stopRecovery).toBe(false)
    expect(worker?.goal).toBe(true)
    expect(worker?.ralph).toBeUndefined()
    // NOTE: the behavioural half of D-16 (disabling one does not disable the
    // other at evaluation time) is asserted in Step 12, where evaluateGoal exists.
  })
})
