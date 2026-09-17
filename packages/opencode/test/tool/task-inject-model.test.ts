import { afterEach, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Session } from "../../src/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { BackgroundJob } from "../../src/background/job"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { AppLayer } from "../../src/effect/app-runtime"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(AppLayer)
const seedModel = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
// The parent session's own recorded selection. The background-result injection
// must pin it explicitly so the wakeup-style prompt cannot re-resolve through
// the agent default (harness-opencode#36).
const recorded = { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("session-model") }
const args = { description: "Inject model fixture", prompt: "Read only", subagent_type: "general", background: true }

function response(sessionID: SessionID): SessionV1.WithParts {
  const messageID = MessageID.ascending()
  return {
    info: { id: messageID, sessionID, role: "user", agent: "general", model: seedModel, time: { created: 3 } },
    parts: [{ id: PartID.ascending(), messageID, sessionID, type: "text", text: "Background review completed." }],
  }
}

it.instance("background result injection pins the parent session's recorded model", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service
    const jobs = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const parent = yield* sessions.create({ title: "inject model parent", model: recorded })
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: parent.id,
      role: "user",
      agent: "build",
      model: seedModel,
      time: { created: 1 },
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: parent.id,
      role: "assistant",
      parentID: user.id,
      agent: "build",
      mode: "build",
      ...seedModel,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      time: { created: 2 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    const injected = yield* Deferred.make<SessionPrompt.InternalPromptInput>()
    const stream = new AbortController()
    const host = Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    })
    const ops: TaskPromptOps = {
      cancel: runState.cancel,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: (input) =>
        input.sessionID === parent.id
          ? Deferred.succeed(injected, input).pipe(Effect.as(response(input.sessionID)))
          : runState.ensureRunning(
              input.sessionID,
              Effect.succeed(response(input.sessionID)),
              Effect.succeed(response(input.sessionID)),
            ),
    }

    const kickoff = yield* Effect.gen(function* () {
      const tool = yield* TaskTool
      const definition = yield* tool.init()
      return yield* definition.execute(args, {
        sessionID: parent.id,
        messageID: assistant.id,
        callID: "inject-model-call",
        agent: "build",
        abort: stream.signal,
        messages: [],
        extra: { promptOps: ops },
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })
    }).pipe(
      Effect.provideService(Plugin.Service, host),
      Effect.provideService(RuntimeFlags.Service, { ...flags, experimentalBackgroundSubagents: true }),
    )

    expect(kickoff.metadata.background).toBe(true)
    const child = kickoff.metadata.sessionId
    const settled = yield* awaitWithTimeout(jobs.wait({ id: child }), "background job never settled")
    expect(settled.info?.status).toBe("completed")
    const input = yield* awaitWithTimeout(
      Deferred.await(injected),
      "completed background task never injected a parent prompt",
    )
    expect(input.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("session-model"),
    })
  }),
)
