// FORK FEATURE (10) gates — workflow-agnostic dispatch enforcement primitive.
//
// A declarative `gates` block on an agent definition, evaluated at task-dispatch
// time (when a parent agent spawns a child via the task tool). The fork knows
// nothing about specific workflows, judges, or reviewers — only artifacts,
// counts, and prior dispatches. All workflow semantics live in the harness
// config that renders these fields.
//
// Field semantics (see docs/artifacts/02-07-2026_agent-md-hardening/):
//   requires_artifacts:    evaluated when THIS agent is dispatched as a child.
//                          each entry: { glob, min_count? }. `glob` may contain
//                          the literal token `<run_root>`, substituted from the
//                          dispatching task brief (`run_root: <abs path>` line
//                          in the prompt). If `run_root` is absent and the glob
//                          needs it → gate fails with `missing_run_root`.
//   requires_prior_dispatch: evaluated when THIS agent is dispatched. passes if
//                          the DISPATCHING session has already spawned ≥
//                          `min_count` children whose agent name matches
//                          `agent_pattern` (glob-style). `scope: session` =
//                          parent session lifetime (only v1 scope).
//   first_dispatch_must_be: evaluated on the FIRST child dispatch of the agent
//                          that carries this field (constrains the CARRIER as
//                          parent, not as child). If the first spawned child is
//                          not the named agent, block that dispatch.
//
// Error contract: a blocked dispatch returns a structured BLOCKED object to the
// parent as the task tool result (NOT a hard session error), so the parent LLM
// can self-repair. Malformed `gates` fail fast at startup with the agent name.

export * as Gates from "./gates"

import { Effect } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { Session } from "@/session/session"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequireArtifactsEntry {
  glob: string
  min_count?: number
}

export interface RequirePriorDispatchEntry {
  agent_pattern: string
  min_count?: number
  scope?: "session"
}

export interface Gates {
  requires_artifacts?: RequireArtifactsEntry[]
  requires_prior_dispatch?: RequirePriorDispatchEntry[]
  first_dispatch_must_be?: string
}

const KNOWN_GATE_KEYS = new Set([
  "requires_artifacts",
  "requires_prior_dispatch",
  "first_dispatch_must_be",
])

// Unknown sub-keys warned once across the process (forward compatibility).
const warnedUnknownKeys = new Set<string>()

// ---------------------------------------------------------------------------
// Parse / validate (fail-fast at startup with the agent name)
// ---------------------------------------------------------------------------

export class GatesConfigError extends Error {
  readonly agent: string
  constructor(agent: string, message: string) {
    super(`agent "${agent}" has malformed gates: ${message}`)
    this.name = "GatesConfigError"
    this.agent = agent
  }
}

/**
 * Parse + validate a raw `gates` value into a typed {@link Gates}. Returns
 * `undefined` when `raw` is null/undefined. Throws {@link GatesConfigError}
 * (naming the agent) when the structure is malformed — so config-load fails
 * fast at startup, not at dispatch time.
 *
 * Unknown `gates` sub-keys are warned once and ignored (forward compatibility).
 */
export function parseGates(agent: string, raw: unknown): Gates | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new GatesConfigError(agent, "must be a mapping (object), got " + describe(raw))
  }
  const obj = raw as Record<string, unknown>
  const gates: Gates = {}

  // Unknown sub-keys: warn once, ignore.
  for (const key of Object.keys(obj)) {
    if (!KNOWN_GATE_KEYS.has(key) && !warnedUnknownKeys.has(key)) {
      warnedUnknownKeys.add(key)
      // eslint-disable-next-line no-console
      console.warn(`[fork:gates] unknown gates sub-key "${key}" on agent "${agent}" — ignored (forward compatibility).`)
    }
  }

  if (obj.requires_artifacts !== undefined) {
    if (!Array.isArray(obj.requires_artifacts)) {
      throw new GatesConfigError(agent, "requires_artifacts must be an array")
    }
    gates.requires_artifacts = obj.requires_artifacts.map((entry, i) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new GatesConfigError(agent, `requires_artifacts[${i}] must be a mapping`)
      }
      const e = entry as Record<string, unknown>
      if (typeof e.glob !== "string") {
        throw new GatesConfigError(agent, `requires_artifacts[${i}].glob must be a string`)
      }
      const minCount = e.min_count
      if (minCount !== undefined && (typeof minCount !== "number" || !Number.isFinite(minCount) || minCount < 0)) {
        throw new GatesConfigError(agent, `requires_artifacts[${i}].min_count must be a non-negative number`)
      }
      return { glob: e.glob, ...(minCount !== undefined ? { min_count: minCount } : {}) }
    })
  }

  if (obj.requires_prior_dispatch !== undefined) {
    if (!Array.isArray(obj.requires_prior_dispatch)) {
      throw new GatesConfigError(agent, "requires_prior_dispatch must be an array")
    }
    gates.requires_prior_dispatch = obj.requires_prior_dispatch.map((entry, i) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new GatesConfigError(agent, `requires_prior_dispatch[${i}] must be a mapping`)
      }
      const e = entry as Record<string, unknown>
      if (typeof e.agent_pattern !== "string") {
        throw new GatesConfigError(agent, `requires_prior_dispatch[${i}].agent_pattern must be a string`)
      }
      const minCount = e.min_count
      if (minCount !== undefined && (typeof minCount !== "number" || !Number.isFinite(minCount) || minCount < 0)) {
        throw new GatesConfigError(agent, `requires_prior_dispatch[${i}].min_count must be a non-negative number`)
      }
      const scope = e.scope
      if (scope !== undefined && scope !== "session") {
        throw new GatesConfigError(agent, `requires_prior_dispatch[${i}].scope must be "session" (only v1 scope)`)
      }
      return {
        agent_pattern: e.agent_pattern,
        ...(minCount !== undefined ? { min_count: minCount } : {}),
        ...(scope !== undefined ? { scope } : {}),
      }
    })
  }

  if (obj.first_dispatch_must_be !== undefined) {
    if (typeof obj.first_dispatch_must_be !== "string") {
      throw new GatesConfigError(agent, "first_dispatch_must_be must be a string")
    }
    gates.first_dispatch_must_be = obj.first_dispatch_must_be
  }

  return gates
}

// ---------------------------------------------------------------------------
// Blocked-result shape (the error contract the harness depends on)
// ---------------------------------------------------------------------------

export interface BlockedResult {
  status: "BLOCKED"
  gate: "requires_artifacts" | "requires_prior_dispatch" | "first_dispatch_must_be"
  agent: string
  missing: string[]
  detail: string
  recoverable: true
}

// ---------------------------------------------------------------------------
// run_root extraction from the dispatch brief (prompt text)
// ---------------------------------------------------------------------------

const RUN_ROOT_RE = /(?:^|\n)\s*run_root:\s*(\S+)/

/** Extract the `run_root` absolute path from the dispatch prompt, if present. */
export function extractRunRoot(prompt: string): string | undefined {
  const match = RUN_ROOT_RE.exec(prompt)
  return match?.[1]
}

// ---------------------------------------------------------------------------
// Evaluation (Effect-based; needs the session directory + prior children)
// ---------------------------------------------------------------------------

export interface EvaluateInput {
  /** The dispatching (parent) session. */
  parent: Pick<Session.Info, "id" | "directory">
  /** The dispatching parent agent's parsed gates (for `first_dispatch_must_be`). */
  parentGates: Gates | undefined
  /** The child agent name being dispatched. */
  childName: string
  /** The child agent's parsed gates (for `requires_artifacts` / `requires_prior_dispatch`). */
  childGates: Gates | undefined
  /** The dispatch prompt (to extract `run_root`). */
  prompt: string
  /** The parent session's existing child sessions (prior dispatches). */
  priorChildren: Session.Info[]
}

/**
 * Evaluate all gates at dispatch time. Returns a {@link BlockedResult} if any
 * gate fails, or `undefined` if all pass (or no gates are configured).
 *
 * Order: `first_dispatch_must_be` (parent) → `requires_prior_dispatch` (child)
 * → `requires_artifacts` (child). The first failing gate wins.
 */
export function evaluateGates(input: EvaluateInput): Effect.Effect<BlockedResult | undefined> {
  return Effect.gen(function* () {
    const { parent, parentGates, childName, childGates, prompt, priorChildren } = input

    // 1. first_dispatch_must_be — on the PARENT (carrier). Constrains the
    //    parent's FIRST child dispatch: if the parent has no prior children and
    //    the first spawned child is not the named agent, block.
    if (parentGates?.first_dispatch_must_be) {
      const required = parentGates.first_dispatch_must_be
      if (priorChildren.length === 0 && childName !== required) {
        return blocked("first_dispatch_must_be", childName, [required], {
          detail: `first_dispatch_must_be: first child dispatch of parent must be "${required}", got "${childName}"`,
        })
      }
    }

    if (!childGates) return undefined

    // 2. requires_prior_dispatch — on the CHILD. Passes if the dispatching
    //    session has already spawned ≥ min_count children matching the pattern.
    if (childGates.requires_prior_dispatch) {
      for (const entry of childGates.requires_prior_dispatch) {
        const minCount = entry.min_count ?? 1
        const count = priorChildren.filter((c) => Glob.match(entry.agent_pattern, c.agent ?? "")).length
        if (count < minCount) {
          return blocked("requires_prior_dispatch", childName, [entry.agent_pattern], {
            detail: `requires_prior_dispatch: ${count} of ${minCount} prior dispatches match "${entry.agent_pattern}"`,
          })
        }
      }
    }

    // 3. requires_artifacts — on the CHILD. Globs may carry `<run_root>`,
    //    substituted from the dispatch brief's `run_root:` field. F1: the glob
    //    scan is caught — an fs error (EACCES, ENOTDIR, bad base path) returns a
    //    recoverable BLOCKED result instead of crashing the dispatch. The error
    //    contract the harness depends on requires BLOCKED, never a hard throw.
    if (childGates.requires_artifacts) {
      const runRoot = extractRunRoot(prompt)
      for (const entry of childGates.requires_artifacts) {
        const minCount = entry.min_count ?? 1
        const needsRunRoot = entry.glob.includes("<run_root>")
        if (needsRunRoot && !runRoot) {
          return blocked("requires_artifacts", childName, [entry.glob], {
            detail: `requires_artifacts: glob "${entry.glob}" needs <run_root> but no run_root: field was found in the dispatch brief (missing_run_root)`,
          })
        }
        const pattern = entry.glob.replaceAll("<run_root>", runRoot ?? "")
        // F1: catch fs errors (EACCES, ENOTDIR, bad base path) and return a
        // recoverable BLOCKED result instead of crashing the dispatch. The
        // error contract the harness depends on requires BLOCKED, never a throw.
        const scan = yield* Effect.promise(async () => {
          try {
            return { ok: true as const, found: await Glob.scan(pattern, { cwd: parent.directory, absolute: true, dot: true }) }
          } catch (cause) {
            return { ok: false as const, cause }
          }
        })
        if (!scan.ok) return evaluationError(childName, scan.cause)
        if (scan.found.length < minCount) {
          const rootDetail = runRoot ? ` (run_root=${runRoot})` : ""
          return blocked("requires_artifacts", childName, [entry.glob], {
            detail: `requires_artifacts: ${scan.found.length} of ${minCount} matches for ${pattern}${rootDetail}`,
          })
        }
      }
    }

    return undefined
  })
}

function blocked(
  gate: BlockedResult["gate"],
  agent: string,
  missing: string[],
  opts: { detail: string },
): BlockedResult {
  return { status: "BLOCKED", gate, agent, missing, detail: opts.detail, recoverable: true }
}

/** Render a BLOCKED result as the task tool output (parent LLM sees this). */
export function renderBlocked(result: BlockedResult): string {
  return [
    `<task state="blocked">`,
    `<blocked>`,
    JSON.stringify(result, null, 2),
    `</blocked>`,
    `<hint>The dispatch was blocked by a gate. Inspect \`gate\`, \`missing\`, and \`detail\`. The condition is recoverable: produce the missing artifact, dispatch the missing prior stage, or respect the required first dispatch, then retry.</hint>`,
    `</task>`,
  ].join("\n")
}

/**
 * Build a BLOCKED result for an evaluation-time failure (e.g. a glob fs error:
 * EACCES, ENOTDIR, bad base path). The error contract requires a recoverable
 * BLOCKED object, NOT a hard crash — the parent LLM must be able to self-repair
 * (e.g. fix permissions, correct the run_root, retry). `gate` is `requires_artifacts`
 * since that is the only gate that touches the filesystem today; if other
 * gates grow fs dependencies, branch on the cause here.
 */
export function evaluationError(childName: string, cause: unknown): BlockedResult {
  const message = cause instanceof Error ? cause.message : String(cause)
  return {
    status: "BLOCKED",
    gate: "requires_artifacts",
    agent: childName,
    missing: [],
    detail: `requires_artifacts: evaluation failed (${message}). The gate could not be checked — fix the underlying condition (e.g. file permissions, run_root path) and retry.`,
    recoverable: true,
  }
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}