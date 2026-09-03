import { describe, expect, test } from "bun:test"
import { visibleUserTextParts } from "../../src/routes/session/visible-user-text"

describe("visible user text parts", () => {
  test("shows synthetic integration text only when explicitly visible and muted", () => {
    expect(
      visibleUserTextParts([
        {
          id: "prt_hidden",
          type: "text",
          text: "hidden integration text",
          synthetic: true,
        },
        {
          id: "prt_visible",
          type: "text",
          text: "visible integration text",
          synthetic: true,
          metadata: { opencodeMcpVisible: true, opencodeMcpCaller: "whisperer" },
        },
        {
          id: "prt_user",
          type: "text",
          text: "normal user text",
        },
      ] as never),
    ).toEqual([
      { text: "visible integration text", muted: true, header: "◇ MCP · whisperer" },
      { text: "normal user text", muted: false },
    ])
  })
})
