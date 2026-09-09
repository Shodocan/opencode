import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

for (const pin of [undefined, "", "   ", "1.17.11"]) {
  test(`custom build validates SDK pin before model generation: ${JSON.stringify(pin)}`, async () => {
    await using fixture = await tmpdir()
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_VERSION: "1.18.28-harness.4.3.0-canary",
      OPENCODE_CHANNEL: "canary",
      MODELS_DEV_API_JSON: path.join(fixture.path, "must-not-read-before-sdk-pin-validation.json"),
    }
    delete environment.OPENCODE_RELEASE
    delete environment.OPENCODE_PLUGIN_VERSION
    if (pin !== undefined) environment.OPENCODE_PLUGIN_VERSION = pin
    const child = Bun.spawn([
      process.execPath, "run", "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui",
    ], { cwd: path.join(import.meta.dir, "../.."), env: environment, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(code, stdout + stderr).not.toBe(0)
    if (pin === "1.17.11") {
      expect(stderr).toContain("must-not-read-before-sdk-pin-validation.json")
      return
    }
    expect(stderr, stdout + stderr).toContain("OPENCODE_PLUGIN_VERSION")
    expect(stderr).not.toContain("must-not-read-before-sdk-pin-validation.json")
    expect(stdout).not.toContain("Loaded models.dev snapshot")
  }, 10000)
}
