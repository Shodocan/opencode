import { describe, expect, test } from "bun:test"
import { visibleUserTextParts } from "../src/routes/session/visible-user-text"

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

  test("FORK FEATURE (9): stop-recovery synthetic part is visible + muted + automated header (UC4)", () => {
    expect(
      visibleUserTextParts([
        {
          id: "prt_recovery",
          type: "text",
          text: "Continue from where you left off.",
          synthetic: true,
          metadata: { stop_recovery_continue: true, stop_recovery: { trigger: "length", attempt: 1 } },
        },
      ] as never),
    ).toEqual([{ text: "Continue from where you left off.", muted: true, header: "auto · stop recovery length 1" }])
  })

  test("FORK FEATURE (9): plain synthetic part without marker stays hidden", () => {
    expect(
      visibleUserTextParts([
        { id: "p", type: "text", text: "x", synthetic: true } as never,
      ]),
    ).toEqual([])
  })

  test("FORK FEATURE (9): stop-recovery header without info falls back", () => {
    const out = visibleUserTextParts([
      { id: "p", type: "text", text: "x", synthetic: true, metadata: { stop_recovery_continue: true } } as never,
    ])
    expect(out).toEqual([{ text: "x", muted: true, header: "auto · stop recovery" }])
  })
})
