import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { MCP_VISIBLE_METADATA, mcpCallerHeader } from "../../util/mcp-visible-message"

export function isVisibleUserTextPart(part: Part): part is TextPart {
  if (part.type !== "text") return false
  if (!part.synthetic) return !part.ignored
  return part.metadata?.[MCP_VISIBLE_METADATA.visible] === true
}

export function visibleUserTextParts(parts: Part[]) {
  return parts.filter(isVisibleUserTextPart).map((part) => {
    const header = mcpCallerHeader(part.metadata)
    return {
      ...(header ? { header } : {}),
      text: part.text,
      muted: part.synthetic === true,
    }
  })
}
