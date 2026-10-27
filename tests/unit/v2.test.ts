import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import plugin from "../../src/index"
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
type TestHost = Pick<Connection, "active" | "resolve"> & {
  options?: Context["options"]
  getSession: Context["session"]["get"]
}

type CredentialConnection = Extract<NonNullable<Awaited<ReturnType<Connection["active"]>>>, { type: "credential" }>
type Credential = NonNullable<Awaited<ReturnType<Connection["resolve"]>>>
type OAuthCredential = Extract<Credential, { type: "oauth" }>

function createConnection(overrides: Partial<CredentialConnection> = {}): CredentialConnection {
  return { type: "credential", id: "cred_codex", label: "Codex", method: "oauth", ...overrides }
}

function createOAuthCredential(
  input: Pick<OAuthCredential, "access" | "metadata"> & { methodID: string },
): OAuthCredential {
  return {
    type: "oauth",
    refresh: "refresh-token",
    expires: 0,
    ...input,
    methodID: input.methodID as OAuthCredential["methodID"],
  }
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

async function registerTool(host: TestHost): Promise<Info> {
  const registered: Info[] = []
  const context = {
    options: host.options ?? {},
    location: { directory: path.join(dir, "plugin-location") },
    tool: {
      transform: async (edit: (editor: ToolEditor) => void) => {
        edit({ add: (tool: Info) => registered.push(tool) } as unknown as ToolEditor)
      },
    },
    integration: { connection: { active: host.active, resolve: host.resolve } },
    session: { get: host.getSession },
  } as unknown as Context
  await plugin.setup(context)
  const tool = registered.find((entry) => entry.name === "gpt_imagegen")
  if (!tool) throw new Error("gpt_imagegen was not registered")
  return tool
}

describe("plugin.setup", () => {
  test("cancels an in-flight image request without saving a file when the tool is aborted (#136)", async () => {
    const controller = new AbortController()
    const reason = new Error("Generation cancelled")
    const backend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        controller.abort(reason)
        return Response.json({ data: [{ b64_json: PNG_BASE64 }] })
      },
    })
    try {
      const tool = await registerTool({
        options: { baseURL: backend.url.href },
        active: async () => undefined,
        resolve: async () => undefined,
        getSession: async () => createSession(dir),
      })

      const result = tool.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, {
        sessionID: "ses_imagegen",
        signal: controller.signal,
      } as ToolContext)

      await expect(result).rejects.toThrow(reason.message)
      expect(await readdir(dir)).toEqual([])
    } finally {
      await backend.stop(true)
    }
  })

  test("registers descriptions and argument constraints as plain JSON Schema (#136)", async () => {
    const tool = await registerTool({
      active: async () => undefined,
      resolve: async () => undefined,
      getSession: async () => createSession(dir),
    })

    const schema = JSON.parse(JSON.stringify(tool.input))

    expect(schema).toEqual(tool.input)
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["prompt", "out", "size"])
    expect(tool.description).toContain("Requires OpenCode to be authenticated with ChatGPT OAuth.")
    expect(schema.properties.prompt.description).toBe("Description of the image to generate.")
    expect(schema.properties.out.description).toContain("relative to the project directory unless absolute")
    expect(schema.properties.size.description).toContain("Typical choices: 1672x941 for a 16:9 video thumbnail")
    expect(schema.properties.size.enum).toEqual([
      "1254x1254",
      "1536x1024",
      "1024x1536",
      "1448x1086",
      "1086x1448",
      "1672x941",
      "941x1672",
    ])
    expect(schema.properties.images.description).toContain("Optional reference image paths, up to 5")
    expect(schema.properties.images.anyOf).toEqual([
      { type: "array", items: { type: "string" }, maxItems: 5 },
      { type: "null" },
    ])
    expect(schema.properties.background.description).toContain("preserve their existing transparency")
    expect(schema.properties.background.anyOf).toEqual([
      { type: "string", enum: ["opaque", "transparent"] },
      { type: "null" },
    ])
  })

  test.each(["chatgpt-browser", "chatgpt-headless"])(
    "uses %s credentials and saves relative to the executing session (#136)",
    async (methodID) => {
      const access = "codex-token"
      const accountID = "chatgpt-account"
      const connection = createConnection()
      const sessionID = "ses_imagegen"
      const tool = await registerTool({
        active: async (id) => {
          expect(id).toBe("openai")
          return connection
        },
        resolve: async (selected) => {
          expect(selected).toBe(connection)
          return createOAuthCredential({ methodID, access, metadata: { accountID } })
        },
        getSession: async (input) => {
          expect(input.sessionID).toBe(sessionID)
          return createSession(dir)
        },
      })
      const fetchMock = mock(async (_url: string, _init: RequestInit) =>
        Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
      )
      globalThis.fetch = fetchMock as unknown as typeof fetch
      const out = "cat.png"

      const result = await tool.execute({ prompt: "a cat", out, size: "1254x1254" }, { sessionID } as ToolContext)

      const savedPath = path.join(dir, out)
      expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
      expect(result).toEqual({
        content: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
        metadata: { out: savedPath, versioned: false },
      })
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: `Bearer ${access}`,
        "ChatGPT-Account-Id": accountID,
        originator: "opencode",
      })
    },
  )

  test("uses the proxy without reading host credentials or sending auth headers (#136)", async () => {
    const active = mock(async () => {
      throw new Error("proxy must not read active credentials")
    })
    const resolve = mock(async () => {
      throw new Error("proxy must not resolve credentials")
    })
    const baseURL = "https://proxy.example.test/v1"
    const tool = await registerTool({
      options: { baseURL },
      active,
      resolve,
      getSession: async () => createSession(dir),
    })
    const fetchMock = mock(async (_url: string, _init: RequestInit) =>
      Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await tool.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, {
      sessionID: "ses_imagegen",
    } as ToolContext)

    expect(active).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseURL}/images/generations`)
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      "Content-Type": "application/json",
      originator: "opencode",
    })
    expect(tool.description).toContain("ChatGPT OAuth is not used")
    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
  })

  test("re-reads the active credential for each execution and versions repeated output paths (#136)", async () => {
    const firstConnection = createConnection({ id: "cred_first" })
    const secondConnection = createConnection({ id: "cred_second" })
    const firstAccountID = "first-account"
    const secondAccountID = "second-account"
    const firstCredential = createOAuthCredential({
      methodID: "chatgpt-browser",
      access: "first-token",
      metadata: { accountID: firstAccountID },
    })
    const secondCredential = createOAuthCredential({
      methodID: "chatgpt-headless",
      access: "second-token",
      metadata: { accountID: secondAccountID },
    })
    const active = mock<Connection["active"]>(async () => firstConnection)
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(secondConnection)
    const resolve = mock<Connection["resolve"]>(async () => firstCredential)
      .mockResolvedValueOnce(firstCredential)
      .mockResolvedValueOnce(secondCredential)
    const tool = await registerTool({
      active,
      resolve,
      getSession: async () => createSession(dir),
    })
    const fetchMock = mock(async (_url: string, _init: RequestInit) =>
      Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const args = { prompt: "a cat", out: "cat.png", size: "1254x1254" }
    const execution = { sessionID: "ses_imagegen" } as ToolContext

    const first = await tool.execute(args, execution)
    const second = await tool.execute(args, execution)

    expect(active.mock.calls).toEqual([["openai"], ["openai"]])
    expect(resolve.mock.calls).toEqual([[firstConnection], [secondConnection]])
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: `Bearer ${firstCredential.access}`,
      "ChatGPT-Account-Id": firstAccountID,
    })
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      Authorization: `Bearer ${secondCredential.access}`,
      "ChatGPT-Account-Id": secondAccountID,
    })
    const firstPath = path.join(dir, "cat.png")
    const secondPath = path.join(dir, "cat-v2.png")
    expect(first.metadata).toEqual({ out: firstPath, versioned: false })
    expect(second.metadata).toEqual({ out: secondPath, versioned: true })
    expect(second.content).toContain(secondPath)
    expect(await readFile(firstPath)).toEqual(PNG_BUFFER)
    expect(await readFile(secondPath)).toEqual(PNG_BUFFER)
  })

  test("uses the current session directory for outputs and references after the directory changes (#136)", async () => {
    const nextDirectory = path.join(dir, "next-session-directory")
    await mkdir(nextDirectory)
    const reference = "reference.png"
    await writeFile(path.join(nextDirectory, reference), PNG_BUFFER)
    const sessionID = "ses_imagegen"
    const getSession = mock<TestHost["getSession"]>(async () => createSession(dir))
      .mockResolvedValueOnce(createSession(dir))
      .mockResolvedValueOnce(createSession(nextDirectory))
    const baseURL = "https://proxy.example.test/v1"
    const tool = await registerTool({
      options: { baseURL },
      active: async () => undefined,
      resolve: async () => undefined,
      getSession,
    })
    const fetchMock = mock(async (_url: string, _init: RequestInit) =>
      Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const args = { prompt: "a cat", out: "cat.png", size: "1254x1254" }
    const execution = { sessionID } as ToolContext

    const first = await tool.execute(args, execution)
    const second = await tool.execute({ ...args, images: [reference] }, execution)

    expect(getSession.mock.calls).toEqual([[{ sessionID }], [{ sessionID }]])
    expect(first.metadata).toEqual({ out: path.join(dir, args.out), versioned: false })
    expect(second.metadata).toEqual({ out: path.join(nextDirectory, args.out), versioned: false })
    expect(await readFile(path.join(dir, args.out))).toEqual(PNG_BUFFER)
    expect(await readFile(path.join(nextDirectory, args.out))).toEqual(PNG_BUFFER)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(`${baseURL}/images/edits`)
    expect(JSON.parse(init.body as string).images).toEqual([{ image_url: `data:image/png;base64,${PNG_BASE64}` }])
  })

  test.each([
    ["no active connection", undefined, undefined, "OpenAI ChatGPT OAuth credentials not configured."],
    [
      "no resolved credential",
      createConnection({ id: "cred_missing" }),
      undefined,
      "OpenAI ChatGPT OAuth credentials not configured.",
    ],
    [
      "an API key credential",
      createConnection({ id: "cred_key", method: "key" }),
      { type: "key", key: "api-key" },
      'The OpenAI connection\'s sign-in method (key) cannot generate images. In OpenCode, connect OpenAI and choose "Codex browser (legacy)" or "Codex device code (legacy)".',
    ],
  ] satisfies [string, CredentialConnection | undefined, Credential | undefined, string][])(
    "rejects %s without falling back to V1 environment auth (#136)",
    async (_label, connection, credential, error) => {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
        openai: { type: "oauth", access: "v1-token", accountId: "v1-account" },
      })
      const tool = await registerTool({
        active: async () => connection,
        resolve: async () => credential,
        getSession: async () => createSession(dir),
      })
      const fetchMock = mock(async () => Response.json({ data: [{ b64_json: PNG_BASE64 }] }))
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const act = tool.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, {
        sessionID: "ses_imagegen",
      } as ToolContext)

      await expect(act).rejects.toThrow(error)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("retains the host credential resolution error instead of reporting missing auth (#136)", async () => {
    const error = new Error("OAuth refresh failed: credential revoked")
    const tool = await registerTool({
      active: async () => createConnection({ id: "cred_revoked" }),
      resolve: async () => {
        throw error
      },
      getSession: async () => createSession(dir),
    })
    const fetchMock = mock(async () => Response.json({ data: [{ b64_json: PNG_BASE64 }] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const act = tool.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, {
      sessionID: "ses_imagegen",
    } as ToolContext)

    await expect(act).rejects.toBe(error)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects token-sharing with Codex sign-in instructions before requesting an image (#136)", async () => {
    const tool = await registerTool({
      active: async () => createConnection({ id: "cred_sharing" }),
      resolve: async () => createOAuthCredential({ methodID: "chatgpt-token-sharing", access: "sharing-token" }),
      getSession: async () => createSession(dir),
    })
    const fetchMock = mock(async () => Response.json({ data: [{ b64_json: PNG_BASE64 }] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const act = tool.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, {
      sessionID: "ses_imagegen",
    } as ToolContext)

    await expect(act).rejects.toThrow('choose "Codex browser (legacy)" or "Codex device code (legacy)"')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
