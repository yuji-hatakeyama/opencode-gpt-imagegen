import { afterAll, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { PNG_BASE64, PNG_BUFFER } from "../unit/fixtures"

const exec = promisify(execFile)
const REPO_DIR = path.resolve(import.meta.dir, "../..")
const ROOT = await mkdtemp(path.join(os.tmpdir(), "qa-imagegen-package-"))
const WORKDIR = path.join(ROOT, "project")
const TIMEOUT_MS = 120_000

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

test(
  "the production package loads in Node ESM and executes both plugin contracts with a mocked backend",
  async () => {
    await exec("bun", ["run", "build"], { cwd: REPO_DIR })
    await exec("bun", ["pm", "pack", "--filename", path.join(ROOT, "imagegen.tgz"), "--ignore-scripts"], {
      cwd: REPO_DIR,
    })
    await mkdir(WORKDIR)
    await writeFile(
      path.join(WORKDIR, "package.json"),
      JSON.stringify({ private: true, dependencies: { "opencode-gpt-imagegen": "file:../imagegen.tgz" } }),
    )
    // Keep the repository's dependency age policy in the clean production install.
    await copyFile(path.join(REPO_DIR, "bunfig.toml"), path.join(WORKDIR, "bunfig.toml"))
    await exec("bun", ["install", "--production"], { cwd: WORKDIR, timeout: TIMEOUT_MS })

    await writeFile(path.join(WORKDIR, "reference.png"), PNG_BUFFER)
    const probePath = path.join(WORKDIR, "probe.mjs")
    await writeFile(
      probePath,
      `import assert from "node:assert/strict"
import plugin from "opencode-gpt-imagegen"

const directory = process.cwd()
const signal = new AbortController().signal
const args = { prompt: "a cat", out: "cat.png", quality: "medium", images: ["reference.png"] }
const credential = {
  type: "oauth", methodID: "chatgpt-browser", access: "package-test-token",
  refresh: "unused-refresh", expires: Date.now() + 60000, metadata: { accountID: "package-test-account" }
}
let tool
await plugin.setup({
  tool: {
    async transform(callback) {
      assert.equal(callback({ add(value) { tool = value } }), undefined)
      return { dispose() {} }
    }
  },
  integration: { connection: {
    async active(id) {
      assert.equal(id, "openai")
      return { type: "credential", id: "cred-package", label: "Codex", method: "oauth" }
    },
    async resolve() { return credential }
  } },
  session: { async get(input) {
    assert.equal(input.sessionID, "ses-package")
    return { location: { directory } }
  } }
})
assert.equal(plugin.id, "opencode-gpt-imagegen")
assert.equal(tool.name, "gpt_imagegen")

// Every backend request is intercepted; no real credential or generation is used.
globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://chatgpt.com/backend-api/codex/responses")
  assert.equal(init.signal, signal)
  assert.equal(init.headers.Authorization, "Bearer package-test-token")
  assert.equal(init.headers["ChatGPT-Account-Id"], "package-test-account")
  const body = JSON.parse(init.body)
  assert.equal(body.input[0].content[1].image_url, ${JSON.stringify(`data:image/png;base64,${PNG_BASE64}`)})
  const event = {
    type: "response.output_item.done",
    item: { type: "image_generation_call", result: ${JSON.stringify(PNG_BASE64)} }
  }
  return new Response("data: " + JSON.stringify(event) + "\\n\\n")
}

const context = { sessionID: "ses-package", signal }
const v2 = await tool.execute(args, context)
const versioned = await tool.execute(args, context)
process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: {
  type: "oauth", access: "package-test-token", accountId: "package-test-account"
} })
const hooks = await plugin.server({})
const v1 = await hooks.tool.gpt_imagegen.execute({ ...args, out: "legacy.png" }, { directory, abort: signal })
console.log(JSON.stringify({ id: plugin.id, input: tool.input, v2, versioned, v1 }))
`,
    )
    const { stdout } = await exec("node", [probePath], { cwd: WORKDIR, timeout: 30_000 })
    const result = JSON.parse(stdout)
    const resolvedDirectory = await realpath(WORKDIR)
    expect(result).toMatchObject({
      id: "opencode-gpt-imagegen",
      input: { type: "object", required: ["prompt", "out", "quality"], additionalProperties: false },
      v2: {
        content: `Generated image saved to ${path.join(resolvedDirectory, "cat.png")}.`,
        metadata: { out: path.join(resolvedDirectory, "cat.png"), versioned: false, billing: "subscription" },
      },
      versioned: { metadata: { out: path.join(resolvedDirectory, "cat-v2.png"), versioned: true } },
      v1: { output: `Generated image saved to ${path.join(resolvedDirectory, "legacy.png")}.` },
    })
    for (const filename of ["cat.png", "cat-v2.png", "legacy.png"]) {
      expect(await readFile(path.join(WORKDIR, filename))).toEqual(PNG_BUFFER)
    }
  },
  TIMEOUT_MS,
)
