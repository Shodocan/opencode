export * as SessionRecall from "./recall"

import { and, asc, eq, lt } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../../database/database"
import { latestCompaction } from "../history"
import type { SessionSchema } from "../schema"
import { SessionMessageTable } from "../sql"

// FORK FEATURE (5) compaction-enhardening — F3 recoverability backstop.
// Searches the pre-compaction conversation rows (the head that compaction
// summarized away) so the agent can recover detail the summary dropped. Reads
// raw JSON `data` (no full SessionMessage decode) so it's resilient to schema
// drift. Best-effort: returns nothing if the session was never compacted, and
// rows hard-deleted by `revert` are genuinely gone.

type DatabaseService = Database.Interface["db"]

// Total chars of snippet content returned to the model (hard ceiling).
const CEILING = 8_000

export interface Match {
  readonly seq: number
  readonly type: string
  readonly snippet: string
}
export interface Result {
  readonly matches: ReadonlyArray<Match>
  readonly total: number
  readonly truncated: boolean
}

export interface SearchOptions {
  readonly query: string
  readonly tool?: string
  readonly limit: number
  readonly contextChars: number
}

type Row = { readonly seq: number; readonly type: string; readonly data: unknown }

// Pure: filter pre-compaction rows by query (and optional tool), window each
// match by contextChars, bound to `limit` and the 8k char ceiling.
export const filterMatches = (rows: ReadonlyArray<Row>, opts: SearchOptions): Result => {
  const q = opts.query.toLowerCase()
  const half = Math.max(20, Math.floor(opts.contextChars / 2))
  const matches: Match[] = []
  let total = 0
  let used = 0
  let truncated = false
  for (const row of rows) {
    const blob = JSON.stringify(row.data ?? "")
    // Match the serialized tool-part `name` field, not the tool name appearing
    // anywhere in content text (common tool names are common English words).
    if (opts.tool && !blob.includes(`"name":"${opts.tool}"`)) continue
    const idx = blob.toLowerCase().indexOf(q)
    if (idx < 0) continue
    total++
    if (matches.length >= opts.limit) {
      truncated = true
      continue
    }
    const start = Math.max(0, idx - half)
    const snippet = blob.slice(start, idx + q.length + half)
    if (used + snippet.length > CEILING) {
      truncated = true
      continue
    }
    used += snippet.length
    matches.push({ seq: row.seq, type: row.type, snippet })
  }
  return { matches, total, truncated: truncated || matches.length < total }
}

// Query the pre-compaction head (seq < latest compaction boundary) and filter.
export const search = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  opts: SearchOptions,
) {
  const boundary = yield* latestCompaction(db, sessionID)
  if (!boundary) return { matches: [], total: 0, truncated: false } satisfies Result
  const rows = yield* db
    .select({ seq: SessionMessageTable.seq, type: SessionMessageTable.type, data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), lt(SessionMessageTable.seq, boundary.seq)))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return filterMatches(rows as ReadonlyArray<Row>, opts)
})
