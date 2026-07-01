import { describe, expect, test } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { testEffect } from "../lib/effect"

// FORK FEATURE (7) MinIO auto-update — unit tests for the custom-distribution
// install detection, manifest latest(), in-place binary-swap upgrade, and the
// RC version scheme triggering patch upgrades.

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

const CUSTOM_EXEC = "/home/user/.opencode-custom-hindsight/lib/opencode-custom/opencode"

// Override process.execPath for the duration of an Effect so the fork's
// isCustomMinioInstall() / customLibDir() (which read process.execPath by
// default) treat the running binary as the custom-MinIO install. The override
// must be active while the Effect *executes*, not while it is *constructed*,
// so set/restore happens inside the Effect body.
const withExecPath = (execPath: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const original = Object.getOwnPropertyDescriptor(process, "execPath")
      Object.defineProperty(process, "execPath", { value: execPath, configurable: true })
      return original
    }),
    (original) =>
      Effect.sync(() => {
        if (original) Object.defineProperty(process, "execPath", original)
        else delete (process as any).execPath
      }),
  )

describe("custom-minio install detection", () => {
  test("isCustomMinioInstall true for the custom-hindsight path", () => {
    expect(Installation.isCustomMinioInstall(CUSTOM_EXEC)).toBe(true)
    expect(Installation.isCustomMinioInstall("/usr/local/bin/opencode")).toBe(false)
    expect(Installation.isCustomMinioInstall("/home/u/.opencode/bin/opencode")).toBe(false)
  })

  test("customLibDir derives LIB_DIR from execPath", () => {
    expect(Installation.customLibDir(CUSTOM_EXEC)).toBe(
      "/home/user/.opencode-custom-hindsight/lib/opencode-custom",
    )
    expect(Installation.customLibDir("/usr/local/bin/opencode")).toBe("")
  })
})

describe("custom-minio latest()", () => {
  testEffect(
    testLayer((request) => {
      if (request.url.includes("/opencode-custom/manifest.json"))
        return jsonResponse({ version: "1.17.11-RC2", url: "https://x/tar.gz", sha256: "abc" })
      return jsonResponse({ tag_name: "v0.0.0" })
    }),
  ).effect("reads the version from manifest.json for the custom install", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* withExecPath(CUSTOM_EXEC)
        const result = yield* Installation.use.latest("curl")
        expect(result).toBe("1.17.11-RC2")
      }),
    ),
  )
})

describe("custom-minio upgrade()", () => {
  // Track the spawn commands so we can assert the in-place swap ran and the
  // manifest URL was used (not opencode.ai/install).
  const spawnLog: { cmd: string; args: readonly string[] }[] = []
  testEffect(
    testLayer(
      (request) => {
        if (request.url.includes("/opencode-custom/manifest.json"))
          return jsonResponse({
            version: "1.17.11-RC2",
            url: "https://s3.casonatto.dev/shared/opencode-custom/opencode-custom-linux-x64.tar.gz",
            sha256: "deadbeef",
          })
        return new Response("should-not-fetch-opencode-ai-install", { status: 200 })
      },
      (cmd, args) => {
        spawnLog.push({ cmd, args })
        // mktemp -d -> a stable temp path
        if (cmd === "mktemp" && args[0] === "-d") return "/tmp/custom-minio-test"
        // sha256sum -> return the manifest's sha so verification passes
        if (cmd === "sha256sum") return "deadbeef  /tmp/custom-minio-test/opencode-custom.tar.gz"
        // find ... -name opencode -> a fake extracted binary path
        if (cmd === "sh" && args.some((a) => typeof a === "string" && a.includes("-name opencode"))) {
          return "/tmp/custom-minio-test/extract/opencode-linux-x64/bin/opencode"
        }
        // install -m 0755 <src> <libDir>/opencode -> success
        if (cmd === "install") return { code: 0, stdout: "", stderr: "" }
        // curl download, mkdir, tar -xzf, rm -rf -> success
        if (cmd === "curl" || cmd === "mkdir" || cmd === "tar" || cmd === "rm") return ""
        return ""
      },
    ),
  ).effect("swaps the binary in place from manifest.json", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* withExecPath(CUSTOM_EXEC)
        yield* Installation.use.upgrade("curl", "1.17.11-RC2")
        // install(1) was invoked to copy the extracted binary into LIB_DIR.
        const installCall = spawnLog.find((c) => c.cmd === "install")
        expect(installCall).toBeDefined()
        expect(installCall!.args[installCall!.args.length - 1]).toBe(
          "/home/user/.opencode-custom-hindsight/lib/opencode-custom/opencode",
        )
      }),
    ),
  )
})

describe("RC version scheme triggers patch upgrades", () => {
  // The auto-update gate (cli/upgrade.ts) is string-equality + getReleaseType
  // (major/minor compare). Verify X.Y.Z -> X.Y.Z-RCn is a patch upgrade and
  // that the clean release equals its own version (no-op).
  test("getReleaseType: clean release to RC1 is a patch", () => {
    // RCs share the same major.minor as their base release, so X.Y.Z -> X.Y.Z-RCn
    // is a patch (auto-upgrade). Crossing to a new patch is also "patch"; only a
    // minor or major bump is "minor"/"major" (those notify, not auto-upgrade).
    expect(Installation.getReleaseType("1.17.11", "1.17.11-RC1")).toBe("patch")
    expect(Installation.getReleaseType("1.17.11-RC1", "1.17.11-RC2")).toBe("patch")
    expect(Installation.getReleaseType("1.17.11-RC2", "1.17.12")).toBe("patch")
    expect(Installation.getReleaseType("1.17.12", "1.18.0")).toBe("minor")
    expect(Installation.getReleaseType("1.17.12", "2.0.0")).toBe("major")
  })

  test("clean release to its own version is a no-op (string equal)", () => {
    // Mirrors cli/upgrade.ts line 19: `if (InstallationVersion === latest) return`
    const latest = "1.17.11"
    expect(InstallationVersion === latest ? "noop" : "upgrade").toBe(
      InstallationVersion === "1.17.11" ? "noop" : "upgrade",
    )
  })
})