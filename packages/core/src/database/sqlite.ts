export * as Sqlite from "./sqlite"

import { Context, Predicate } from "effect"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import type { drizzle } from "drizzle-orm/bun-sqlite"

export type DrizzleClient = ReturnType<typeof drizzle>
export class Native extends Context.Service<Native, unknown>()("@opencode-ai/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@opencode-ai/core/database/SqliteDrizzle") {}

/**
 * Busy handler timeout of a connection, in milliseconds. Drivers set it before
 * their first statement: a connection opens with none, and a process starting
 * while others write would fail to open the database instead of waiting.
 */
export const BUSY_TIMEOUT = 5000

/**
 * Busy handler timeout, in milliseconds, for the statement that takes the
 * write lock of a transaction. Unset, the connection's own timeout applies.
 */
export const BeginBusyTimeout = Context.Reference<number | undefined>(
  "@opencode-ai/core/database/SqliteBeginBusyTimeout",
  { defaultValue: () => undefined },
)

/**
 * Runs `statement` with the busy handler set to `timeout` when it is the one
 * that takes the write lock, and puts the previous timeout back before
 * returning. All of it is synchronous, so no other statement of the process
 * ever runs with the shortened handler.
 */
export function withBusyTimeout<A>(
  timeout: number | undefined,
  query: string,
  pragma: (sql: string) => unknown,
  statement: () => A,
) {
  if (timeout === undefined || !/^\s*begin\s+(immediate|exclusive)\b/i.test(query)) return statement()
  const row = pragma("PRAGMA busy_timeout")
  const previous = Predicate.hasProperty(row, "timeout") && typeof row.timeout === "number" ? row.timeout : undefined
  if (previous === undefined || previous === timeout) return statement()
  pragma(`PRAGMA busy_timeout = ${Math.trunc(timeout)}`)
  try {
    return statement()
  } finally {
    pragma(`PRAGMA busy_timeout = ${previous}`)
  }
}

// Primary SQLite result codes by number, for a driver that reports only the number.
const RESULT_CODES = [
  "OK",
  "ERROR",
  "INTERNAL",
  "PERM",
  "ABORT",
  "BUSY",
  "LOCKED",
  "NOMEM",
  "READONLY",
  "INTERRUPT",
  "IOERR",
  "CORRUPT",
  "NOTFOUND",
  "FULL",
  "CANTOPEN",
  "PROTOCOL",
  "EMPTY",
  "SCHEMA",
  "TOOBIG",
  "CONSTRAINT",
  "MISMATCH",
  "MISUSE",
  "NOLFS",
  "AUTH",
  "FORMAT",
  "RANGE",
  "NOTADB",
]
const SQLITE_BUSY_SNAPSHOT = 517

/**
 * The error of a failed statement. Its message keeps what SQLite reported, its
 * result code and the statement that failed (never its parameters), for example
 * "database is locked (SQLITE_BUSY) during BEGIN IMMEDIATE", so the cause
 * survives wherever only the message is logged or shown.
 */
export function failure(cause: unknown, query: string) {
  // node:sqlite reports the result code as `errcode`; the classifier reads `code` and `errno`.
  if (Predicate.hasProperty(cause, "errcode") && typeof cause.errcode === "number" && !("errno" in cause))
    Object.assign(cause, { errno: cause.errcode })
  const code = resultCode(cause)
  const statement = query
    .match(/^\s*(begin(?:\s+\w+)?|\w+)/i)?.[1]
    .replace(/\s+/g, " ")
    .toUpperCase()
  return new SqlError({
    reason: classifySqliteError(cause, {
      message: [
        Predicate.hasProperty(cause, "message") && typeof cause.message === "string" && cause.message
          ? cause.message
          : "Failed to execute statement",
        ...(code ? [`(${code})`] : []),
        ...(statement ? [`during ${statement}`] : []),
      ].join(" "),
      operation: "execute",
    }),
  })
}

function resultCode(cause: unknown) {
  if (Predicate.hasProperty(cause, "code") && typeof cause.code === "string" && cause.code.startsWith("SQLITE_"))
    return cause.code
  if (!Predicate.hasProperty(cause, "errno") || typeof cause.errno !== "number") return undefined
  if (cause.errno === SQLITE_BUSY_SNAPSHOT) return "SQLITE_BUSY_SNAPSHOT"
  const name = RESULT_CODES[cause.errno & 0xff]
  return name ? `SQLITE_${name}` : undefined
}
