import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createImagegenTool } from "../../src/imagegen"
import type { OpenAIAuth } from "../../src/types"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "imagegen-"))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
})

function imagesResponse(b64Json: string): Response {
  return new Response(JSON.stringify({ created: 0, data: [{ b64_json: b64Json }] }))
}

async function loadAuth(): Promise<OpenAIAuth> {
  return { type: "oauth", access: "tok", accountId: "acct" }
}

describe("createImagegenTool", () => {
  const supportedSizes =
    "1254x1254 (1:1), 1536x1024 (3:2), 1024x1536 (2:3), 1448x1086 (4:3), 1086x1448 (3:4), 1672x941 (16:9), 941x1672 (9:16)"

  test("saves the generated image under the context directory and reports it", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    const out = "cat.png"
    const size = "1672x941"

    const result = await imagegen.execute({ prompt: "a cat", out, size }, dir)

    const savedPath = path.join(dir, out)
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    // PNG_BASE64 is a 1x1 image. The message reports the size of the saved image, not the requested size.
    expect(result).toEqual({
      message: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      savedPath,
      versioned: false,
    })
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string).prompt).toBe(
      "a cat Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio).",
    )
  })

  test("ignores a quality argument from callers written for older versions", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    const out = "cat.png"
    // Versions before 1.0.0 required quality, so older prompts and skills may still pass it.
    const args = { prompt: "a cat", out, size: "1672x941", quality: "low" } as const

    await imagegen.execute(args, dir)

    expect(await readFile(path.join(dir, out))).toEqual(PNG_BUFFER)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string).quality).toBe("auto")
  })

  test("rejects an unsupported size with the supported sizes without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    // Some OpenCode versions pass arguments to execute without validating them against the schema.
    const size = "1280x720"

    const act = imagegen.execute({ prompt: "a cat", out: "cat.png", size }, dir)

    await expect(act).rejects.toThrow(`Unsupported size "${size}". Use one of: ${supportedSizes}.`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects a missing size with the supported sizes without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    const args = { prompt: "a cat", out: "cat.png" }

    const act = imagegen.execute(args, dir)

    await expect(act).rejects.toThrow(`Missing size. Use one of: ${supportedSizes}.`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("generates without reference images when images is null", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    const out = "cat.png"
    // Some models fill unused optional arguments with null.
    const args = { prompt: "a cat", out, size: "1254x1254", images: null }

    await imagegen.execute(args, dir)

    expect(await readFile(path.join(dir, out))).toEqual(PNG_BUFFER)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
  })

  test("rejects more than five reference images without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    const images = ["1.png", "2.png", "3.png", "4.png", "5.png", "6.png"]

    const act = imagegen.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254", images }, dir)

    await expect(act).rejects.toThrow("at images")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("reports a null size as missing", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    const args = { prompt: "a cat", out: "cat.png", size: null }

    const act = imagegen.execute(args, dir)

    await expect(act).rejects.toThrow(`Missing size. Use one of: ${supportedSizes}.`)
  })

  test("rejects an unsupported background without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    const args = { prompt: "a cat", out: "cat.png", size: "1254x1254", background: "auto" }

    const act = imagegen.execute(args, dir)

    await expect(act).rejects.toThrow("at background")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects a missing prompt without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool(undefined, loadAuth)
    const args = { out: "cat.png", size: "1254x1254" }

    const act = imagegen.execute(args, dir)

    await expect(act).rejects.toThrow("at prompt")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("sends the request to the baseURL proxy without ChatGPT credentials when the option is set", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool({ baseURL: "http://127.0.0.1:3457/v1" }, async () => {
      throw new Error("Proxy requests must not load ChatGPT credentials")
    })

    await imagegen.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, dir)

    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:3457/v1/images/generations")
    expect(init.headers).toEqual({ "Content-Type": "application/json", originator: "opencode" })
  })

  test("sends a signed-in user's ChatGPT credentials nowhere when baseURL is set", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool({ baseURL: "http://127.0.0.1:3457/v1" }, loadAuth)

    await imagegen.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, dir)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:3457/v1/images/generations")
    expect(init.headers).toEqual({ "Content-Type": "application/json", originator: "opencode" })
  })

  test("describes the proxy instead of ChatGPT OAuth when baseURL is set", async () => {
    const imagegen = createImagegenTool({ baseURL: "http://127.0.0.1:3457/v1" }, loadAuth)

    expect(imagegen.description).toContain("the plugin's `baseURL` option")
    expect(imagegen.description).not.toContain("Requires OpenCode to be authenticated")
  })

  test("describes the ChatGPT OAuth requirement when baseURL is not set", async () => {
    const imagegen = createImagegenTool(undefined, loadAuth)

    expect(imagegen.description).toContain("Requires OpenCode to be authenticated with ChatGPT OAuth.")
  })

  test.each(["http://127.0.0.1:3457/v1?x=1", "http://127.0.0.1:3457/v1#frag"])(
    "rejects baseURL %s, which has a query or a fragment, without calling the backend",
    async (baseURL) => {
      const fetchMock = mock(async () => new Response(""))
      globalThis.fetch = fetchMock as unknown as typeof fetch
      const imagegen = createImagegenTool({ baseURL }, loadAuth)

      const act = imagegen.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, dir)

      await expect(act).rejects.toThrow("baseURL must not have a query or a fragment")
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("rejects a baseURL that is not an http(s) URL without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imagegen = createImagegenTool({ baseURL: "file:///etc/passwd" }, loadAuth)

    const act = imagegen.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, dir)

    await expect(act).rejects.toThrow("invalid opencode-gpt-imagegen options")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
