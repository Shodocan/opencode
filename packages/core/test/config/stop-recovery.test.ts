import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "../../src/v1/config/config"
import { ConfigMigrateV1 } from "../../src/v1/config/migrate"
import { Config as ConfigV2 } from "../../src/config"
import { ConfigStopRecovery } from "../../src/config/stop-recovery"

// FORK FEATURE (9) stop-recovery — config schema + migration tests.
// Covers spec §7 D2: schema accepts the shape; v1->v2 migration carries
// stopRecovery; agent KNOWN_KEYS updated; defaults snapshot unchanged when absent.

const decodeV1 = Schema.decodeUnknownSync(ConfigV1.Info)
const decodeV2 = Schema.decodeUnknownSync(ConfigV2.Info)

describe("stopRecovery config schema (FORK FEATURE 9)", () => {
  test("v1 config without stopRecovery parses (back-compat, D2)", () => {
    const parsed = decodeV1({})
    expect(parsed.stopRecovery).toBeUndefined()
  })

  test("v1 full stopRecovery block parses", () => {
    const parsed = decodeV1({
      stopRecovery: {
        enabled: true,
        lengthContinue: { enabled: true, max: 3, text: "Continue where you left off." },
        noToolNudge: { enabled: true, limit: 3, graceRetry: true, text: "Please continue." },
        emptyAfterThinking: { enabled: true, text: "Provide your answer." },
      },
    })
    expect(parsed.stopRecovery?.enabled).toBe(true)
    expect(parsed.stopRecovery?.lengthContinue?.max).toBe(3)
    expect(parsed.stopRecovery?.noToolNudge?.limit).toBe(3)
    expect(parsed.stopRecovery?.emptyAfterThinking?.enabled).toBe(true)
  })

  test("v1 lengthContinue.max out of range (9) is rejected", () => {
    expect(() =>
      decodeV1({ stopRecovery: { lengthContinue: { max: 9 } } }),
    ).toThrow()
  })

  test("v1 empty text override is rejected", () => {
    expect(() => decodeV1({ stopRecovery: { lengthContinue: { text: "" } } })).toThrow()
  })

  test("v1 agent stopRecovery: false parses and is a KNOWN_KEY (survives normalize)", () => {
    const parsed = decodeV1({
      agent: { resilient: { stopRecovery: false, prompt: "p" } },
    })
    // normalize moves unknown keys into options; stopRecovery is a KNOWN_KEY so it stays.
    const agent = parsed.agent?.resilient
    expect(agent?.stopRecovery).toBe(false)
  })

  test("v2 stopRecovery block parses", () => {
    const parsed = decodeV2({
      stopRecovery: {
        enabled: true,
        lengthContinue: { enabled: true, max: 2 },
        noToolNudge: { graceRetry: false, limit: 2 },
        emptyAfterThinking: { enabled: false },
      },
    })
    expect(parsed.stopRecovery?.enabled).toBe(true)
    expect(parsed.stopRecovery?.lengthContinue?.max).toBe(2)
    expect(parsed.stopRecovery?.noToolNudge?.graceRetry).toBe(false)
    expect(parsed.stopRecovery?.emptyAfterThinking?.enabled).toBe(false)
  })

  test("v2 config without stopRecovery parses (undefined)", () => {
    const parsed = decodeV2({})
    expect(parsed.stopRecovery).toBeUndefined()
  })

  test("v1 -> v2 migration carries stopRecovery root block + agent key", () => {
    const v1 = decodeV1({
      stopRecovery: {
        enabled: true,
        lengthContinue: { max: 4 },
        noToolNudge: { limit: 2, graceRetry: false },
        emptyAfterThinking: { enabled: true },
      },
      agent: { worker: { stopRecovery: false, prompt: "w" } },
    })
    const migrated = ConfigMigrateV1.migrate(v1)
    expect(migrated.stopRecovery?.enabled).toBe(true)
    expect(migrated.stopRecovery?.lengthContinue?.max).toBe(4)
    expect(migrated.stopRecovery?.noToolNudge?.graceRetry).toBe(false)
    expect(migrated.stopRecovery?.emptyAfterThinking?.enabled).toBe(true)
    // agent disable key carried through migrateAgent
    expect(migrated.agents?.worker?.stopRecovery).toBe(false)
  })

  test("v2 ConfigStopRecovery.LengthContinue max boundary 0 and 5 accepted, rejected above", () => {
    expect(Schema.decodeSync(ConfigStopRecovery.LengthContinue)({ max: 0 }).max).toBe(0)
    expect(Schema.decodeSync(ConfigStopRecovery.LengthContinue)({ max: 5 }).max).toBe(5)
    expect(() => Schema.decodeSync(ConfigStopRecovery.LengthContinue)({ max: 6 })).toThrow()
  })
})