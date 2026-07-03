import { describe, expect, it as itBun } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Gates } from "../../src/agent/gates"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { afterEach } from "bun:test"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
)

const it = testEffect(layer)

// Seeds a parent session + assistant message so the task tool has a valid
// dispatching context. Mirrors task.test.ts `seed`, but reads the instance
// directory from TestInstance so requires_artifacts globs resolve there.
const seed = Effect.fn("GatesTest.seed")(function* (title = "Parent") {
  const session = yield* Session.Service
  const test = yield* TestInstance
  const chat = yield* session.create({ title, agent: "build" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: test.directory, root: test.directory },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant, directory: test.directory }
})

function stubOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: () => Effect.sync(() => reply()),
  }
}

function reply(): SessionV1.WithParts {
  const id = MessageID.ascending()
  const sid = SessionID.create()
  return {
    info: {
      id,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sid,
      mode: "general",
      agent: "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: "p" as never, messageID: id, sessionID: sid, type: "text", text: "done" }],
  }
}

function ctx(chat: { id: SessionID }, assistant: { id: MessageID }, agent = "build") {
  return {
    sessionID: chat.id,
    messageID: assistant.id,
    agent,
    abort: new AbortController().signal,
    extra: { promptOps: stubOps() },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("fork feature (10) gates", () => {
  // Acceptance 1: requires_artifacts unmet → BLOCKED with gate + missing glob;
  // after creating the file, identical dispatch succeeds.
  it.instance(
    "requires_artifacts: blocked when absent, passes after the file is created",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const first = yield* def.execute(
          { description: "needs artifact", prompt: "go", subagent_type: "gated" },
          ctx(chat, assistant),
        )
        expect(first.metadata.blocked).toBe(true)
        expect(first.output).toContain("BLOCKED")
        expect(first.output).toContain("requires_artifacts")
        // No child session created on a blocked dispatch.
        const kidsAfterBlocked = yield* sessions.children(chat.id)
        expect(kidsAfterBlocked).toHaveLength(0)

        // Create the artifact (relative glob resolves against the parent
        // session's directory = the test instance tmpdir).
        const test = yield* TestInstance
        yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "gate-consolidation.json"), "{}"))

        const second = yield* def.execute(
          { description: "needs artifact", prompt: "go", subagent_type: "gated" },
          ctx(chat, assistant),
        )
        expect(second.metadata.blocked).toBeUndefined()
        expect(second.output).toContain("completed")
      }),
    {
      config: {
        agent: {
          gated: {
            mode: "subagent",
            gates: { requires_artifacts: [{ glob: "gate-consolidation.json", min_count: 1 }] },
          },
        },
      },
    },
  )

  // Acceptance 2: requires_artifacts with <run_root> and no run_root in brief →
  // BLOCKED with missing_run_root detail.
  it.instance(
    "requires_artifacts: <run_root> glob without run_root in brief → BLOCKED missing_run_root",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          { description: "needs run_root", prompt: "no run_root here", subagent_type: "runroot-gated" },
          ctx(chat, assistant),
        )
        expect(result.metadata.blocked).toBe(true)
        expect(result.output).toContain("BLOCKED")
        expect(result.output).toContain("missing_run_root")
      }),
    {
      config: {
        agent: {
          "runroot-gated": {
            mode: "subagent",
            gates: { requires_artifacts: [{ glob: "<run_root>/gate-consolidation.json", min_count: 1 }] },
          },
        },
      },
    },
  )

  // Acceptance 3: requires_prior_dispatch (pattern review-*, min_count 3) →
  // BLOCKED at 2 prior review-* dispatches, passes at 3.
  it.instance(
    "requires_prior_dispatch: blocked at 2 prior review-* children, passes at 3",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        // 0 prior review-* children → blocked.
        const at0 = yield* def.execute(
          { description: "needs 3 prior", prompt: "go", subagent_type: "needs-reviews" },
          ctx(chat, assistant),
        )
        expect(at0.metadata.blocked).toBe(true)
        expect(at0.output).toContain("requires_prior_dispatch")

        // Seed 2 prior review-* children (agent name set on the child session).
        yield* sessions.create({ parentID: chat.id, agent: "review-scout", title: "r1" })
        yield* sessions.create({ parentID: chat.id, agent: "review-judge", title: "r2" })
        const at2 = yield* def.execute(
          { description: "needs 3 prior", prompt: "go", subagent_type: "needs-reviews" },
          ctx(chat, assistant),
        )
        expect(at2.metadata.blocked).toBe(true)
        expect(at2.output).toContain("requires_prior_dispatch")

        // Seed a 3rd review-* child → passes.
        yield* sessions.create({ parentID: chat.id, agent: "review-refuter", title: "r3" })
        const at3 = yield* def.execute(
          { description: "needs 3 prior", prompt: "go", subagent_type: "needs-reviews" },
          ctx(chat, assistant),
        )
        expect(at3.metadata.blocked).toBeUndefined()
        expect(at3.output).toContain("completed")
      }),
    {
      config: {
        agent: {
          "needs-reviews": {
            mode: "subagent",
            gates: { requires_prior_dispatch: [{ agent_pattern: "review-*", min_count: 3, scope: "session" }] },
          },
        },
      },
    },
  )

  // Acceptance 4: first_dispatch_must_be: task-advisor → first non-advisor child
  // BLOCKED; advisor-first then anything passes.
  it.instance(
    "first_dispatch_must_be: first non-advisor child blocked; advisor-first then anything passes",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        // First dispatch is a non-advisor child → blocked by the parent's gate.
        const first = yield* def.execute(
          { description: "wrong first", prompt: "go", subagent_type: "worker" },
          ctx(chat, assistant, "advisor-parent"),
        )
        expect(first.metadata.blocked).toBe(true)
        expect(first.output).toContain("first_dispatch_must_be")

        // First dispatch is task-advisor → passes.
        const advisor = yield* def.execute(
          { description: "right first", prompt: "go", subagent_type: "task-advisor" },
          ctx(chat, assistant, "advisor-parent"),
        )
        expect(advisor.metadata.blocked).toBeUndefined()
        expect(advisor.output).toContain("completed")

        // Now a non-advisor child passes (the parent already has a child).
        const next = yield* def.execute(
          { description: "after advisor", prompt: "go", subagent_type: "worker" },
          ctx(chat, assistant, "advisor-parent"),
        )
        expect(next.metadata.blocked).toBeUndefined()
        expect(next.output).toContain("completed")
      }),
    {
      config: {
        agent: {
          "advisor-parent": {
            mode: "primary",
            can_spawn_subagents: true,
            gates: { first_dispatch_must_be: "task-advisor" },
          },
          "task-advisor": { mode: "subagent" },
          worker: { mode: "subagent" },
        },
      },
    },
  )

  // Acceptance 5: agent without gates → zero behavior change (regression guard).
  it.instance(
    "agent without gates: dispatch behaves identically (no blocked metadata)",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          { description: "plain", prompt: "go", subagent_type: "plain" },
          ctx(chat, assistant),
        )
        expect(result.metadata.blocked).toBeUndefined()
        expect(result.output).toContain("completed")
      }),
    {
      config: {
        agent: {
          plain: { mode: "subagent" },
        },
      },
    },
  )

  // F1: requires_artifacts glob that throws must return a recoverable BLOCKED
  // result, NOT a hard crash. The error contract the harness depends on
  // requires BLOCKED, never a throw the parent can't self-repair from.
  //
  // The `glob` library swallows most fs errors and returns [] (which surfaces
  // as a "0 of N matches" BLOCKED, not an evaluation error). Genuine throws
  // (malformed patterns, or a future glob impl) are caught inside
  // evaluateGates and surfaced as evaluationError(). We unit-test the catch
  // contract directly: the evaluationError helper produces the exact BLOCKED
  // shape evaluateGates returns on a throw.
  itBun("F1: evaluationError produces a recoverable BLOCKED shape on a glob throw", () => {
    const cause = new Error("EACCES: permission denied")
    const result = Gates.evaluationError("fserror-gated", cause)
    expect(result.status).toBe("BLOCKED")
    expect(result.gate).toBe("requires_artifacts")
    expect(result.agent).toBe("fserror-gated")
    expect(result.missing).toEqual([])
    expect(result.recoverable).toBe(true)
    expect(result.detail).toContain("evaluation failed")
    expect(result.detail).toContain("EACCES")
    expect(result.recoverable_hint).toBeDefined()
    expect(result.recoverable_hint).toContain("artifact")
    // renderBlocked round-trips the structured object into the tool output the
    // parent LLM sees — assert the parent gets a self-repairable, unambiguous error.
    const output = Gates.renderBlocked(result)
    expect(output).toContain("BLOCKED")
    expect(output).toContain("<error")
  })

  // F2: a driver LLM cannot bypass gates by naming an unrelated SessionID as
  // task_id. Only a session whose parent is THIS dispatching session is a
  // legitimate resume; anything else falls through to a fresh dispatch and
  // gates still evaluate.
  it.instance(
    "F2: resume with an unrelated SessionID does not bypass gates",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        // An unrelated session that does NOT belong to the dispatching parent.
        const stranger = yield* sessions.create({ title: "stranger", agent: "unrelated" })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        // Naming the stranger as task_id must NOT skip the gate — the dispatch
        // falls through to a fresh dispatch and the gate blocks it.
        const result = yield* def.execute(
          {
            description: "bypass attempt",
            prompt: "go",
            subagent_type: "gated",
            task_id: stranger.id,
          },
          ctx(chat, assistant),
        )
        expect(result.metadata.blocked).toBe(true)
        expect(result.output).toContain("BLOCKED")
        expect(result.output).toContain("requires_artifacts")
      }),
    {
      config: {
        agent: {
          gated: {
            mode: "subagent",
            gates: { requires_artifacts: [{ glob: "gate-consolidation.json", min_count: 1 }] },
          },
        },
      },
    },
  )

  // Acceptance 6: malformed gates block → startup error naming the agent
  // (fail-fast at config parse, not at dispatch time).
  describe("parseGates fail-fast", () => {
    const agent = "broken-agent"

    itBun("rejects non-object gates", () => {
      expect(() => Gates.parseGates(agent, "not-an-object")).toThrow(agent)
      expect(() => Gates.parseGates(agent, ["array"])).toThrow(agent)
      expect(() => Gates.parseGates(agent, 42)).toThrow(agent)
    })

    itBun("rejects requires_artifacts that is not an array", () => {
      expect(() => Gates.parseGates(agent, { requires_artifacts: "nope" })).toThrow(agent)
    })

    itBun("rejects requires_artifacts entry missing glob", () => {
      expect(() => Gates.parseGates(agent, { requires_artifacts: [{ min_count: 1 }] })).toThrow(agent)
    })

    itBun("rejects requires_prior_dispatch entry missing agent_pattern", () => {
      expect(() => Gates.parseGates(agent, { requires_prior_dispatch: [{ min_count: 1 }] })).toThrow(agent)
    })

    itBun("rejects unknown scope", () => {
      expect(() =>
        Gates.parseGates(agent, { requires_prior_dispatch: [{ agent_pattern: "x", scope: "global" }] }),
      ).toThrow(agent)
    })

    itBun("rejects non-string first_dispatch_must_be", () => {
      expect(() => Gates.parseGates(agent, { first_dispatch_must_be: 7 })).toThrow(agent)
    })

    itBun("accepts a well-formed gates block", () => {
      const parsed = Gates.parseGates(agent, {
        requires_artifacts: [{ glob: "<run_root>/x.json", min_count: 1 }],
        requires_prior_dispatch: [{ agent_pattern: "review-*", min_count: 10, scope: "session" }],
        first_dispatch_must_be: "task-advisor",
        contract_ref: "contracts/adversarial-review-output.md",
      })
      expect(parsed).toBeDefined()
      expect(parsed!.requires_artifacts).toHaveLength(1)
      expect(parsed!.requires_prior_dispatch).toHaveLength(1)
      expect(parsed!.first_dispatch_must_be).toBe("task-advisor")
      expect(parsed!.contract_ref).toBe("contracts/adversarial-review-output.md")
    })

    itBun("returns undefined for absent gates", () => {
      expect(Gates.parseGates(agent, undefined)).toBeUndefined()
      expect(Gates.parseGates(agent, null)).toBeUndefined()
    })

    // The BLOCKED output is the ONLY signal the caller gets. It must be an
    // unambiguous error (not soft XML), name the gate, reference the contract,
    // and give a prescriptive recovery instruction — so the caller LLM knows
    // exactly what failed and what to do.
    itBun("renderBlocked produces an <error> with gate, contract_ref, and prescriptive hint", () => {
      const result = Gates.evaluationError("review-judge", new Error("EACCES: permission denied"), "contracts/adversarial-review-output.md")
      const output = Gates.renderBlocked(result)
      // Must be an error, not a soft "task state=blocked"
      expect(output).toContain("<error")
      expect(output).not.toContain("<task state=")
      // Must name the gate + agent + contract
      expect(output).toContain("requires_artifacts")
      expect(output).toContain("review-judge")
      expect(output).toContain("contracts/adversarial-review-output.md")
      // Must have a prescriptive "What to do" section
      expect(output).toContain("What to do")
      expect(output).toContain("recoverable")
      // Must round-trip the structured JSON so the caller can parse it
      expect(output).toContain("BLOCKED")
      expect(output).toContain("recoverable_hint")
    })
  })
})