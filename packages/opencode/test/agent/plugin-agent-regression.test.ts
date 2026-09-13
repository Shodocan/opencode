import { expect } from "bun:test"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Exit } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { Agent } from "../../src/agent/agent"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderTest } from "../fake/provider"
import { SkillTest } from "../fake/skill"
import { testEffect } from "../lib/effect"
import { PLUGIN_AGENT } from "../fixture/agent-plugin.constants"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

// `it.instance` skips InstanceBootstrap so LSP / MCP don't spin up — those
// services hang during scope teardown on Windows and aren't needed
// to verify plugin → config hook → Agent.list.
const pluginUrl = pathToFileURL(path.join(import.meta.dir, "..", "fixture", "agent-plugin.ts")).href
const requiredPluginUrl = pathToFileURL(path.join(import.meta.dir, "..", "fixture", "required-config-plugin.ts")).href
const requiredFailureUrl = pathToFileURL(path.join(import.meta.dir, "..", "fixture", "required-config-failure-plugin.ts")).href
const optionalFailureUrl = pathToFileURL(path.join(import.meta.dir, "..", "fixture", "optional-config-failure-plugin.ts")).href
const requiredStartupFailureUrl = pathToFileURL(path.join(import.meta.dir, "..", "fixture", "required-startup-failure-plugin.ts")).href

const provider = ProviderTest.fake()
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Plugin.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [Provider.node, provider.layer],
    [Skill.node, SkillTest.empty],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

it.instance(
  "required config hooks run before Agent captures config defaults",
  () =>
    Effect.gen(function* () {
      yield* Plugin.Service.use((plugin) => plugin.init())
      const agents = yield* Agent.use.list()
      expect(agents.find((agent) => agent.name === "required_config_agent")?.description).toBe(
        "Registered by a required config hook",
      )
    }),
  { config: { plugin: [requiredPluginUrl] } },
)

it.instance(
  "required config hook failure stops plugin initialization",
  () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Plugin.Service.use((plugin) => plugin.init()))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("invalid managed matrix")
    }),
  { config: { plugin: [requiredFailureUrl] } },
)

it.instance(
  "optional config hook failure remains compatible",
  () =>
    Effect.gen(function* () {
      yield* Plugin.Service.use((plugin) => plugin.init())
      expect((yield* Agent.use.list()).length).toBeGreaterThan(0)
    }),
  { config: { plugin: [optionalFailureUrl] } },
)

it.instance(
  "required plugin startup failure stops plugin initialization",
  () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Plugin.Service.use((plugin) => plugin.init()))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("required plugin startup failed")
    }),
  { config: { plugin: [requiredStartupFailureUrl] } },
)

it.instance(
  "plugin-registered agents appear in Agent.list",
  () =>
    Effect.gen(function* () {
      yield* Plugin.Service.use((p) => p.init())
      const agents = yield* Agent.use.list()
      const added = agents.find((agent) => agent.name === PLUGIN_AGENT.name)
      expect(added?.description).toBe(PLUGIN_AGENT.description)
      expect(added?.mode).toBe(PLUGIN_AGENT.mode)
    }),
  { config: { plugin: [pluginUrl] } },
)
