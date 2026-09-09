import { expect, test } from "bun:test"
import path from "path"

for (const declaration of ["absent", "1.17.10", "^1.17.10"]) {
  test(`compiled custom runtime preserves the published SDK dependency: ${declaration}`, async () => {
    const child = Bun.spawn([
      process.execPath,
      "test",
      "--define", "OPENCODE_VERSION:" + JSON.stringify("1.18.28-harness.4.3.0-canary"),
      "--define", "OPENCODE_CHANNEL:" + JSON.stringify("canary"),
      "--define", "OPENCODE_PLUGIN_VERSION:" + JSON.stringify("1.17.11"),
      "--timeout", "15000", "./test/config/fixtures/workflow-plugin-sdk-pin.fixture.ts",
    ], {
      cwd: path.join(import.meta.dir, "../.."),
      env: { ...process.env, WORKFLOW_SDK_FIXTURE_DECLARATION: declaration },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(code, stdout + stderr).toBe(0)
  }, 20000)
}
