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

export const MARKER = "stop_recovery_continue" as const

/** Resolved config (defaults applied). Feature is OFF unless `enabled: true`. */
export interface Config {
  enabled: boolean
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
}

export type Decision =
  | { action: "none" }
  | { action: "observed"; trigger: "unknown_finish" }
  | { action: "continue"; trigger: "length"; attempt: number; text: string }
  | { action: "nudge_grace" | "nudge"; trigger: "no_tool" | "empty_after_thinking"; attempt: number; reasoningOnly: boolean; text: string }
  | { action: "halt"; trigger: "no_tool" | "empty_after_thinking"; attempts: number; limit: number }

export const DEFAULT_CONTINUE_TEXT = "Continue from where you left off."
export const DEFAULT_NUDGE_TEXT =
  "Your previous reply ended without completing the pending work. Continue with the task: execute the next required action (use a tool if one is needed), or state explicitly that everything is complete. (Automated message from the harness - do not respond to it conversationally.)"

export function initialState(turnKey: string): State {
  return { turnKey, lengthContinues: 0, noProgressCount: 0, graceUsed: false }
}

export function evaluate(config: Config, prev: State | undefined, f: TurnFacts): { decision: Decision; state: State } {
  // turnKey change or first evaluation -> fresh counters (spec §5.0 reset rules)
  const state = prev && prev.turnKey === f.turnKey ? { ...prev } : initialState(f.turnKey)
  const none = (): { decision: Decision; state: State } => ({ decision: { action: "none" }, state })

  // Hard gates (spec §5.4/§5.5) — order matters
  if (!config.enabled || f.agentDisabled) return none()
  if (f.isJsonSchemaTurn) return none()
  if (f.compactionPending) return none()
  if (f.doomLoopPending) return none()
  if (f.hasToolCalls) return none()
  if (f.hasError) return none()
  if (f.finish === "content-filter" || f.finish === "error") return none()

  // Step eligibility (spec §5.5): injected turn runs at step+1; never enter MAX_STEPS regime
  if (f.step + 1 >= f.maxSteps) return none()

  // Unknown finish: telemetry only (spec §5.6 — repetition-kill lands here today)
  if (f.finish === "unknown" || f.finish === undefined) {
    return { decision: { action: "observed", trigger: "unknown_finish" }, state }
  }

  const reasoningOnly = f.textEmpty && f.reasoningPresent

  // length + reasoning-only -> empty-after-thinking family (spec §5.1 routing, F4)
  if (f.finish === "length" && !reasoningOnly) {
    if (!config.lengthContinue.enabled || config.lengthContinue.max === 0) return none()
    if (state.lengthContinues >= config.lengthContinue.max) return none()
    state.lengthContinues++
    return {
      decision: {
        action: "continue",
        trigger: "length",
        attempt: state.lengthContinues,
        text: config.lengthContinue.text ?? DEFAULT_CONTINUE_TEXT,
      },
      state,
    }
  }

  // stop (or length routed here as reasoning-only): nudge family, shared counter + shared single grace
  const isEmptyAfterThinking = reasoningOnly
  const isNoTool = f.finish === "stop" && !f.textEmpty && !f.hasProviderExecutedTools && f.pendingTodos
  if (!isEmptyAfterThinking && !isNoTool) return none()
  const family = isEmptyAfterThinking ? ("empty_after_thinking" as const) : ("no_tool" as const)
  const familyEnabled = isEmptyAfterThinking ? config.emptyAfterThinking.enabled : config.noToolNudge.enabled
  if (!familyEnabled) return none()

  const limit = config.noToolNudge.limit // shared limit for the nudge family (spec §5.2/§5.3)
  const unlimited = limit === 0
  if (!state.graceUsed && config.noToolNudge.graceRetry) {
    state.graceUsed = true
    return {
      decision: {
        action: "nudge_grace",
        trigger: family,
        attempt: 0,
        reasoningOnly,
        text: nudgeText(config, family),
      },
      state,
    }
  }
  if (!unlimited && state.noProgressCount >= limit) {
    return { decision: { action: "halt", trigger: family, attempts: state.noProgressCount, limit }, state }
  }
  state.noProgressCount++
  return {
    decision: {
      action: "nudge",
      trigger: family,
      attempt: state.noProgressCount,
      reasoningOnly,
      text: nudgeText(config, family),
    },
    state,
  }
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
}

/** Resolved (defaults-applied) stop-recovery config; undefined => feature off. */
function resolveConfig(cfg: ConfigV1.Info): Config | undefined {
  const block = cfg.stopRecovery
  if (!block || block.enabled !== true) return undefined
  return {
    enabled: true,
    lengthContinue: {
      enabled: block.lengthContinue?.enabled !== false,
      max: block.lengthContinue?.max ?? 3,
      text: block.lengthContinue?.text,
    },
    noToolNudge: {
      enabled: block.noToolNudge?.enabled !== false,
      limit: block.noToolNudge?.limit ?? 3,
      graceRetry: block.noToolNudge?.graceRetry !== false,
      text: block.noToolNudge?.text,
    },
    emptyAfterThinking: {
      enabled: block.emptyAfterThinking?.enabled !== false,
      text: block.emptyAfterThinking?.text,
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

  const turnKey = realUserTurnKey(input.msgs, input.lastUser)
  const facts: TurnFacts = {
    turnKey,
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
    return "end" as const
  }

  // continue / nudge / nudge_grace: inject synthetic user message (compaction precedent).
  const continueMsg = yield* svc.sessions.updateMessage({
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
    messageID: continueMsg.id,
    sessionID: input.sessionID,
    type: "text",
    metadata: {
      stop_recovery_continue: true,
      stop_recovery: { trigger: decision.trigger, attempt: decision.attempt },
    },
    synthetic: true,
    text: decision.text,
    time: { start: Date.now(), end: Date.now() },
  } as unknown as SessionV1.TextPart)

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

/** Clear state for a session (e.g. on halt / abort). */
export function clearState(sessionID: string) {
  sessionStates.delete(sessionID)
  lastAssistantSeen.delete(sessionID)
}

export * as StopRecovery from "./stop-recovery"
