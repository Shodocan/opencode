import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import path from "node:path"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageV2 } from "../../src/session/message-v2"

const providerID = ProviderV2.ID.make("opencode-route")
const url = "http://127.0.0.1:1/owned-provider-not-contacted"
const codes = ["ConnectionRefused", "FailedToOpenSocket", "ECONNREFUSED", "ConnectionClosed", "ECONNRESET", "EPIPE", "ETIMEDOUT"]
function serialize(cause: unknown, statusCode?: number) {
  return JSON.parse(JSON.stringify(MessageV2.fromError(new APICallError({
    message: "Owned provider request failed", url, requestBodyValues: {}, isRetryable: true, cause,
    ...(statusCode === undefined ? {} : { statusCode }),
  }), { providerID })))
}

describe("actual native APICallError structured transport serialization", () => {
  test.each(codes)("direct cause code %s survives public error conversion and JSON", code => {
    const error = serialize(Object.assign(new Error("opaque owned transport message"), { code, secret: "never copy this field" }))
    expect(error.name).toBe("APIError")
    expect(error.data.isRetryable).toBe(true)
    expect(error.data.metadata).toEqual({ url, code })
  })

  test.each([undefined, { code: "UnknownTransport" }, { code: null }, { message: "ECONNRESET ConnectionRefused" },
    { cause: { code: "ECONNRESET" } }])("does not invent a direct transport code from %j", cause => {
    const error = serialize(cause)
    expect(error.name).toBe("APIError")
    expect(error.data.metadata).toEqual({ url })
    expect(error.data.isRetryable).toBe(true)
  })

  test.each([400, 401, 503])("preserves HTTP %i alongside ordinary provider facts", status => {
    const error = serialize({ code: "ECONNREFUSED" }, status)
    expect(error.name).toBe("APIError")
    expect(error.data.statusCode).toBe(status)
    expect(error.data.metadata.url).toBe(url)
  })

  test("actual serialized native failures charge the public workflow and reach its frozen fourth-card successor", async () => {
    // Same existing companion-fixture override used by native workflow tests.
    // The helper creates real plugin cards/journals, never writes private state.
    const root = process.env.WORKFLOWS_REPO_ROOT ?? "/tmp/workflows-v4.3.0"
    const { transportFixture } = await import(path.join(root, "test/fixtures/provider-transport.ts"))
    const f = await transportFixture()
    try {
      const frozen = structuredClone(f.state().modelChains.judge.routes)
      for (let i = 0; i < 3; i++) {
        const claim = await f.claim(i)
        expect(claim.card.model.id).toBe(frozen[0].model_id)
        const error = serialize(Object.assign(new Error("opaque native failure"), { code: "ConnectionClosed" }))
        await f.fail(claim, error)
        expect(f.entries()[i]).toMatchObject({ failure_class: "transport_error", eligible_for_route_advance: true })
        expect(f.state().routingCounters.worker).toMatchObject(i === 2 ? { route_index: 1, route_attempts: 0 } : { route_index: 0, route_attempts: i + 1 })
      }
      const fourth = await f.claim(3)
      expect(fourth.card.model).toEqual({ providerID: frozen[1].provider_id, id: frozen[1].model_id, variant: frozen[1].variant })
      expect(f.state().modelChains.judge.routes).toEqual(frozen)
      expect(f.entries()).toHaveLength(3)
    } finally { await f.dispose() }
  })
})
