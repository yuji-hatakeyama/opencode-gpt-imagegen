import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { createImagegenTool } from "../../src/imagegen"
import { server } from "../../src/v1"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

const originalFetch = globalThis.fetch
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "v1-"))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  await rm(dir, { recursive: true, force: true })
})

describe("server", () => {
  test("uses ChatGPT OAuth credentials and returns the saved image's output and metadata (#136)", async () => {
    const access = "tok"
    const accountId = "acct"
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access, accountId } })
    const fetchMock = mock(async (_url: string, _init: RequestInit) =>
      Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await server({ directory: path.join(dir, "plugin-location") } as PluginInput)
    const context = { directory: dir } as ToolContext
    const out = "cat.png"

    const result = await hooks.tool?.gpt_imagegen?.execute({ prompt: "a cat", out, size: "1672x941" }, context)

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

  test("forwards the abort signal to fetch and propagates cancellation errors (#136)", async () => {
    const error = new DOMException("Generation cancelled", "AbortError")
    const signal = AbortSignal.abort(error)
    const fetchMock = mock(async (_url: string, _init: RequestInit) => {
      throw error
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await server({} as PluginInput, { baseURL: "https://proxy.example.test/v1" })
    const context = { directory: dir, abort: signal } as ToolContext

    const result = hooks.tool?.gpt_imagegen?.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, context)

    await expect(result).rejects.toBe(error)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal)
  })

  test("registers the shared description and Zod shape (#136)", async () => {
    const imagegen = createImagegenTool(undefined, async () => undefined)

    const hooks = await server({} as PluginInput)

    const tool = hooks.tool?.gpt_imagegen
    expect(tool?.description).toBe(imagegen.description)
    expect(tool?.args).toBe(imagegen.schema.shape)
  })

  test("forwards baseURL to the image tool without sending ChatGPT credentials (#136)", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) =>
      Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await server({} as PluginInput, { baseURL: "http://127.0.0.1:3457/v1" })
    const context = { directory: dir } as ToolContext

    await hooks.tool?.gpt_imagegen?.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, context)

    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:3457/v1/images/generations")
    expect(init.headers).toEqual({ "Content-Type": "application/json", originator: "opencode" })
    expect(hooks.tool?.gpt_imagegen?.description).toContain("the plugin's `baseURL` option")
  })

  test("rejects missing credentials without requesting an image (#136)", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({})
    const fetchMock = mock()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await server({} as PluginInput)
    const context = { directory: dir } as ToolContext

    const act = hooks.tool?.gpt_imagegen?.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, context)

    await expect(act).rejects.toThrow("OpenAI ChatGPT OAuth credentials not configured.")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
