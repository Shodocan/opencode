import { describe, expect, test } from "bun:test"
import { formatRepairFailureWarningPayload } from "../../src/session/llm"

describe("session.llm.formatRepairFailureWarningPayload", () => {
  const sessionID = "test-session-123"
  const toolName = "Write"

  test("bounds tool.available to first 15 when there are many tools", () => {
    const available = Array.from({ length: 30 }, (_, i) => `tool-${i}`)
    const payload = formatRepairFailureWarningPayload(
      new Error("tool not available"),
      toolName,
      available,
      sessionID,
    )

    expect(payload["tool.available"]).toEqual(available.slice(0, 15))
    expect(payload["tool.available_count"]).toBe(30)
    expect(payload["tool.available_truncated"]).toBe(true)
  })

  test("includes all tools when there are 15 or fewer", () => {
    const available = ["read", "write", "edit", "glob", "grep"]
    const payload = formatRepairFailureWarningPayload(
      new Error("tool not available"),
      toolName,
      available,
      sessionID,
    )

    expect(payload["tool.available"]).toEqual(available)
    expect(payload["tool.available_count"]).toBe(5)
    expect(payload["tool.available_truncated"]).toBe(false)
  })

  test("handles empty available tools list", () => {
    const payload = formatRepairFailureWarningPayload(
      new Error("no tools"),
      toolName,
      [],
      sessionID,
    )

    expect(payload["tool.available"]).toEqual([])
    expect(payload["tool.available_count"]).toBe(0)
    expect(payload["tool.available_truncated"]).toBe(false)
  })

  test("bounds tool.error to 200 characters when error is long", () => {
    const longError = "E".repeat(300)
    const payload = formatRepairFailureWarningPayload(
      new Error(longError),
      toolName,
      ["read", "write"],
      sessionID,
    )

    expect(payload["tool.error"].length).toBe(200)
    expect(payload["tool.error"].endsWith("...")).toBe(true)
    expect(payload["tool.error_truncated"]).toBe(true)
  })

  test("preserves short tool.error without truncation", () => {
    const shortError = "Model tried to call unavailable tool 'Write'."
    const payload = formatRepairFailureWarningPayload(
      new Error(shortError),
      toolName,
      ["read", "write"],
      sessionID,
    )

    expect(payload["tool.error"]).toBe(shortError)
    expect(payload["tool.error_truncated"]).toBe(false)
  })

  test("preserves tool.name and session.id", () => {
    const payload = formatRepairFailureWarningPayload(
      new Error("error"),
      "CustomTool",
      ["read"],
      "my-session",
    )

    expect(payload["tool.name"]).toBe("CustomTool")
    expect(payload["session.id"]).toBe("my-session")
  })

  test("safely coerces Error instance", () => {
    const error = new Error("error from Error instance")
    const payload = formatRepairFailureWarningPayload(error, toolName, [], sessionID)
    expect(payload["tool.error"]).toBe("error from Error instance")
  })

  test("safely coerces null error without crashing", () => {
    const payload = formatRepairFailureWarningPayload(null, toolName, [], sessionID)
    // errorMessage(null) returns "null" via String(null) fallback
    expect(payload["tool.error"]).toBe("null")
    expect(payload["tool.error_truncated"]).toBe(false)
  })

  test("safely coerces undefined error without crashing", () => {
    const payload = formatRepairFailureWarningPayload(undefined, toolName, [], sessionID)
    // errorMessage(undefined) returns "undefined" via String(undefined) fallback
    expect(payload["tool.error"]).toBe("undefined")
    expect(payload["tool.error_truncated"]).toBe(false)
  })

  test("safely coerces plain object error without crashing", () => {
    const payload = formatRepairFailureWarningPayload({ code: "ERR_TOOL" }, toolName, [], sessionID)
    // errorMessage({ code: "ERR_TOOL" }) returns "unknown error" since no .message field
    expect(typeof payload["tool.error"]).toBe("string")
    expect(payload["tool.error_truncated"]).toBe(false)
  })

  test("safely coerces string error without crashing", () => {
    const payload = formatRepairFailureWarningPayload("plain string error", toolName, [], sessionID)
    // errorMessage("plain string error") returns the string itself
    expect(payload["tool.error"]).toBe("plain string error")
  })

  test("safely coerces numeric error without crashing", () => {
    const payload = formatRepairFailureWarningPayload(42, toolName, [], sessionID)
    // errorMessage(42) returns "42" via String(42) fallback
    expect(payload["tool.error"]).toBe("42")
  })

  test("error at exactly 200 characters is not truncated", () => {
    const exactError = "A".repeat(200)
    const payload = formatRepairFailureWarningPayload(
      new Error(exactError),
      toolName,
      [],
      sessionID,
    )

    expect(payload["tool.error"]).toBe(exactError)
    expect(payload["tool.error_truncated"]).toBe(false)
  })

  test("error at 201 characters is truncated to 200", () => {
    const overError = "B".repeat(201)
    const payload = formatRepairFailureWarningPayload(
      new Error(overError),
      toolName,
      [],
      sessionID,
    )

    expect(payload["tool.error"].length).toBe(200)
    expect(payload["tool.error_truncated"]).toBe(true)
  })

  test("available list at exactly 15 tools is not truncated", () => {
    const available = Array.from({ length: 15 }, (_, i) => `tool-${i}`)
    const payload = formatRepairFailureWarningPayload(
      new Error("ok"),
      toolName,
      available,
      sessionID,
    )

    expect(payload["tool.available"]).toEqual(available)
    expect(payload["tool.available_count"]).toBe(15)
    expect(payload["tool.available_truncated"]).toBe(false)
  })

  test("available list at 16 tools is truncated to 15", () => {
    const available = Array.from({ length: 16 }, (_, i) => `tool-${i}`)
    const payload = formatRepairFailureWarningPayload(
      new Error("ok"),
      toolName,
      available,
      sessionID,
    )

    expect(payload["tool.available"]).toEqual(available.slice(0, 15))
    expect(payload["tool.available_count"]).toBe(16)
    expect(payload["tool.available_truncated"]).toBe(true)
  })
})