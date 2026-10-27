import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import plugin from "../../src/index"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

// Capture so this file's env edits don't leak into other test files sharing the bun test process.
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "index-"))
})

afterEach(async () => {
  if (ORIGINAL_AUTH_CONTENT === undefined) {
    delete process.env.OPENCODE_AUTH_CONTENT
  } else {
    process.env.OPENCODE_AUTH_CONTENT = ORIGINAL_AUTH_CONTENT
  }
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
})

function imagesResponse(b64Json: string): Response {
  return new Response(JSON.stringify({ created: 0, data: [{ b64_json: b64Json }] }))
}

describe("plugin.server", () => {
  test("uses ChatGPT OAuth credentials and returns the saved image's output and metadata", async () => {
    const access = "tok"
    const accountId = "acct"
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access, accountId } })
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const out = "cat.png"

    const result = await hooks.tool?.gpt_imagegen?.execute({ prompt: "a cat", out, size: "1672x941" }, ctx)

    const savedPath = path.join(dir, out)
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    expect(result).toEqual({
      output: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      metadata: { out: savedPath, versioned: false },
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
      originator: "opencode",
    })
  })

  test("forwards baseURL to the image tool without sending ChatGPT credentials", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok", accountId: "acct" } })
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput, { baseURL: "http://127.0.0.1:3457/v1" })
    const ctx = { directory: dir } as ToolContext

    await hooks.tool?.gpt_imagegen?.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, ctx)

    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:3457/v1/images/generations")
    expect(init.headers).toEqual({ "Content-Type": "application/json", originator: "opencode" })
    expect(hooks.tool?.gpt_imagegen?.description).toContain("the plugin's `baseURL` option")
  })
})
