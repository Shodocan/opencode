export * as SessionGoal from "./goal"

// FORK FEATURE (13) autonomy-stack / L4 — the pure goal fold.
//
// Pure by construction: no Effect, no I/O, no clock. The Effect shell that
// appends events and the projector that materialises rows both sit on top of
// this. Keeping the fold pure is what makes the budget accounting auditable --
// the domain records state and can never decide to spend money (spec §4).
//
// SNAPSHOT-NOT-DIFF (D-2, dsh's rule imported verbatim): every goal event
// carries the COMPLETE post-mutation state. Reconstruction therefore never
// needs to read prior events -- `fromEvent` alone is a total decode. `apply`
// exists only to VALIDATE ordering, not to merge.

/** Durable phase. Persisted in the event and the projection. */
export type Phase = "active" | "paused" | "blocked" | "complete"

/** Closed enum, one producer each (D-2 / [F4] / (P15)). */
export type BlockedCode = "round_budget_exceeded" | "token_budget_exceeded" | "halted" | "model_reported"

export interface Blocked {
  readonly code: BlockedCode
  readonly message: string
}

export interface Snapshot {
  readonly goalID: string
  readonly revision: number
  readonly objective: string
  readonly phase: Phase
  readonly maxRounds: number
  readonly maxTokens: number
  readonly roundsStarted: number
  readonly tokensUsed: number
  readonly blocked?: Blocked
}

/**
 * Live activation. NEVER persisted (D-6) -- there is deliberately no schema
 * field for this on the event or the projected row. Durable *intent*,
 * ephemeral *authorization*: a crash or restart can never silently resume
 * spending on a goal the user forgot about.
 */
export type DisarmReason = "load" | "abort"

export interface Activation {
  readonly armed: boolean
  /** Only meaningful while `armed === false`. */
  readonly disarmReason?: DisarmReason
}

/** What re-arming was triggered by. See E-14. */
export type RearmTrigger = "turn" | "resume"

export class GoalRevisionError extends Error {
  readonly _tag = "GoalRevisionError"
  constructor(
    readonly expected: number,
    readonly received: number,
    readonly goalID: string,
  ) {
    super(`goal ${goalID}: expected revision ${expected}, received ${received}`)
    this.name = "GoalRevisionError"
  }
}

/**
 * Every process starts disarmed with reason "load", even when replay finds
 * `phase === "active"` (D-6). This is the whole restart-safety property.
 */
export function initialActivation(): Activation {
  return { armed: false, disarmReason: "load" }
}

export function disarm(reason: DisarmReason): Activation {
  return { armed: false, disarmReason: reason }
}

/**
 * E-14, the F1 blocker resolution. Two disarm reasons, different re-arm rules:
 *
 *   load-disarm  -> ANY evaluated turn re-arms (consistent with frozen C5:
 *                   a wake is "architecturally identical to the user typing").
 *   abort-disarm -> ONLY the explicit `resume` verb re-arms. An evaluated turn
 *                   NEVER clears it -- this is what S-9 requires, and it is why
 *                   one reason-less bit could not satisfy both.
 */
export function rearm(activation: Activation, trigger: RearmTrigger): Activation {
  if (activation.armed) return activation
  if (activation.disarmReason === "abort") {
    return trigger === "resume" ? { armed: true } : activation
  }
  return { armed: true }
}

/**
 * Total decode of one event's snapshot -- no prior state required (D-2).
 */
export function fromEvent(snapshot: Snapshot): Snapshot {
  return snapshot
}

/**
 * Ordering validation (D-3). Loud on gaps and duplicates rather than silently
 * applying, because a silently-applied duplicate would corrupt round accounting
 * and therefore the budget.
 */
export function apply(prev: Snapshot | undefined, next: Snapshot): Snapshot {
  const expected = prev === undefined ? 1 : prev.revision + 1
  if (next.revision !== expected) throw new GoalRevisionError(expected, next.revision, next.goalID)
  return next
}

export function fold(events: readonly Snapshot[]): Snapshot | undefined {
  let acc: Snapshot | undefined
  for (const e of events) acc = apply(acc, e)
  return acc
}

/** Terminal phases fire no further rounds. */
export function isTerminal(snapshot: Snapshot): boolean {
  return snapshot.phase === "blocked" || snapshot.phase === "complete"
}

/**
 * C2 dual budget: round count + token cap, whichever trips first (E-11).
 * Returns the blocked reason, or undefined when the goal may still run.
 * Cumulative-per-goal, not per-round -- the C2 delegated decision.
 */
export function budgetExceeded(snapshot: Snapshot): Blocked | undefined {
  if (snapshot.roundsStarted >= snapshot.maxRounds)
    return {
      code: "round_budget_exceeded",
      message: `Goal stopped: round budget of ${snapshot.maxRounds} reached.`,
    }
  if (snapshot.tokensUsed >= snapshot.maxTokens)
    return {
      code: "token_budget_exceeded",
      message: `Goal stopped: token budget of ${snapshot.maxTokens} reached.`,
    }
  return undefined
}
