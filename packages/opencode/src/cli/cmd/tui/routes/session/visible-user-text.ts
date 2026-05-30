import type { Part, TextPart } from "@opencode-ai/sdk/v2"

export function isVisibleUserTextPart(part: Part): part is TextPart {
  if (part.type !== "text") return false
  if (!part.synthetic) return !part.ignored
  return part.metadata?.opencodeMcpVisible === true
}

export function visibleUserTextParts(parts: Part[]) {
  return parts.filter(isVisibleUserTextPart).map((part) => ({
    text: part.text,
    muted: part.synthetic === true,
  }))
}
