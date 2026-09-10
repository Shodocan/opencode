// Private integration inputs stay outside the workspace, caches, and artifacts.
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const commit = "d3c2b0b7e9248737692c43aa9b82afaf44ea10f9"
const source = path.resolve(".ci/workflows")
if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error("CI paths are required")
const actual = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
if (actual !== commit) throw new Error("Workflow integration fixture commit mismatch")
const config = execFileSync("git", ["-C", source, "config", "--local", "--list"], { encoding: "utf8" })
if (/^(?:core\.sshcommand|http\..*\.extraheader|credential\..*)=/im.test(config)) {
  throw new Error("Checkout credentials must be removed before dependency installation")
}
// Do not retain private history or a checkout's credential/configuration surface.
fs.rmSync(path.join(source, ".git"), { recursive: true, force: true })
const destination = path.join(process.env.RUNNER_TEMP, `workflows-integration-${commit}`)
if (fs.existsSync(destination)) throw new Error("Workflow integration destination already exists")
fs.renameSync(source, destination)
fs.appendFileSync(process.env.GITHUB_ENV, `WORKFLOWS_REPO_ROOT=${destination}\n`)
console.log(`Prepared exact workflow integration commit ${commit}; credentials removed`)
