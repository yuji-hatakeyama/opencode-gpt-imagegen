import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { createImagegenTool } from "../../src/imagegen"
import { setup } from "../../src/v2"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

const originalFetch = globalThis.fetch
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "v2-"))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  await rm(dir, { recursive: true, force: true })
})

type Connection = Context["integration"]["connection"]
type Credential = NonNullable<Awaited<ReturnType<Connection["resolve"]>>>
type TestHost = Pick<Connection, "active" | "resolve"> & {
  options?: Context["options"]
  getSession: Context["session"]["get"]
}

function createSession(directory: string): Awaited<ReturnType<TestHost["getSession"]>> {
  return {
    id: "ses_imagegen",
    projectID: "project_imagegen",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory },
  }
}

async function registerTool(host: TestHost, directory: string): Promise<Info> {
  const registered: Info[] = []
  const context = {
    options: host.options ?? {},
    location: { directory: path.join(directory, "plugin-location") },
    tool: {
      transform: async (edit: (editor: ToolEditor) => void) => {
        edit({ add: (tool: Info) => registered.push(tool) } as unknown as ToolEditor)
      },
    },
    integration: { connection: { active: host.active, resolve: host.resolve } },
    session: { get: host.getSession },
  } as unknown as Context
  await setup(context)
  const tool = registered.find((entry) => entry.name === "gpt_imagegen")
  if (!tool) throw new Error("gpt_imagegen was not registered")
  return tool
}

describe("setup", () => {
  test("uses ChatGPT OAuth credentials and returns the saved image's content and metadata (#136)", async () => {
    const access = "tok"
    const accountId = "acct"
    const sessionID = "ses_imagegen"
    const connection = { type: "credential", id: "cred_codex", label: "Codex", method: "oauth" } as const
    const active = mock<TestHost["active"]>(async () => connection)
    const resolve = mock<TestHost["resolve"]>(async () => ({
      type: "oauth",
      methodID: "chatgpt-browser" as Extract<Credential, { type: "oauth" }>["methodID"],
      access,
      refresh: "refresh-token",
      expires: 0,
      metadata: { accountID: accountId },
    }))
    const getSession = mock<TestHost["getSession"]>(async () => createSession(dir))
    const fetchMock = mock(async (_url: string, _init: RequestInit) =>
      Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const tool = await registerTool({ active, resolve, getSession }, dir)
    const out = "cat.png"

    const result = await tool.execute({ prompt: "a cat", out, size: "1672x941" }, { sessionID } as ToolContext)

    const savedPath = path.join(dir, out)
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    expect(result).toEqual({
      content: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      metadata: { out: savedPath, versioned: false },
    })
    expect(active.mock.calls).toEqual([["openai"]])
    expect(resolve.mock.calls).toEqual([[connection]])
    expect(getSession.mock.calls).toEqual([[{ sessionID }]])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
      originator: "opencode",
    })
  })

  test("registers the shared description and schema as plain JSON Schema (#136)", async () => {
    const imagegen = createImagegenTool(undefined, async () => undefined)
    const expectedInput = z.toJSONSchema(imagegen.schema, { io: "input" })

    const tool = await registerTool(
      {
        active: async () => undefined,
        resolve: async () => undefined,
        getSession: async () => createSession(dir),
      },
      dir,
    )

    const schema = JSON.parse(JSON.stringify(tool.input))

    expect(schema).toEqual(tool.input)
    expect(schema).toEqual(expectedInput)
    expect(tool.description).toBe(imagegen.description)
    expect(tool.options?.codemode).toBe(false)
  })

  test("sends requests to the baseURL proxy without looking up the OpenAI connection (#136)", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) =>
      Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const tool = await registerTool(
      {
        options: { baseURL: "http://127.0.0.1:3457/v1" },
        active: async () => {
          throw new Error("Proxy requests must not look up the OpenAI connection")
        },
        resolve: async () => undefined,
        getSession: async () => createSession(dir),
      },
      dir,
    )

    await tool.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, {
      sessionID: "ses_imagegen",
    } as ToolContext)

    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:3457/v1/images/generations")
    expect(init.headers).toEqual({ "Content-Type": "application/json", originator: "opencode" })
    expect(tool.description).toContain("the plugin's `baseURL` option")
  })

  test("rejects missing credentials without falling back to V1 environment auth or requesting an image (#136)", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "v1-token", accountId: "v1-account" },
    })
    const tool = await registerTool(
      {
        active: async () => undefined,
        resolve: async () => undefined,
        getSession: async () => createSession(dir),
      },
      dir,
    )
    const fetchMock = mock()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const act = tool.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, {
      sessionID: "ses_imagegen",
    } as ToolContext)

    await expect(act).rejects.toThrow("OpenAI ChatGPT OAuth credentials not configured.")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
