import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { MCP_VISIBLE_METADATA, mcpCallerHeader } from "../../util/mcp-visible-message"

// FORK FEATURE (9) stop-recovery — part-level marker key (sibling of the MCP
// visible-metadata key). Synthetic recovery parts are visible-muted-automated.
const STOP_RECOVERY_MARKER = "stop_recovery_continue"

export function isVisibleUserTextPart(part: Part): part is TextPart {
  if (part.type !== "text") return false
  if (!part.synthetic) return !part.ignored
  if (part.metadata?.[MCP_VISIBLE_METADATA.visible] === true) return true
  // FORK FEATURE (9) stop-recovery — visible-muted-automated recovery nudges.
  if (part.metadata?.[STOP_RECOVERY_MARKER] === true) return true
  return false
}

export function visibleUserTextParts(parts: Part[]) {
  return parts.filter(isVisibleUserTextPart).map((part) => {
    const header = mcpCallerHeader(part.metadata) ?? stopRecoveryHeader(part.metadata)
    return {
      ...(header ? { header } : {}),
      text: part.text,
      muted: part.synthetic === true,
    }
  })
}

// Automated-source header for stop-recovery synthetic parts:
// `auto · stop recovery <trigger> <attempt>/<limit>`.
function stopRecoveryHeader(metadata: Record<string, unknown> | undefined) {
  const marker = metadata?.[STOP_RECOVERY_MARKER]
  if (marker !== true) return undefined
  const info = metadata?.stop_recovery
  if (typeof info !== "object" || info === null) return "auto · stop recovery"
  const trigger = (info as { trigger?: unknown }).trigger
  const attempt = (info as { attempt?: unknown }).attempt
  const triggerText = typeof trigger === "string" ? trigger : "unknown"
  const attemptText = typeof attempt === "number" ? `${attempt}` : "?"
  return `auto · stop recovery ${triggerText} ${attemptText}`
}
