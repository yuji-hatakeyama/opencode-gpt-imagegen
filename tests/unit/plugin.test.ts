import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../../src/index"
import { TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA } from "../../src/tool-spec"
import type { PluginContext, ToolRegistration } from "../../src/v2"
import { PNG_BASE64 } from "./fixtures"

function dataEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const imageDoneEvent = (result: string) =>
  dataEvent({ type: "response.output_item.done", item: { type: "image_generation_call", result } })

async function registerV2Tool(directory: string): Promise<ToolRegistration> {
  const registered: ToolRegistration[] = []
  const ctx: PluginContext = {
    location: { directory },
    tool: {
      transform: async (register) => {
        register({ add: (tool) => registered.push(tool) })
      },
    },
  }
  await plugin.setup(ctx)
  expect(registered).toHaveLength(1)
  return registered[0]
}

describe("plugin entrypoints", () => {
  test("default export carries both the v1 server and the v2 setup entrypoints", () => {
    expect(plugin.id).toBe("opencode-gpt-imagegen")
    expect(typeof plugin.server).toBe("function")
    expect(typeof plugin.setup).toBe("function")
  })

  test("v1 server exposes gpt_imagegen with the shared tool description", async () => {
    const hooks = await plugin.server({} as never)
    expect(hooks.tool?.gpt_imagegen.description).toBe(TOOL_DESCRIPTION)
  })

  test("v2 setup registers gpt_imagegen with the shared JSON schema", async () => {
    const registration = await registerV2Tool(os.tmpdir())
    expect(registration.name).toBe("gpt_imagegen")
    expect(registration.description).toBe(TOOL_DESCRIPTION)
    expect(registration.input).toEqual(TOOL_INPUT_SCHEMA)
  })
})

describe("gpt_imagegen v2 execute", () => {
  const originalFetch = globalThis.fetch
  const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalAuthContent === undefined) {
      delete process.env.OPENCODE_AUTH_CONTENT
    } else {
      process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
    }
  })

  function stubFetch(): ReturnType<typeof mock> {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response(imageDoneEvent(PNG_BASE64)))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  test("writes the PNG under the v2 location directory and reports it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-imagegen-"))
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok" } })
    stubFetch()

    const tool = await registerV2Tool(dir)
    const result = await tool.execute({ prompt: "a cat", out: "nested/cat.png", quality: "low" }, {})

    expect(result.content).toContain("Generated image saved to")
    expect(result.metadata).toEqual({
      out: path.join(dir, "nested/cat.png"),
      versioned: false,
      billing: "subscription",
    })
    const saved = await readFile(path.join(dir, "nested/cat.png"))
    expect(saved.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true)
  })

  test("forwards the abort signal to the Codex request", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-imagegen-signal-"))
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok" } })
    const fetchMock = stubFetch()
    const controller = new AbortController()

    const tool = await registerV2Tool(dir)
    await tool.execute({ prompt: "a cat", out: "cat.png", quality: "low" }, { signal: controller.signal })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBe(controller.signal)
  })

  test("fails when ChatGPT credentials are not configured", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-imagegen-noauth-"))
    // Invalid inline auth means neither the env override nor the auth.json fallback applies.
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    stubFetch()

    const tool = await registerV2Tool(dir)
    expect(tool.execute({ prompt: "a cat", out: "cat.png", quality: "low" }, {})).rejects.toThrow(
      "OpenAI ChatGPT OAuth credentials not configured.",
    )
  })
})
