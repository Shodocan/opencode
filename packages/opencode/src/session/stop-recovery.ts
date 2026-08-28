// FORK FEATURE (9) stop-recovery — L1 premature-stop recovery decision module.
//
// Pure decision logic (no Effect) for unit testing, plus an Effect shell
// (`decide`) that gathers turn facts, publishes telemetry, and injects
// synthetic continue/nudge messages by direct insertion (compaction precedent).
//
// See docs/artifacts/01-07-2026_premature-stop-recovery/spec.md §5.

import { Effect, DateTime } from "effect"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV1, MessageID, PartID } from "@opencode-ai/core/v1/session"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Session } from "./session"
import type { Agent } from "@/agent/agent"
import type { Permission } from "@/permission"
import { Todo } from "./todo"
import type { EventV2 } from "@opencode-ai/core/event"
import type { Config } from "@/config/config"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionGoalShell } from "./goal-service"

export const MARKER = "stop_recovery_continue" as const

/** Resolved config (defaults applied). Feature is OFF unless `enabled: true`. */
export interface Config {
  enabled: boolean
  /** FORK FEATURE (13) L4 — independent of `enabled` (D-13). */
  goal?: { enabled: boolean; maxRounds: number; maxTokens: number }
  lengthContinue: { enabled: boolean; max: number; text?: string }
  noToolNudge: { enabled: boolean; limit: number; graceRetry: boolean; text?: string }
  emptyAfterThinking: { enabled: boolean; text?: string }
}

/** Per-real-user-turn in-memory state (NOT persisted). */
export interface State {
  turnKey: string
  lengthContinues: number
  noProgressCount: number
  graceUsed: boolean
}

/** Facts about the just-finished turn, gathered by the shell. */
export interface TurnFacts {
  turnKey: string
  finish: string | undefined
  hasError: boolean
  hasToolCalls: boolean
  hasProviderExecutedTools: boolean
  textEmpty: boolean
  reasoningPresent: boolean
  pendingTodos: boolean
  step: number
  maxSteps: number
  isJsonSchemaTurn: boolean
  agentDisabled: boolean
  doomLoopPending: boolean
  compactionPending: boolean
  // FORK FEATURE (13) autonomy-stack — supplied via DecideServices, never via
  // new prompt.ts plumbing (E-12/E-7). All optional so the existing pure test
  // table compiles unmodified (Step 5's deliberately pinned tripwire).
  /** Per-agent disable for goal rounds; split from `agentDisabled` (D-16). */
  goalDisabled?: boolean
  /** Read-only projection of durable goal state. Never mutated here. */
  goal?: {
    snapshot: SessionGoal.Snapshot
    activation: SessionGoal.Activation
    /** The model called `complete` or `report-blocked` on this turn. */
    completionSignalled?: boolean
  }
  /** Context-pressure signal ([F5]); `compaction.isOverflow` at prompt.ts:1228. */
  isOverflow?: boolean
}

export type Decision =
  | { action: "none" }
  | { action: "observed"; trigger: "unknown_finish" }
  | { action: "continue"; trigger: "length"; attempt: number; text: string }
  | { action: "nudge_grace" | "nudge"; trigger: "no_tool" | "empty_after_thinking"; attempt: number; reasoningOnly: boolean; text: string }
  | { action: "halt"; trigger: "no_tool" | "empty_after_thinking"; attempts: number; limit: number }
  // FORK FEATURE (13) L4. New variants need their own dispatch arm BEFORE the
  // legacy tail (D-11) and their own Event.define -- never new literals on the
  // StopRecovery event (D-12).
  | { action: "goal_round"; text: string; roundsStarted: number; overflow: boolean }
  | { action: "goal_blocked"; code: SessionGoal.BlockedCode; message: string }

export const DEFAULT_CONTINUE_TEXT = "Continue from where you left off."
export const GOAL_ROUND_TEXT =
  "The objective is not yet complete. Continue working toward it: take the next concrete action, or call the goal tool to mark it complete or blocked. (Automated message from the harness - do not respond to it conversationally.)"

export const DEFAULT_NUDGE_TEXT =
  "Your previous reply ended without completing the pending work. Continue with the task: execute the next required action (use a tool if one is needed), or state explicitly that everything is complete. (Automated message from the harness - do not respond to it conversationally.)"

export function initialState(turnKey: string): State {
  return { turnKey, lengthContinues: 0, noProgressCount: 0, graceUsed: false }
}

/**
 * Hard gates (spec §5.4/§5.5) — order matters. When any fires, NO branch runs:
 * not stop-recovery, and not the goal branch either (E-2). Split out precisely
 * so a new branch cannot accidentally bypass them by being added lower down.
 */
export function hardGates(_config: Config, f: TurnFacts): boolean {
  // NOTE: the stop-recovery master switch is deliberately NOT here. These are
  // SAFETY gates and bind every branch; feature-enable is per-branch, because
  // goal must not inherit a dependency on stopRecovery.enabled (D-13/D-16).
  if (f.isJsonSchemaTurn) return true
  if (f.compactionPending) return true
  if (f.doomLoopPending) return true
  if (f.hasToolCalls) return true
  if (f.hasError) return true
  if (f.finish === "content-filter" || f.finish === "error") return true
  // Step eligibility (spec §5.5): injected turn runs at step+1; never enter MAX_STEPS regime
  if (f.step + 1 >= f.maxSteps) return true
  return false
}

/**
 * The three legacy recovery families. Returns `undefined` for a POLICY EXIT --
 * meaning "stop-recovery has nothing to say", which is the only place a later
 * branch may intercept (E-2). Mutates `state` in place, exactly as before.
 */
export function evaluateStopRecovery(config: Config, state: State, f: TurnFacts): Decision | undefined {
  // Master switch for THIS family only (moved out of hardGates for D-13).
  if (!config.enabled || f.agentDisabled) return undefined

  // Unknown finish: telemetry only (spec §5.6 — repetition-kill lands here today)
  if (f.finish === "unknown" || f.finish === undefined) {
    return { action: "observed", trigger: "unknown_finish" }
  }

  const reasoningOnly = f.textEmpty && f.reasoningPresent

  // length + reasoning-only -> empty-after-thinking family (spec §5.1 routing, F4)
  if (f.finish === "length" && !reasoningOnly) {
    if (!config.lengthContinue.enabled || config.lengthContinue.max === 0) return undefined
    if (state.lengthContinues >= config.lengthContinue.max) return undefined
    state.lengthContinues++
    return {
      action: "continue",
      trigger: "length",
      attempt: state.lengthContinues,
      text: config.lengthContinue.text ?? DEFAULT_CONTINUE_TEXT,
    }
  }

  // stop (or length routed here as reasoning-only): nudge family, shared counter + shared single grace
  const isEmptyAfterThinking = reasoningOnly
  const isNoTool = f.finish === "stop" && !f.textEmpty && !f.hasProviderExecutedTools && f.pendingTodos
  if (!isEmptyAfterThinking && !isNoTool) return undefined
  const family = isEmptyAfterThinking ? ("empty_after_thinking" as const) : ("no_tool" as const)
  const familyEnabled = isEmptyAfterThinking ? config.emptyAfterThinking.enabled : config.noToolNudge.enabled
  if (!familyEnabled) return undefined

  const limit = config.noToolNudge.limit // shared limit for the nudge family (spec §5.2/§5.3)
  const unlimited = limit === 0
  if (!state.graceUsed && config.noToolNudge.graceRetry) {
    state.graceUsed = true
    return {
      action: "nudge_grace",
      trigger: family,
      attempt: 0,
      reasoningOnly,
      text: nudgeText(config, family),
    }
  }
  if (!unlimited && state.noProgressCount >= limit) {
    // TERMINAL (frozen C3). A goal round may never override or resurrect this.
    return { action: "halt", trigger: family, attempts: state.noProgressCount, limit }
  }
  state.noProgressCount++
  return {
    action: "nudge",
    trigger: family,
    attempt: state.noProgressCount,
    reasoningOnly,
    text: nudgeText(config, family),
  }
}

/**
 * FORK FEATURE (13) autonomy-stack / L4 — the goal branch.
 *
 * Currently INERT: Step 11 is a pure refactor, so this returns `undefined` and
 * `evaluate()` is byte-identical to before. Step 12 fills it in under these
 * invariants, which the composition below enforces structurally:
 *   - it runs only AFTER hardGates() passed and stop-recovery returned a policy
 *     exit, so it can only ever upgrade `none -> action`, never rewrite one;
 *   - it therefore cannot reach the halt return above (frozen C3);
 *   - it must leave `lengthContinues` and `noProgressCount` untouched (C3a/T-2).
 */
export function evaluateGoal(config: Config, state: State, f: TurnFacts): Decision | undefined {
  // Feature-enable is per-branch (D-13/D-16): goal runs even when stop-recovery
  // is off, and a per-agent stopRecovery:false must not disable goal rounds.
  if (!config.goal?.enabled || f.goalDisabled) return undefined

  const projection = f.goal
  if (!projection) return undefined
  const { snapshot } = projection

  // Terminal phases fire nothing. `paused` likewise -- it is a human pause.
  if (snapshot.phase !== "active") return undefined

  // E-14 / [F1] / (P1): a turn clears a LOAD-disarm only. An abort-disarm is
  // cleared solely by the `resume` verb (Steps 15/17) and never here -- that is
  // what makes "abort + unrelated message fires no round" (S-9) hold.
  if (!SessionGoal.rearm(projection.activation, "turn").armed) return undefined

  // The model declared the objective met (or blocked) on this very turn.
  // Its own goal-tool call is the authority; do not start another round.
  if (projection.completionSignalled) return undefined

  // C2 dual budget, per-goal-cumulative (E-11). Checked BEFORE starting a round
  // so the cap is a ceiling on rounds STARTED, not on rounds finished.
  const exceeded = SessionGoal.budgetExceeded(snapshot)
  if (exceeded) return { action: "goal_blocked", code: exceeded.code, message: exceeded.message }

  // E-13 [F13]: the count reported here is the round this decision STARTS.
  // The shell persists it (Step 13); `state` is deliberately untouched -- goal
  // round state is durable and must survive turnKey rotation and clearState.
  return {
    action: "goal_round",
    text: GOAL_ROUND_TEXT,
    roundsStarted: snapshot.roundsStarted + 1,
    overflow: f.isOverflow === true,
  }
}

/** Composition. The ONLY entry point; the three parts above are the contract. */
export function evaluate(config: Config, prev: State | undefined, f: TurnFacts): { decision: Decision; state: State } {
  // turnKey change or first evaluation -> fresh counters (spec §5.0 reset rules)
  const state = prev && prev.turnKey === f.turnKey ? { ...prev } : initialState(f.turnKey)
  if (hardGates(config, f)) return { decision: { action: "none" }, state }
  const recovery = evaluateStopRecovery(config, state, f)
  if (recovery) return { decision: recovery, state }
  const goal = evaluateGoal(config, state, f)
  if (goal) return { decision: goal, state }
  return { decision: { action: "none" }, state }
}

function nudgeText(config: Config, family: "no_tool" | "empty_after_thinking"): string {
  return (family === "no_tool" ? config.noToolNudge.text : config.emptyAfterThinking.text) ?? DEFAULT_NUDGE_TEXT
}

/** Progress reset (spec §5.0): executed tool call on a later assistant message. */
export function onProgress(state: State): State {
  return { ...state, noProgressCount: 0, graceUsed: false }
}
// ---------------------------------------------------------------------------
// Effect shell — facts gathering, telemetry, injection, halt error.
// Called once per would-be turn end from the runLoop exit guard (prompt.ts).
// ---------------------------------------------------------------------------

/** Per-real-user-turn state store, keyed by SessionID (in-memory only). */
const sessionStates = new Map<string, State>()
/** Last-assistant-id seen per session, for progress-reset detection. */
const lastAssistantSeen = new Map<string, string>()

export interface DecideInput {
  sessionID: SessionID
  msgs: SessionV1.WithParts[]
  lastUser: SessionV1.User
  lastAssistant: SessionV1.Assistant
  lastAssistantMsg: SessionV1.WithParts | undefined
  step: number
  compactionPending: boolean
}

export interface DecideServices {
  sessions: Session.Interface
  agents: Agent.Interface
  permission: Permission.Interface
  events: EventV2.Interface
  config: Config.Interface
  todo: Todo.Interface
  /**
   * FORK FEATURE (13) L4 — the goal shell, threaded from the runLoop's own
   * environment. The ambient `serviceOption` is NOT reliable there: the runLoop
   * effect does not see services that are only transitive deps of
   * ToolRegistry, so an ambient-only lookup silently no-ops goal rounds in
   * production while mock-based tests (which provide the service ambiently)
   * stay green. Prefer the threaded service; keep the ambient fallback so the
   * existing `Effect.provide(goal.layer)` test shape keeps working.
   */
  goal?: SessionGoalShell.Interface
}

/** Resolved (defaults-applied) stop-recovery config; undefined => feature off. */
function resolveConfig(cfg: ConfigV1.Info): Config | undefined {
  const block = cfg.stopRecovery
  const goalBlock = cfg.goal
  const srEnabled = block?.enabled === true
  const goalEnabled = goalBlock?.enabled === true
  // D-13: either feature alone is enough to run the evaluator. Bailing on
  // `!stopRecovery.enabled` would make /goal silently depend on it.
  if (!srEnabled && !goalEnabled) return undefined
  return {
    enabled: srEnabled,
    ...(goalEnabled
      ? {
          goal: {
            enabled: true,
            maxRounds: goalBlock?.maxRounds ?? 20,
            maxTokens: goalBlock?.maxTokens ?? 1_000_000,
          },
        }
      : {}),
    lengthContinue: {
      enabled: block?.lengthContinue?.enabled !== false,
      max: block?.lengthContinue?.max ?? 3,
      text: block?.lengthContinue?.text,
    },
    noToolNudge: {
      enabled: block?.noToolNudge?.enabled !== false,
      limit: block?.noToolNudge?.limit ?? 3,
      graceRetry: block?.noToolNudge?.graceRetry !== false,
      text: block?.noToolNudge?.text,
    },
    emptyAfterThinking: {
      enabled: block?.emptyAfterThinking?.enabled !== false,
      text: block?.emptyAfterThinking?.text,
    },
  }
}

/** Walk back past any user message whose text parts are all synthetic. */
function realUserTurnKey(msgs: SessionV1.WithParts[], lastUser: SessionV1.User): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.info.role !== "user") continue
    const textParts = m.parts.filter((p): p is SessionV1.TextPart => p.type === "text")
    if (textParts.length === 0) return m.info.id
    if (!textParts.every((p) => p.synthetic === true)) return m.info.id
  }
  // Anchor pruned (compaction): fabricate from lastUser to keep state keyed.
  return lastUser.id
}

function hasProviderExecutedTools(msg: SessionV1.WithParts | undefined): boolean {
  return !!msg?.parts.some((p) => p.type === "tool" && p.metadata?.providerExecuted === true)
}

function textIsEmpty(msg: SessionV1.WithParts | undefined): boolean {
  const text = msg?.parts.filter((p): p is SessionV1.TextPart => p.type === "text").map((p) => p.text).join("") ?? ""
  return text.trim() === ""
}

function reasoningPresent(msg: SessionV1.WithParts | undefined, assistant: SessionV1.Assistant): boolean {
  if (msg?.parts.some((p) => p.type === "reasoning")) return true
  return (assistant.tokens?.reasoning ?? 0) > 0
}

/**
 * The single entry point the loop calls at the would-be turn end.
 * Returns "injected" when a synthetic message was inserted (loop should
 * `continue`), or "end" when the turn should break as normal.
 */
export const decide = Effect.fn("StopRecovery.decide")(function* (input: DecideInput, svc: DecideServices) {
  const cfg = resolveConfig(yield* svc.config.get())
  // Feature off => no-op (D3/E1). No state, no telemetry.
  if (!cfg) return "end" as const

  const agent = yield* svc.agents.get(input.lastUser.agent)
  const maxSteps = agent.steps ?? Infinity
  const agentDisabled = agent.stopRecovery === false

  // Progress reset (spec §5.0): detect an executed tool on a newer assistant.
  const prevSeen = lastAssistantSeen.get(input.sessionID)
  if (prevSeen !== undefined && input.lastAssistant.id !== prevSeen) {
    // A different assistant message became current; if it carried a real
    // (non-providerExecuted, non-orphan) tool part, reset nudge counters.
    const hasExecutedTool = input.lastAssistantMsg?.parts.some(
      (p) => p.type === "tool" && p.state?.status === "completed" && !p.metadata?.providerExecuted,
    )
    const st = sessionStates.get(input.sessionID)
    if (st && hasExecutedTool) sessionStates.set(input.sessionID, onProgress(st))
  }
  lastAssistantSeen.set(input.sessionID, input.lastAssistant.id)

  // doom_loop pending check (spec §5.5 rule a): Permission.list() filter.
  const pending = yield* svc.permission.list().pipe(Effect.orElseSucceed(() => [] as PermissionV1.Request[]))
  const doomLoopPending = pending.some((r) => r.permission === "doom_loop" && r.sessionID === input.sessionID)

  // pending todos
  const todos = yield* svc.todo.get(input.sessionID).pipe(Effect.orElseSucceed(() => [] as Todo.Info[]))
  const pendingTodos = todos.some((t) => t.status === "pending" || t.status === "in_progress")

  // FORK FEATURE (13) L4 — the goal projection and the context-pressure signal.
  // The goal shell is threaded through DecideServices from the runLoop's own
  // environment. The ambient `serviceOption` is kept ONLY as a fallback for the
  // mock-based shell tests, which provide the service via `Effect.provide` rather
  // than threading it. In production the runLoop effect does NOT see
  // SessionGoalShell ambiently (it is only a transitive dep of ToolRegistry), so
  // an ambient-only lookup silently no-ops every goal round.
  const goalShell = svc.goal ?? (yield* Effect.serviceOption(SessionGoalShell.Service).pipe(
    Effect.map((o) => (o._tag === "Some" ? o.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  ))
  const goalDisabled = agent.goal === false
  const goalFacts =
    cfg.goal?.enabled && goalShell && !goalDisabled
      ? yield* goalShell.read(input.sessionID).pipe(Effect.orElseSucceed(() => undefined))
      : undefined

  // [F5] context pressure. DEFERRED, deliberately and visibly: the evaluator
  // contract carries `isOverflow` (E-12) and evaluateGoal already consumes it,
  // but `SessionCompaction.isOverflow` requires a fully-resolved Model and
  // decide() only has `lastUser.model`, a {providerID, modelID} reference.
  // Resolving it here would mean a Provider lookup on every turn end for a
  // signal that currently only decorates the round decision.
  // TODO(autonomy-stack Step 18): supply the real signal once the goal surface
  // needs it to choose a fresh L3 round over another same-session nudge.
  const isOverflow = false

  const turnKey = realUserTurnKey(input.msgs, input.lastUser)
  const facts: TurnFacts = {
    turnKey,
    goalDisabled,
    ...(goalFacts ? { goal: goalFacts } : {}),
    isOverflow,
    finish: input.lastAssistant.finish,
    hasError: !!input.lastAssistant.error,
    hasToolCalls:
      input.lastAssistantMsg?.parts.some(
        (p) => p.type === "tool" && !p.metadata?.providerExecuted,
      ) ?? false,
    hasProviderExecutedTools: hasProviderExecutedTools(input.lastAssistantMsg),
    textEmpty: textIsEmpty(input.lastAssistantMsg),
    reasoningPresent: reasoningPresent(input.lastAssistantMsg, input.lastAssistant),
    pendingTodos,
    step: input.step,
    maxSteps,
    isJsonSchemaTurn: input.lastUser.format?.type === "json_schema",
    agentDisabled,
    doomLoopPending,
    compactionPending: input.compactionPending,
  }

  const prev = sessionStates.get(input.sessionID)
  const { decision, state } = evaluate(cfg, prev, facts)
  sessionStates.set(input.sessionID, state)

  // Telemetry + action dispatch.
  if (decision.action === "none") return "end" as const

  if (decision.action === "observed") {
    yield* svc.events.publish(SessionEvent.StopRecovery, {
      timestamp: yield* DateTime.now,
      sessionID: input.sessionID,
      messageID: SessionMessage.ID.make(input.lastAssistant.id),
      trigger: decision.trigger,
      action: "observed",
      attempt: 0,
      limit: 0,
    })
    return "end" as const
  }

  if (decision.action === "halt") {
    // Hard stop: set error on assistant message, publish Session.Event.Error.
    const error = new SessionV1.StopRecoveryError({
      message: `Stop recovery: model repeatedly ended its turn without progress (limit ${decision.limit}).`,
      trigger: decision.trigger,
      attempts: decision.attempts,
      limit: decision.limit,
    }).toObject()
    input.lastAssistant.error = error
    yield* svc.sessions.updateMessage(input.lastAssistant)
    yield* svc.events.publish(SessionEvent.StopRecovery, {
      timestamp: yield* DateTime.now,
      sessionID: input.sessionID,
      messageID: SessionMessage.ID.make(input.lastAssistant.id),
      trigger: decision.trigger,
      action: "halt",
      attempt: 0,
      limit: decision.limit,
    })
    clearState(input.sessionID)
    // Frozen C3: halt is terminal and wins. An active goal transitions to
    // blocked with its own durable event and its own code, so a client sees a
    // blocked goal rather than an idle session with a goal still reading active.
    if (goalShell && goalFacts?.snapshot.phase === "active") {
      yield* goalShell.block(input.sessionID, "halted", error.data.message ?? "Stop recovery halted the turn.")
    }
    return "end" as const
  }

  // FORK FEATURE (13) L4 — goal dispatch arms. MUST sit before the legacy tail
  // (D-11): that tail reads .trigger/.attempt/.text/.reasoningOnly unguarded for
  // anything that is not none/observed/halt.
  if (decision.action === "goal_blocked") {
    // The goal owns its OWN terminal event. It cannot piggyback on halt, which
    // calls clearState() and publishes no Session.Event.Error (D-5).
    if (goalShell) yield* goalShell.block(input.sessionID, decision.code, decision.message)
    return "end" as const
  }

  if (decision.action === "goal_round") {
    if (goalShell) yield* goalShell.startRound(input.sessionID)
    // C3a: reset the nudge family at the ROUND boundary, so "no progress"
    // measures within a round instead of across the whole goal. Without this a
    // long goal hits the shared nudge limit of 3 long before its own budget.
    const st = sessionStates.get(input.sessionID)
    if (st) sessionStates.set(input.sessionID, onProgress(st))
    yield* injectSynthetic(input, svc, {
      text: decision.text,
      metadata: { goal: { roundsStarted: decision.roundsStarted, overflow: decision.overflow } },
    })
    return "injected" as const
  }

  // continue / nudge / nudge_grace: inject synthetic user message (compaction precedent).
  yield* injectSynthetic(input, svc, {
    text: decision.text,
    metadata: { stop_recovery: { trigger: decision.trigger, attempt: decision.attempt } },
  })

  yield* svc.events.publish(SessionEvent.StopRecovery, {
    timestamp: yield* DateTime.now,
    sessionID: input.sessionID,
    messageID: SessionMessage.ID.make(input.lastAssistant.id),
    trigger: decision.trigger,
    action: decision.action,
    attempt: decision.attempt,
    limit: decision.action === "continue" ? cfg.lengthContinue.max : cfg.noToolNudge.limit,
    ...(decision.action !== "continue" && decision.reasoningOnly ? { reasoning_only: true } : {}),
    ...(input.lastAssistant.tokens
      ? { tokens: { input: input.lastAssistant.tokens.input, output: input.lastAssistant.tokens.output, reasoning: input.lastAssistant.tokens.reasoning } }
      : {}),
    ...(input.lastAssistant.cost !== undefined ? { cost: input.lastAssistant.cost } : {}),
    agent: input.lastUser.agent,
  })
  return "injected" as const
})

/**
 * ONE injection path for every branch. Factored out deliberately: the
 * format/agent/model carry-forward below is load-bearing, and duplicating it
 * per-branch is how a goal round would silently flip `isJsonSchemaTurn` from
 * true to false and re-enable stop-recovery on a structured-output turn.
 *
 * Always stamps MARKER (`stop_recovery_continue`) so compaction's
 * isSyntheticContinuation keeps recognising the message (T-6) -- goal rounds are
 * differentiated by the `goal` metadata sub-object, not by a new marker.
 */
const injectSynthetic = Effect.fn("StopRecovery.injectSynthetic")(function* (
  input: DecideInput,
  svc: DecideServices,
  part: { text: string; metadata: Record<string, unknown> },
) {
  const msg = yield* svc.sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: input.sessionID,
    time: { created: Date.now() },
    agent: input.lastUser.agent,
    model: input.lastUser.model,
    ...(input.lastUser.format ? { format: input.lastUser.format } : {}),
  } as SessionV1.User)
  yield* svc.sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "text",
    metadata: { [MARKER]: true, ...part.metadata },
    synthetic: true,
    text: part.text,
    time: { start: Date.now(), end: Date.now() },
  } as unknown as SessionV1.TextPart)
  return msg
})

/** Clear state for a session (e.g. on halt / abort). */
export function clearState(sessionID: string) {
  sessionStates.delete(sessionID)
  lastAssistantSeen.delete(sessionID)
}

export * as StopRecovery from "./stop-recovery"
