import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Credential, Plugin } from "@opencode/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import type { ToolContext as LegacyToolContext, PluginInput } from "@opencode-ai/plugin"
import plugin from "../../src/index"
import type { GenerateArgs } from "../../src/types"
import { PNG_BASE64, PNG_BUFFER, pngDataUrl } from "./fixtures"

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
const ARGS: GenerateArgs = { prompt: "a cat", out: "nested/cat.png", quality: "medium" }
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "imagegen-plugin-"))
})

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH
  if (ORIGINAL_AUTH_CONTENT === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = ORIGINAL_AUTH_CONTENT
  await rm(directory, { recursive: true, force: true })
})

function mockBackend() {
  const fetchMock = mock(async (_url: string, _init: RequestInit) => {
    const event = {
      type: "response.output_item.done",
      item: { type: "image_generation_call", result: PNG_BASE64 },
    }
    return new Response(`data: ${JSON.stringify(event)}\n\n`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

async function setupPlugin() {
  const tools = new Map<string, Info>()
  const editor = {
    add: (tool: Info) => {
      tools.set(tool.name, tool)
    },
    list: () => [...tools.values()].map((tool) => ({ ...tool, id: tool.name })),
    get: (id: string) => {
      const tool = tools.get(id)
      return tool ? { ...tool, id } : undefined
    },
    namespace: () => {},
    update: () => {},
    remove: (id: string) => {
      tools.delete(id)
    },
  } satisfies ToolEditor
  const transform = mock(async (callback: (editor: ToolEditor) => void) => {
    expect(callback(editor)).toBeUndefined()
    return { dispose: async () => {} }
  })
  const credential: Credential.OAuth = {
    type: "oauth",
    methodID: "chatgpt-browser" as Credential.OAuth["methodID"],
    access: "v2-access",
    refresh: "v2-refresh",
    expires: Date.now() + 60_000,
    metadata: { accountID: "v2-account" },
  }
  const connection = {
    active: mock(async () => ({ type: "credential", id: "cred-v2", label: "Codex", method: "oauth" }) as const),
    resolve: mock(async (): Promise<Credential.Value | undefined> => credential),
  }
  const session = { get: mock(async () => ({ location: { directory } })) }
  const ctx = {
    location: { directory: path.join(directory, "different-setup-location") },
    tool: { transform },
    integration: { connection },
    session,
  } as unknown as Plugin.Context
  await plugin.setup(ctx)
  const tool = tools.get("gpt_imagegen")
  if (!tool) throw new Error("gpt_imagegen was not registered")
  const context = {
    sessionID: "ses-test",
    signal: new AbortController().signal,
  } as ToolContext
  return { tool, context, connection, credential, session, transform, editor, tools }
}

describe("OpenCode plugin entrypoints", () => {
  test("exports the same stable ID with separate V1 and V2 entrypoints", () => {
    expect(plugin.id).toBe("opencode-gpt-imagegen")
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
  })

  test("registers a replayable V2 tool without doing generation or reading credentials during setup", async () => {
    const backend = mockBackend()
    const { tool, transform, editor, connection, session, tools } = await setupPlugin()
    expect(transform).toHaveBeenCalledTimes(1)
    expect(connection.active).not.toHaveBeenCalled()
    expect(session.get).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()

    // V2 replays the same synchronous transform when the registry reloads.
    transform.mock.calls[0][0](editor)
    expect(tools.size).toBe(1)
    expect(tools.get("gpt_imagegen")?.input).toEqual(tool.input)
  })

  test("uses JSON Schema with the existing required and optional arguments", async () => {
    const { tool } = await setupPlugin()
    expect(tool.input).toMatchObject({
      type: "object",
      required: ["prompt", "out", "quality"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string" },
        out: { type: "string" },
        quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
        size: { type: "string" },
        images: { type: "array", items: { type: "string" } },
      },
    })
  })

  test("reads and saves images relative to the invoking session and returns V2 content", async () => {
    const backend = mockBackend()
    await writeFile(path.join(directory, "reference.png"), PNG_BUFFER)
    const { tool, context, session } = await setupPlugin()
    const result = await tool.execute({ ...ARGS, images: ["reference.png"], size: "1024x1024" }, context)
    const out = path.join(directory, ARGS.out)
    expect(result).toEqual({
      content: `Generated image saved to ${out}.`,
      metadata: { out, versioned: false, billing: "subscription" },
    })
    expect(await readFile(out)).toEqual(PNG_BUFFER)
    expect(session.get).toHaveBeenCalledWith({ sessionID: "ses-test" })
    const [, init] = backend.mock.calls[0]
    expect(init.signal).toBe(context.signal)
    expect(init.headers).toMatchObject({ Authorization: "Bearer v2-access", "ChatGPT-Account-Id": "v2-account" })
    const body = JSON.parse(init.body as string)
    expect(body.input[0].content[1]).toEqual({ type: "input_image", image_url: pngDataUrl(PNG_BUFFER) })
  })

  test("preserves auto-versioning through the V2 tool", async () => {
    mockBackend()
    const { tool, context } = await setupPlugin()
    await tool.execute(ARGS, context)
    const result = await tool.execute(ARGS, context)
    expect(result.metadata).toMatchObject({ out: path.join(directory, "nested/cat-v2.png"), versioned: true })
    expect(await readFile(path.join(directory, ARGS.out))).toEqual(PNG_BUFFER)
  })

  test("resolves credentials again on every execution rather than caching a token", async () => {
    const backend = mockBackend()
    const { tool, context, connection, credential } = await setupPlugin()
    await tool.execute(ARGS, context)
    connection.resolve.mockResolvedValue({ ...credential, access: "refreshed-or-switched-token" })
    await tool.execute(ARGS, context)
    expect(connection.resolve).toHaveBeenCalledTimes(2)
    expect(backend.mock.calls[1][1].headers).toMatchObject({ Authorization: "Bearer refreshed-or-switched-token" })
  })

  test("does not fall back to legacy auth when V2 has no usable credential", async () => {
    const backend = mockBackend()
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "stale-v1-token" } })
    const { tool, context, connection } = await setupPlugin()
    connection.resolve.mockResolvedValue(undefined)
    await expect(tool.execute(ARGS, context)).rejects.toThrow("OpenAI Codex OAuth credentials not configured")
    expect(backend).not.toHaveBeenCalled()
    expect(existsSync(path.join(directory, ARGS.out))).toBe(false)
  })

  test("does not contact the backend when V2 uses ChatGPT token sharing", async () => {
    const backend = mockBackend()
    const { tool, context, connection, credential } = await setupPlugin()
    connection.resolve.mockResolvedValue({
      ...credential,
      methodID: "chatgpt-token-sharing" as Credential.OAuth["methodID"],
    })
    await expect(tool.execute(ARGS, context)).rejects.toThrow("ChatGPT token sharing cannot be used")
    expect(backend).not.toHaveBeenCalled()
  })

  test("stops before credential resolution or generation when the V2 call is already aborted", async () => {
    const backend = mockBackend()
    const { tool, context, connection } = await setupPlugin()
    await expect(tool.execute(ARGS, { ...context, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(connection.active).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
  })

  test("does not save an image when cancellation arrives during the backend request", async () => {
    const controller = new AbortController()
    const backend = mockBackend()
    backend.mockImplementation(async () => {
      controller.abort(new Error("generation cancelled"))
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: PNG_BASE64 } })}\n\n`,
      )
    })
    const { tool, context } = await setupPlugin()
    await expect(tool.execute(ARGS, { ...context, signal: controller.signal })).rejects.toThrow("generation cancelled")
    expect(existsSync(path.join(directory, ARGS.out))).toBe(false)
  })

  test("keeps the V1 server tool and its output result format", async () => {
    const backend = mockBackend()
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "v1-access" } })
    const hooks = await plugin.server({} as PluginInput)
    const tool = hooks.tool?.gpt_imagegen
    if (!tool) throw new Error("V1 gpt_imagegen was not registered")
    const signal = new AbortController().signal
    const result = await tool.execute(ARGS, { directory, abort: signal } as LegacyToolContext)
    const out = path.join(directory, ARGS.out)
    expect(result).toEqual({
      output: `Generated image saved to ${out}.`,
      metadata: { out, versioned: false, billing: "subscription" },
    })
    expect(await readFile(out)).toEqual(PNG_BUFFER)
    expect(backend.mock.calls[0][1].signal).toBe(signal)
  })
})
