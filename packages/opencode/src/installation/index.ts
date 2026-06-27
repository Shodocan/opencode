import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

// FORK FEATURE (7) MinIO auto-update — see FORK_CHANGES.md.
// The personal opencode-custom MinIO distribution installs the binary at
// `<PREFIX>/lib/opencode-custom/opencode` (PREFIX defaults to
// ~/.opencode-custom-hindsight; wrapper `och` in <PREFIX>/bin). Upstream's
// `method()` does not recognize that path, so it returns "unknown" and
// `upgrade()` bails — the build never auto-updates. These helpers detect the
// custom install, fetch a version manifest from MinIO, and swap the binary
// in place (leaving the wrapper + user PREFIX customizations untouched).
//
// Manifest: https://s3.casonatto.dev/shared/opencode-custom/manifest.json
//   { version: "1.17.11-RC2", url: "<tarball url>", sha256: "<hex>" }
// Version scheme: clean release = X.Y.Z; bug-fix republishes on the same
// release = X.Y.Z-RC1, -RC2, … (RC resets to RC1 each upstream release). The
// auto-update gate is string-equality + major/minor compare (see cli/upgrade.ts),
// so X.Y.Z → X.Y.Z-RCn correctly triggers a patch upgrade.
const CUSTOM_INSTALL_MARKER = "opencode-custom-hindsight/lib/opencode-custom"
const CUSTOM_MANIFEST_URL = "https://s3.casonatto.dev/shared/opencode-custom/manifest.json"

// True when the running binary lives under the custom-MinIO install prefix.
export const isCustomMinioInstall = (execPath: string = process.execPath): boolean =>
  execPath.includes(CUSTOM_INSTALL_MARKER)

// Derive the LIB_DIR containing the binary from execPath:
// <PREFIX>/lib/opencode-custom/opencode → <PREFIX>/lib/opencode-custom
export const customLibDir = (execPath: string = process.execPath): string => {
  const idx = execPath.indexOf(CUSTOM_INSTALL_MARKER)
  return idx >= 0 ? execPath.slice(0, idx + CUSTOM_INSTALL_MARKER.length) : ""
}

const CustomMinioManifest = Schema.Struct({
  version: Schema.String,
  url: Schema.String,
  sha256: Schema.String,
})

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `opencode/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const getBrewFormula = Effect.fnUntraced(function* () {
      const tapFormula = yield* text(["brew", "list", "--formula", "anomalyco/tap/opencode"])
      if (tapFormula.includes("opencode")) return "anomalyco/tap/opencode"
      const coreFormula = yield* text(["brew", "list", "--formula", "opencode"])
      if (coreFormula.includes("opencode")) return "opencode"
      return "opencode"
    })

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        const response = yield* httpOk.execute(HttpClientRequest.get("https://opencode.ai/install"))
        const body = yield* response.text
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
    )

    // FORK FEATURE (7) — in-place binary swap for the custom-MinIO install.
    // Only replaces <LIB_DIR>/opencode (the one file that changes between
    // versions); leaves the wrapper + user PREFIX customizations untouched.
    // `target` is ignored — the manifest is the source of truth for url+sha.
    const upgradeCustomMinio = Effect.fnUntraced(
      function* (_target: string) {
        const libDir = customLibDir()
        if (!libDir) return yield* new UpgradeFailedError({ stderr: "could not derive LIB_DIR from execPath" })
        // Fetch the manifest (url + sha256 for the tarball).
        const response = yield* httpOk.execute(HttpClientRequest.get(CUSTOM_MANIFEST_URL).pipe(HttpClientRequest.acceptJson))
        const manifest = yield* HttpClientResponse.schemaBodyJson(CustomMinioManifest)(response)
        const tmpDir = (yield* text(["mktemp", "-d"])).trim()
        try {
          const tarball = `${tmpDir}/opencode-custom.tar.gz`
          const dl = yield* run(["curl", "--fail", "--location", "--silent", "--show-error", "-o", tarball, manifest.url])
          if (dl.code !== 0) return yield* new UpgradeFailedError({ stderr: `download failed: ${dl.stderr || dl.stdout}` })
          // Verify sha256.
          const actual = (yield* text(["sha256sum", tarball])).split(/\s+/)[0]
          if (actual !== manifest.sha256) {
            return yield* new UpgradeFailedError({
              stderr: `sha256 mismatch: expected ${manifest.sha256}, got ${actual}`,
            })
          }
          // Extract + locate the opencode binary, then swap it in place.
          const extractDir = `${tmpDir}/extract`
          yield* run(["mkdir", "-p", extractDir])
          const ex = yield* run(["tar", "-xzf", tarball, "-C", extractDir])
          if (ex.code !== 0) return yield* new UpgradeFailedError({ stderr: `extract failed: ${ex.stderr || ex.stdout}` })
          // Find the opencode binary (matches install.sh's logic).
          const found = (
            yield* text([
              "sh",
              "-c",
              `find "${extractDir}" -maxdepth 3 -type f -name opencode -perm -u+x 2>/dev/null | head -n1`,
            ])
          ).trim()
          const srcBin = found || (yield* text(["sh", "-c", `find "${extractDir}" -maxdepth 3 -type f -name opencode | head -n1`])).trim()
          if (!srcBin) return yield* new UpgradeFailedError({ stderr: "could not locate opencode binary in tarball" })
          const inst = yield* run(["install", "-m", "0755", srcBin, `${libDir}/opencode`])
          if (inst.code !== 0) return yield* new UpgradeFailedError({ stderr: `install failed: ${inst.stderr || inst.stdout}` })
          return { code: 0, stdout: `swapped ${srcBin} -> ${libDir}/opencode`, stderr: "" }
        } finally {
          yield* run(["rm", "-rf", tmpDir])
        }
      },
      Effect.mapError((err) =>
        err instanceof UpgradeFailedError ? err : new UpgradeFailedError({ stderr: upgradeFailure("curl") }),
      ),
    )

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        // FORK FEATURE (7) — recognize the custom-MinIO install as a curl-style
        // upgradeable method so `upgrade()` does not bail on "unknown".
        if (isCustomMinioInstall()) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula", "opencode"]) },
          { name: "scoop", command: () => text(["scoop", "list", "opencode"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "opencode"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          const installedName =
            check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "opencode" : "opencode-ai"
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* result.method())

        // FORK FEATURE (7) — for the custom-MinIO install, the latest version
        // lives in manifest.json (one source of truth shared with upgrade()).
        if (detectedMethod === "curl" && isCustomMinioInstall()) {
          const response = yield* httpOk.execute(HttpClientRequest.get(CUSTOM_MANIFEST_URL).pipe(HttpClientRequest.acceptJson))
          const data = yield* HttpClientResponse.schemaBodyJson(CustomMinioManifest)(response)
          return data.version
        }

        if (detectedMethod === "brew") {
          const formula = yield* getBrewFormula()
          if (formula.includes("/")) {
            const infoJson = yield* text(["brew", "info", "--json=v2", formula])
            const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
            return info.formulae[0].versions.stable
          }
          const response = yield* httpOk.execute(
            HttpClientRequest.get("https://formulae.brew.sh/api/formula/opencode.json").pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
          return data.versions.stable
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              `${yield* NpmConfig.registry(process.cwd())}/opencode-ai/${InstallationChannel}`,
            ).pipe(HttpClientRequest.acceptJson),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        if (detectedMethod === "choco") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response)
          return data.d.results[0].Version
        }

        if (detectedMethod === "scoop") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response)
          return data.version
        }

        const response = yield* httpOk.execute(
          HttpClientRequest.get("https://api.github.com/repos/anomalyco/opencode/releases/latest").pipe(
            HttpClientRequest.acceptJson,
          ),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            // FORK FEATURE (7) — route the custom-MinIO install to the in-place
            // binary-swap path; upstream curl installs keep using opencode.ai.
            if (isCustomMinioInstall()) {
              upgradeResult = yield* upgradeCustomMinio(target)
              break
            }
            upgradeResult = yield* upgradeCurl(target)
            break
          case "npm":
            upgradeResult = yield* run(["npm", "install", "-g", `opencode-ai@${target}`])
            break
          case "pnpm":
            upgradeResult = yield* run(["pnpm", "install", "-g", `opencode-ai@${target}`])
            break
          case "bun":
            upgradeResult = yield* run(["bun", "install", "-g", `opencode-ai@${target}`])
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            if (formula.includes("/")) {
              const tap = yield* run(["brew", "tap", "anomalyco/tap"], { env })
              if (tap.code !== 0) {
                upgradeResult = tap
                break
              }
              const repo = yield* text(["brew", "--repo", "anomalyco/tap"])
              const dir = repo.trim()
              if (dir) {
                const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
                if (pull.code !== 0) {
                  upgradeResult = pull
                  break
                }
              }
            }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          case "choco":
            upgradeResult = yield* run(["choco", "upgrade", "opencode", `--version=${target}`, "-y"])
            break
          case "scoop":
            upgradeResult = yield* run(["scoop", "install", `opencode@${target}`])
            break
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppProcess.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

export * as Installation from "."
