import { describe, expect, test } from "bun:test"
import { isDefaultTitle, getDescendants, type SessionRow } from "../../src/util/session"

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })
})

describe("getDescendants", () => {
  function makeSessions(rows: [id: string, parentID: string | undefined][]): SessionRow[] {
    return rows.map(([id, parentID]) => ({ id, parentID }))
  }

  test("returns only root when no children exist", () => {
    const sessions = makeSessions([["root", undefined]])
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual(["root"])
  })

  test("includes root and direct child", () => {
    const sessions = makeSessions([
      ["root", undefined],
      ["child1", "root"],
    ])
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual(["root", "child1"])
  })

  test("includes root, child, and grandchild", () => {
    const sessions = makeSessions([
      ["root", undefined],
      ["child1", "root"],
      ["grandchild1", "child1"],
    ])
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual(["root", "child1", "grandchild1"])
  })

  test("includes root, child, grandchild, and great-grandchild", () => {
    const sessions = makeSessions([
      ["root", undefined],
      ["child1", "root"],
      ["grandchild1", "child1"],
      ["great-grandchild1", "grandchild1"],
    ])
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual(["root", "child1", "grandchild1", "great-grandchild1"])
  })

  test("excludes unrelated sessions", () => {
    const sessions = makeSessions([
      ["root", undefined],
      ["child1", "root"],
      ["unrelated", undefined],
      ["unrelated-child", "unrelated"],
    ])
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual(["root", "child1"])
  })

  test("tolerates reachable parentID cycle (root -> child -> grandchild -> root)", () => {
    // Directed cycle via parentID edges: root has child, child has grandchild,
    // grandchild points back to root. root's own parentID = "grandchild" closes
    // the cycle. Traversal must visit each node exactly once, no infinite loop.
    const sessions: SessionRow[] = [
      { id: "root", parentID: "grandchild" },
      { id: "child", parentID: "root" },
      { id: "grandchild", parentID: "child" },
    ]
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual(["root", "child", "grandchild"])
  })

  test("tolerates missing parents", () => {
    const sessions = makeSessions([
      ["root", undefined],
      ["child1", "root"],
      ["orphan", "missing-parent"],
    ])
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual(["root", "child1"])
  })

  test("preserves original session-array source order among included rows", () => {
    const sessions = makeSessions([
      ["root", undefined],
      ["child-a", "root"],
      ["child-b", "root"],
      ["grandchild-a", "child-a"],
      ["grandchild-b", "child-b"],
    ])
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual([
      "root",
      "child-a",
      "child-b",
      "grandchild-a",
      "grandchild-b",
    ])
  })

  test("preserves sibling order for multiple children at same depth", () => {
    const sessions = makeSessions([
      ["root", undefined],
      ["child1", "root"],
      ["child2", "root"],
      ["child3", "root"],
    ])
    const result = getDescendants("root", sessions)
    expect(result.map((s) => s.id)).toEqual(["root", "child1", "child2", "child3"])
  })

  test("returns empty array when root does not exist", () => {
    const sessions = makeSessions([["other", undefined]])
    const result = getDescendants("nonexistent", sessions)
    expect(result).toEqual([])
  })

  test("regression: root queue selector chooses grandchild question", () => {
    // Simulate exactly what the session route does: use getDescendants to
    // select session IDs, then flatMap permissions/questions by session ID.
    const sessions = makeSessions([
      ["root", undefined],
      ["child1", "root"],
      ["grandchild1", "child1"],
    ])
    const descendantIDs = getDescendants("root", sessions).map((s) => s.id)

    // Simulate permission/question data keyed by session ID
    const questions: Record<string, { id: string; sessionID: string }[]> = {
      grandchild1: [{ id: "q1", sessionID: "grandchild1" }],
    }

    const collected = descendantIDs.flatMap((id) => questions[id] ?? [])
    expect(collected).toEqual([{ id: "q1", sessionID: "grandchild1" }])
  })
})