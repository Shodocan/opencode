import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Event } from "../src/event"
import { SessionEvent } from "../src/session-event"
import { SessionMessage } from "../src/session-message"

const model = { id: "gpt-5", providerID: "openai" }
const fallbackModel = { id: "claude-sonnet", providerID: "anthropic", variant: "high" }

describe("public event schemas", () => {
  test("definition is pure", () => {
    const definitions = Event.inventory()
    Event.define({ type: "test.pure", schema: { value: Schema.String } })
    expect(definitions).toEqual([])
  })

  test("latest selection is independent of declaration order", () => {
    const historical = Event.define({
      type: "test.versioned",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })
    const current = Event.define({
      type: "test.versioned",
      durable: { aggregate: "id", version: 2 },
      schema: { id: Schema.String, value: Schema.String },
    })

    expect(Event.latest([historical, current]).get(current.type)).toBe(current)
    expect(Event.latest([current, historical]).get(current.type)).toBe(current)
  })

  test("durable definitions are indexed by type and version", () => {
    const definition = Event.define({
      type: "test.durable",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })

    expect(Event.durable([definition]).get("test.durable.1")).toBe(definition)
  })

  test("model-switched event decodes legacy payloads without fallback metadata", () => {
    expect(
      Schema.decodeUnknownSync(SessionEvent.ModelSwitched)({
        id: "evt_legacy",
        type: "session.next.model.switched",
        data: {
          timestamp: 1,
          sessionID: "ses_legacy",
          messageID: "msg_legacy",
          model,
        },
      }).data,
    ).toMatchObject({ sessionID: "ses_legacy", messageID: "msg_legacy", model })
  })

  test("model-switched event carries optional fallback takeover metadata", () => {
    expect(
      Schema.decodeUnknownSync(SessionEvent.ModelSwitched)({
        id: "evt_fallback",
        type: "session.next.model.switched",
        data: {
          timestamp: 1,
          sessionID: "ses_fallback",
          messageID: "msg_fallback",
          model: fallbackModel,
          source: "fallback",
          from: model,
          reason: { category: "rate-limit", message: "rate limit" },
          attempts: { total: 3, lowerLevel: 3, runnerLevel: 0 },
        },
      }).data,
    ).toMatchObject({
      source: "fallback",
      from: model,
      reason: { category: "rate-limit", message: "rate limit" },
      attempts: { total: 3, lowerLevel: 3, runnerLevel: 0 },
    })
  })

  test("model-switched message carries optional fallback takeover metadata", () => {
    expect(
      Schema.decodeUnknownSync(SessionMessage.ModelSwitched)({
        id: "msg_fallback",
        type: "model-switched",
        model: fallbackModel,
        source: "fallback",
        from: model,
        reason: { category: "provider-offline", message: "provider offline" },
        attempts: { total: 3, lowerLevel: 0, runnerLevel: 3 },
        time: { created: 1 },
      }),
    ).toMatchObject({
      source: "fallback",
      from: model,
      reason: { category: "provider-offline", message: "provider offline" },
      attempts: { total: 3, lowerLevel: 0, runnerLevel: 3 },
    })
  })
})
