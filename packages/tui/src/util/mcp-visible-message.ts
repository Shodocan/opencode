export const MCP_VISIBLE_METADATA = {
  visible: "opencodeMcpVisible",
  caller: "opencodeMcpCaller",
} as const

export function mcpCallerHeader(metadata: Record<string, unknown> | undefined) {
  const caller = metadata?.[MCP_VISIBLE_METADATA.caller]
  if (typeof caller !== "string" || caller.trim() === "") return undefined
  return `◇ MCP · ${caller}`
}
