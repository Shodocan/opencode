import { expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Npm } from "@opencode-ai/core/npm"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Config } from "../../../src/config/config"
import { Env } from "../../../src/env"
import { Auth } from "../../../src/auth"
import { Account } from "../../../src/account/account"
import { AuthTest } from "../../fake/auth"
import { AccountTest } from "../../fake/account"
import { TestInstance, disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const requests: { directory: string; add: { name: string; version?: string }[] }[] = []
const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, Layer.mock(Npm.Service)({ install: (directory, input) => Effect.sync(() => {
    requests.push({ directory, add: input?.add ?? [] })
  }) })],
  [httpClient, Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) =>
    Effect.die(`Unexpected HTTP during SDK dependency selection: ${request.method} ${request.url}`)))],
])
const it = testEffect(layer)
it.instance("Config selects the compiled SDK pin and respects existing dependency declarations", () => Effect.gen(function* () {
  expect(InstallationVersion).toBe("1.18.28-harness.4.3.0-canary")
  const fixture = yield* TestInstance
  const directory = path.join(fixture.directory, ".opencode")
  const declaration = process.env.WORKFLOW_SDK_FIXTURE_DECLARATION!
  const manifest = { dependencies: declaration === "absent" ? {} : { "@opencode-ai/plugin": declaration } }
  yield* FSUtil.use.writeWithDirs(path.join(directory, "package.json"), JSON.stringify(manifest))
  const config = yield* Config.Service
  yield* config.get()
  yield* config.waitForDependencies()
  const request = requests.find((value) => value.directory === directory)
  expect(request, "Config must install this real project configuration directory").toBeDefined()
  const sdk = request!.add.find((value) => value.name === "@opencode-ai/plugin")
  if (declaration === "absent") expect(sdk).toEqual({ name: "@opencode-ai/plugin", version: "1.17.11" })
  if (declaration !== "absent") {
    expect(sdk === undefined || sdk.version === declaration, "An explicit dependency must not be replaced by either runtime version or default SDK pin").toBe(true)
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, "package.json")).json())).toEqual(manifest)
  }
}).pipe(Effect.ensuring(Effect.promise(disposeAllInstances))))
