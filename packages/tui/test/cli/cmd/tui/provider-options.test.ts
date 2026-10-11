import { describe, expect, test } from "bun:test"
import { normalizeCustomProviderID, providerOptions } from "../../../../src/component/dialog-provider"

describe("providerOptions", () => {
  test("includes a synthetic Other option for custom providers", () => {
    expect(providerOptions({ all: [{ id: "openai", name: "OpenAI" }] }).at(-1)).toMatchObject({
      title: "Other",
      description: "Custom provider",
      category: "Providers",
    })
  })

  test("does not use Other as the generic provider category", () => {
    expect(providerOptions({ all: [{ id: "mistral", name: "Mistral" }] })[0]?.category).toBe("Providers")
  })

  test("keeps popular providers first and sorts the rest alphabetically", () => {
    expect(
      providerOptions({
        all: [
          { id: "openai", name: "OpenAI" },
          { id: "custom-z", name: "Zebra Provider" },
          { id: "anthropic", name: "Anthropic" },
          { id: "mistral", name: "Mistral" },
          { id: "aws", name: "AWS Bedrock" },
        ],
      }).map((option) => option.value),
    ).toEqual(["openai", "anthropic", "aws", "mistral", "custom-z", "__opencode_custom_provider__"])
  })

  test("does not collide with a configured provider named other", () => {
    const values = providerOptions({ all: [{ id: "other", name: "Other Provider" }] }).map((option) => option.value)
    expect(new Set(values).size).toBe(values.length)
  })

  test("uses discovery for Connect and falls back to active providers on older servers", () => {
    const all = [{ id: "google", name: "Google" }]
    const discovery = [{ id: "openai", name: "OpenAI" }]
    expect(providerOptions({ all, discovery }).map((option) => option.value)).toEqual([
      "openai",
      "__opencode_custom_provider__",
    ])
    expect(providerOptions({ all }).map((option) => option.value)).toEqual(["google", "__opencode_custom_provider__"])
  })

  test("normalizes and validates custom provider ids", () => {
    expect(normalizeCustomProviderID("  custom-provider  ")).toBe("custom-provider")
    expect(normalizeCustomProviderID("custom_provider")).toBe("custom_provider")
    expect(normalizeCustomProviderID("@ai-sdk/custom-provider")).toBe("custom-provider")
    expect(normalizeCustomProviderID("-custom-provider")).toBeUndefined()
    expect(normalizeCustomProviderID("Custom Provider")).toBeUndefined()
  })
})
