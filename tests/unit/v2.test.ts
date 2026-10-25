import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadOpenAIIntegrationAuth } from "../../src/auth"
import plugin, { type V2Context, type V2Execution, type V2Tool } from "../../src/index"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

const originalFetch = globalThis.fetch
function execution(signal = new AbortController().signal): V2Execution {
  return { sessionID: "test-session", messageID: "test-message", id: "test-call", agent: "build", signal }
}
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "imagegen-v2-"))
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(directory, { recursive: true, force: true })
})

function host(value: unknown = { type: "oauth", access: "test-token", metadata: { accountId: "account" } }) {
  let registered: V2Tool | undefined
  const active = mock(async () => ({ id: "connection" }))
  const resolve = mock(async () => value)
  const permission = mock(async () => {})
  const ctx: V2Context = {
    options: {},
    integration: { connection: { active, resolve } },
    session: { get: async () => ({ location: { directory } }) },
    permission: { assert: permission },
    tool: {
      transform: async (callback) => {
        callback({
          add: (tool) => {
            registered = tool
          },
        })
      },
    },
  }
  return {
    ctx,
    active,
    resolve,
    permission,
    tool: () => {
      if (!registered) throw new Error("Tool not registered")
      return registered
    },
  }
}

describe("OpenCode V2", () => {
  test("keeps both entrypoints and registers JSON Schema", async () => {
    const h = host()
    await plugin.setup(h.ctx)
    expect(typeof plugin.server).toBe("function")
    expect(h.tool().name).toBe("gpt_imagegen")
    expect(h.tool().input.required).toEqual(["prompt", "out", "size"])
    expect(h.active).not.toHaveBeenCalled()
  })

  test("uses host credentials, invoking session paths, and returns a file attachment", async () => {
    const h = host()
    const fetchMock = mock(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] })),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await plugin.setup(h.ctx)
    const result = await h.tool().execute({ prompt: "a cat", out: "cat #1.png", size: "1254x1254" }, execution())
    const saved = path.join(directory, "cat #1.png")
    expect(await readFile(saved)).toEqual(PNG_BUFFER)
    expect(result.content).toContainEqual({ type: "file", uri: pathToFileURL(saved).href, mime: "image/png" })
    expect(h.active).toHaveBeenCalledWith("openai")
    expect(h.permission).toHaveBeenCalledWith({
      sessionID: "test-session",
      agent: "build",
      source: { type: "tool", messageID: "test-message", id: "test-call" },
      action: "edit",
      resources: [saved],
    })
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token")
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test("never resolves host credentials or sends them to a proxy", async () => {
    const h = host()
    h.ctx.options = { baseURL: "http://127.0.0.1:3457/v1" }
    const fetchMock = mock(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] })),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await plugin.setup(h.ctx)
    await h.tool().execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, execution())
    expect(h.resolve).not.toHaveBeenCalled()
    expect(h.active).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization")
  })

  test("rejects invalid input and cancelled calls before contacting the backend", async () => {
    const h = host()
    const fetchMock = mock(async () => new Response("unexpected"))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await plugin.setup(h.ctx)
    const context = execution(AbortSignal.abort())
    await expect(h.tool().execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, context)).rejects.toThrow()
    await expect(h.tool().execute({ prompt: "a cat" }, context)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.resolve).not.toHaveBeenCalled()
  })

  test("does not fall back to auth.json when no host OAuth exists", async () => {
    const h = host({ type: "key", key: "not-used" })
    await expect(loadOpenAIIntegrationAuth(h.ctx.integration)).rejects.toThrow("Codex OAuth")
  })

  test("respects a denied edit before resolving credentials", async () => {
    const h = host()
    h.ctx.permission.assert = async () => {
      throw new Error("Permission denied")
    }
    await plugin.setup(h.ctx)
    await expect(h.tool().execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, execution())).rejects.toThrow(
      "Permission denied",
    )
    expect(h.resolve).not.toHaveBeenCalled()
  })

  test("checks the actual versioned output path before writing it", async () => {
    const h = host()
    await writeFile(path.join(directory, "cat.png"), PNG_BUFFER)
    h.ctx.permission.assert = async (input) => {
      if (input.resources.some((resource) => resource.endsWith("cat-v2.png"))) throw new Error("Versioned path denied")
    }
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] })),
    ) as unknown as typeof fetch
    await plugin.setup(h.ctx)
    await expect(h.tool().execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, execution())).rejects.toThrow(
      "Versioned path denied",
    )
    expect(await readFile(path.join(directory, "cat.png"))).toEqual(PNG_BUFFER)
    await expect(access(path.join(directory, "cat-v2.png"))).rejects.toThrow()
  })

  test("cancels an in-flight backend call without writing an image", async () => {
    const h = host()
    const controller = new AbortController()
    let started: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      started()
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      })
    }) as unknown as typeof fetch
    await plugin.setup(h.ctx)
    const run = h
      .tool()
      .execute({ prompt: "a cat", out: "cancelled.png", size: "1254x1254" }, execution(controller.signal))
    await ready
    controller.abort()
    await expect(run).rejects.toThrow("cancelled")
    await expect(access(path.join(directory, "cancelled.png"))).rejects.toThrow()
  })

  test("uses JWT account claims when metadata is absent", async () => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" } }),
    ).toString("base64url")
    const h = host({ type: "oauth", access: `header.${payload}.signature` })
    expect((await loadOpenAIIntegrationAuth(h.ctx.integration)).accountId).toBe("jwt-account")
  })

  test("redacts echoed tokens and explains rejected Codex authentication", async () => {
    const h = host()
    globalThis.fetch = mock(async () => new Response("rejected test-token", { status: 401 })) as unknown as typeof fetch
    await plugin.setup(h.ctx)
    const run = h.tool().execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, execution())
    await expect(run).rejects.toThrow("[redacted]")
    await expect(run).rejects.toThrow("Codex browser/device")
  })
})
