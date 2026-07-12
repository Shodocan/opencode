export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export type SessionRow = { id: string; parentID?: string }

/**
 * Pure, cycle-safe descendant selector for a root session.
 * Returns the root session plus all descendants (children, grandchildren, etc.).
 * Tolerates parent cycles and missing parents.
 * Output preserves the original session-array source order among included rows.
 */
export function getDescendants(
  rootID: string,
  sessions: SessionRow[],
): SessionRow[] {
  // Collect all reachable descendant IDs via BFS (order-independent).
  const descendantIDs = new Set<string>()
  const queue: string[] = [rootID]

  while (queue.length > 0) {
    const currentID = queue.shift()!
    if (descendantIDs.has(currentID)) continue
    descendantIDs.add(currentID)

    for (const s of sessions) {
      if (s.parentID === currentID && !descendantIDs.has(s.id)) {
        queue.push(s.id)
      }
    }
  }

  // Return included rows in original source-array order.
  return sessions.filter((s) => descendantIDs.has(s.id))
}
