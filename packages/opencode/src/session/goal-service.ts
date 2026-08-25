import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DateTime, Effect, Layer, Context } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionGoalTable } from "@opencode-ai/core/session/sql"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "./schema"

// FORK FEATURE (13) autonomy-stack / L4 — the goal Effect shell.
//
// The domain (core/session/goal.ts) is pure and cannot schedule or spend. This
// shell is the ONLY thing that writes goal events, and it is deliberately thin.
//
// Activation lives here, in memory, and is NEVER persisted (D-6): a fresh
// process starts every goal `disarmed` with reason "load" even when replay finds
// phase "active". Durable intent, ephemeral authorization.

export interface Projection {
  snapshot: SessionGoal.Snapshot
  activation: SessionGoal.Activation
}

export interface Interface {
  readonly read: (sessionID: SessionID) => Effect.Effect<Projection | undefined>
  /** S-1a: open a goal. Starts armed — the human/model just asked for it. */
  readonly create: (
    sessionID: SessionID,
    input: { objective: string; maxRounds?: number; maxTokens?: number },
  ) => Effect.Effect<void>
  /** S-1b: terminal success. */
  readonly complete: (sessionID: SessionID) => Effect.Effect<void>
  /** Persist the start of a round (E-13). Returns the new snapshot. */
  readonly startRound: (sessionID: SessionID, tokensUsed?: number) => Effect.Effect<void>
  /** Terminal: persist a blocked phase with its code (D-2 / [F4]). */
  readonly block: (
    sessionID: SessionID,
    code: SessionGoal.BlockedCode,
    message: string,
  ) => Effect.Effect<void>
  /**
   * E-15 / [F2]: fold spend that happened in a CHILD session into this goal's
   * cumulative tokensUsed. Without it C2's "honest cost ceiling" cannot hold for
   * a ralph-driven goal, whose spend is almost entirely in child sessions that
   * E-13's three origins never count.
   */
  readonly addTokens: (sessionID: SessionID, delta: number) => Effect.Effect<void>
  /** E-14: set a disarm reason. `abort` is cleared only by `resume`. */
  readonly disarm: (sessionID: SessionID, reason: SessionGoal.DisarmReason) => Effect.Effect<void>
  /** E-14 / S-1d: explicit re-arm, the only thing that clears an abort-disarm. */
  readonly resume: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoalShell") {}

/** Budget defaults when the caller does not supply them (mirrors resolveConfig). */
const DEFAULT_MAX_ROUNDS = 20
const DEFAULT_MAX_TOKENS = 1_000_000

/** Process-local activation. Never persisted — that is the whole point (D-6). */
const activations = new Map<string, SessionGoal.Activation>()

export function activationFor(sessionID: string): SessionGoal.Activation {
  return activations.get(sessionID) ?? SessionGoal.initialActivation()
}

export function setActivation(sessionID: string, activation: SessionGoal.Activation) {
  activations.set(sessionID, activation)
}

/** Test seam only. */
export function clearActivations() {
  activations.clear()
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const row = (sessionID: SessionID) =>
      db.select().from(SessionGoalTable).where(eq(SessionGoalTable.session_id, sessionID)).get().pipe(Effect.orDie)

    const toSnapshot = (r: NonNullable<Awaited<ReturnType<typeof db.select>>> | any): SessionGoal.Snapshot => ({
      goalID: r.goal_id,
      revision: r.revision,
      objective: r.objective,
      phase: r.phase,
      maxRounds: r.max_rounds,
      maxTokens: r.max_tokens,
      roundsStarted: r.rounds_started,
      tokensUsed: r.tokens_used,
      ...(r.blocked_code ? { blocked: { code: r.blocked_code, message: r.blocked_message ?? "" } } : {}),
    })

    const read = Effect.fn("Goal.read")(function* (sessionID: SessionID) {
      const r = yield* row(sessionID)
      if (!r) return undefined
      return { snapshot: toSnapshot(r), activation: activationFor(sessionID) } satisfies Projection
    })

    /** Every mutation republishes the FULL post-mutation snapshot (D-2). */
    const emit = Effect.fn("Goal.emit")(function* (sessionID: SessionID, next: SessionGoal.Snapshot) {
      yield* events.publish(SessionEvent.Goal.Changed, {
        sessionID,
        timestamp: yield* DateTime.now,
        goalID: next.goalID,
        revision: next.revision,
        objective: next.objective,
        phase: next.phase,
        maxRounds: next.maxRounds,
        maxTokens: next.maxTokens,
        roundsStarted: next.roundsStarted,
        tokensUsed: next.tokensUsed,
        ...(next.blocked ? { blocked: next.blocked } : {}),
      } as never)
    })

    const create = Effect.fn("Goal.create")(function* (
      sessionID: SessionID,
      init: { objective: string; maxRounds?: number; maxTokens?: number },
    ) {
      const r = yield* row(sessionID)
      const revision = r ? r.revision + 1 : 1
      // Creating a goal arms it: the request to start is itself the
      // authorization. Only a RESTART or an abort disarms (D-6 / E-14).
      setActivation(sessionID, { armed: true })
      yield* emit(sessionID, {
        goalID: `gol_${Date.now().toString(36)}`,
        revision,
        objective: init.objective,
        phase: "active",
        maxRounds: init.maxRounds ?? DEFAULT_MAX_ROUNDS,
        maxTokens: init.maxTokens ?? DEFAULT_MAX_TOKENS,
        roundsStarted: 0,
        tokensUsed: 0,
      })
    })

    const complete = Effect.fn("Goal.complete")(function* (sessionID: SessionID) {
      const r = yield* row(sessionID)
      if (!r) return
      const prev = toSnapshot(r)
      const { blocked: _drop, ...rest } = prev
      yield* emit(sessionID, { ...rest, revision: prev.revision + 1, phase: "complete" })
    })

    const startRound = Effect.fn("Goal.startRound")(function* (sessionID: SessionID, tokensUsed?: number) {
      const r = yield* row(sessionID)
      if (!r) return
      const prev = toSnapshot(r)
      const { blocked: _drop, ...rest } = prev
      yield* emit(sessionID, {
        ...rest,
        revision: prev.revision + 1,
        roundsStarted: prev.roundsStarted + 1,
        tokensUsed: tokensUsed ?? prev.tokensUsed,
      })
    })

    const addTokens = Effect.fn("Goal.addTokens")(function* (sessionID: SessionID, delta: number) {
      if (delta <= 0) return
      const r = yield* row(sessionID)
      if (!r) return
      const prev = toSnapshot(r)
      yield* emit(sessionID, { ...prev, revision: prev.revision + 1, tokensUsed: prev.tokensUsed + delta })
    })

    const block = Effect.fn("Goal.block")(function* (
      sessionID: SessionID,
      code: SessionGoal.BlockedCode,
      message: string,
    ) {
      const r = yield* row(sessionID)
      if (!r) return
      const prev = toSnapshot(r)
      yield* emit(sessionID, { ...prev, revision: prev.revision + 1, phase: "blocked", blocked: { code, message } })
    })

    const disarm = (sessionID: SessionID, reason: SessionGoal.DisarmReason) =>
      Effect.sync(() => setActivation(sessionID, SessionGoal.disarm(reason)))

    const resume = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const r = yield* row(sessionID)
        // S-1d precondition (P7): resume re-arms ONLY an active goal. On a
        // blocked or complete goal it is rejected and re-arms nothing --
        // enforcing frozen C3 rather than conflicting with it.
        if (!r || r.phase !== "active") return false
        setActivation(sessionID, SessionGoal.rearm(activationFor(sessionID), "resume"))
        return true
      })

    return { read, create, complete, startRound, addTokens, block, disarm, resume } satisfies Interface
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, EventV2Bridge.node],
})

export * as SessionGoalShell from "./goal-service"
