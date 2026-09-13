import { expect } from "bun:test"
import { APICallError } from "ai"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { LLM } from "@/session/llm"
import { MessageID, PartID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const storage = LayerNode.group([
  Session.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(AppNodeBuilder.build(storage))

for (const boundary of ["resume-resolution", "autocontinue", "autocontinue-defect", "after-checkpoint"] as const) {
  it.instance(`fallback finalization handles ${boundary} without losing accepted or concurrent state`, () =>
    Effect.gen(function* () {
      const resolvingResume = yield* Deferred.make<void>()
      const releaseObserver = yield* Deferred.make<void>()
      const primary = ProviderTest.model({ limit: { context: 100_000, output: 4096 } })
      const fallback = ProviderTest.model({
        id: ModelV2.ID.make("large-summary"),
        limit: { context: 1_000_000, output: 4096 },
      })
      let fallbackStarted = false
      const provider = ProviderTest.fake({
        model: primary,
        getModel: (_providerID, modelID) => {
          if (modelID === fallback.id) return Effect.succeed(fallback)
          if (fallbackStarted && boundary === "resume-resolution")
            return Deferred.succeed(resolvingResume, undefined).pipe(Effect.andThen(Effect.never))
          return Effect.succeed(primary)
        },
      })
      const llm = Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          stream: (input) => {
            if (input.model.id === primary.id)
              return Stream.fail(
                new APICallError({
                  message: "request entity too large",
                  statusCode: 413,
                  isRetryable: false,
                  url: "http://fixture.invalid",
                  requestBodyValues: {},
                }),
              )
            fallbackStarted = true
            const usage = new Usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
            return Stream.make(
              LLMEvent.textStart({ id: "summary" }),
              LLMEvent.textDelta({ id: "summary", text: "A complete fallback summary." }),
              LLMEvent.textEnd({ id: "summary" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
              LLMEvent.finish({ reason: "stop", usage }),
            )
          },
        }),
      )
      const environment = AppNodeBuilder.build(LayerNode.group([storage, SessionCompaction.node]), [
        [Provider.node, provider.layer],
        [LLM.node, llm],
        [
          Config.node,
          TestConfig.layer({
            get: () =>
              Effect.succeed({
                compaction: {
                  fallback_model: "openai/large-summary",
                  tail_turns: boundary === "resume-resolution" ? 0 : 1,
                  preserve_recent_tokens: 1000,
                },
              }),
          }),
        ],
        [
          Plugin.node,
          Layer.mock(Plugin.Service)({
            trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
              if (name !== "experimental.compaction.autocontinue" || !boundary.startsWith("autocontinue"))
                return Effect.succeed(output)
              return Deferred.succeed(resolvingResume, undefined).pipe(
                Effect.andThen(
                  boundary === "autocontinue-defect" ? Effect.die("fixture autocontinue defect") : Effect.never,
                ),
              )
            },
            list: () => Effect.succeed([]),
            init: () => Effect.void,
          }),
        ],
        [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
        [
          SessionSummary.node,
          Layer.succeed(
            SessionSummary.Service,
            SessionSummary.Service.of({
              summarize: () => Effect.void,
              diff: () => Effect.succeed([]),
              computeDiff: () => Effect.succeed([]),
            }),
          ),
        ],
      ])
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const compaction = yield* SessionCompaction.Service
        const session = yield* sessions.create({ title: "post-stream cancellation" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          agent: "build",
          model: { providerID: primary.providerID, modelID: primary.id },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: user.id,
          type: "text",
          text: "The original task and its constraints must survive cancellation.".repeat(100),
        })
        const recent = yield* sessions.updateMessage({
          ...user,
          id: MessageID.ascending(),
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: recent.id,
          type: "text",
          text: "Keep this recent instruction verbatim.",
        })
        yield* compaction.create({
          sessionID: session.id,
          agent: "build",
          model: user.model,
          auto: boundary.startsWith("autocontinue"),
        })
        const before = yield* sessions.messages({ sessionID: session.id })
        const parent = before.at(-1)!
        const events = yield* EventV2Bridge.Service
        const unsubscribe = yield* events.listen((event) => {
          if (boundary !== "after-checkpoint" || event.type !== "session.next.compaction.finalized") return Effect.void
          return Deferred.succeed(resolvingResume, undefined).pipe(Effect.andThen(Deferred.await(releaseObserver)))
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        const running = yield* compaction
          .process({
            sessionID: session.id,
            parentID: parent.info.id,
            messages: before,
            auto: boundary.startsWith("autocontinue"),
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(resolvingResume).pipe(Effect.timeout("5 seconds"))
        const concurrent = yield* sessions.updateMessage({
          ...user,
          id: MessageID.ascending(),
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: concurrent.id,
          type: "text",
          text: "A concurrent new user instruction must remain admitted.",
        })
        const admitted = (yield* sessions.messages({ sessionID: session.id })).find(
          (message) => message.info.id === concurrent.id,
        )!
        let interruptedBeforeObserverRelease = true
        if (boundary === "after-checkpoint") {
          const stopping = yield* Fiber.interrupt(running).pipe(Effect.forkChild)
          const stopped = yield* Fiber.join(stopping).pipe(Effect.timeout("1 second"), Effect.exit)
          interruptedBeforeObserverRelease = Exit.isSuccess(stopped)
          yield* Deferred.succeed(releaseObserver, undefined)
        }
        yield* Fiber.interrupt(running)
        const after = yield* sessions.messages({ sessionID: session.id })
        if (boundary === "after-checkpoint") {
          expect(interruptedBeforeObserverRelease).toBe(true)
          expect(after.find((message) => message.info.id === concurrent.id)).toEqual(admitted)
          expect(
            after.filter((message) => message.info.role === "assistant" && message.info.summary && !message.info.error),
          ).toHaveLength(1)
        } else expect(after).toEqual([...before, admitted])
        const { db } = yield* Database.Service
        const records = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .all()
          .pipe(Effect.orDie)
        expect(records.filter((event) => event.type === "session.next.compaction.finalized.1")).toHaveLength(
          boundary === "after-checkpoint" ? 1 : 0,
        )
      }).pipe(Effect.provide(environment))
    }),
  )
}
