import { afterEach, describe, expect, mock, test } from "bun:test"
import { type CodexImageRequest, requestCodexImage } from "../../src/codex"
import type { OpenAIAuth } from "../../src/types"

function imagesResponse(data: Array<{ b64_json: string }>): Response {
  return new Response(JSON.stringify({ created: 0, data }))
}

async function loadAuth(): Promise<OpenAIAuth> {
  return { type: "oauth", access: "tok" }
}

function imageRequest(overrides: Partial<CodexImageRequest> = {}): CodexImageRequest {
  return { prompt: "a cat", size: "1254x1254", background: "opaque", images: [], ...overrides }
}

describe("requestCodexImage", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("posts the Codex request body to the generations endpoint and returns the image when no reference image is given", async () => {
    const image = "BASE64IMAGE"
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: image }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth: OpenAIAuth = { type: "oauth", access: "tok", accountId: "acct" }
    const prompt = "a mountain lake"
    const request = imageRequest({ prompt, size: "1254x1254", background: "opaque" })

    const result = await requestCodexImage({}, async () => auth, request)

    expect(result).toBe(image)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
      "ChatGPT-Account-Id": "acct",
      originator: "opencode",
    })
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: `${prompt} Generate the image with a width of 1254 pixels and a height of 1254 pixels (1:1 aspect ratio).`,
      background: "opaque",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    })
  })

  test("posts the Codex request body with the reference images to the edits endpoint when they are given", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const prompt = "put both characters together"
    const dataUrls = ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"]
    const request = imageRequest({ prompt, size: "1672x941", background: "opaque", images: dataUrls })

    await requestCodexImage({}, loadAuth, request)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: `${prompt} Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio).`,
      background: "opaque",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
      images: [{ image_url: dataUrls[0] }, { image_url: dataUrls[1] }],
    })
  })

  test("sends the requested background", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const background = "transparent"

    await requestCodexImage({}, loadAuth, imageRequest({ background }))

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string).background).toBe(background)
  })

  test("omits the account header when accountId is absent", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth: OpenAIAuth = { type: "oauth", access: "tok" }

    await requestCodexImage({}, async () => auth, imageRequest())

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers as Record<string, string>).not.toHaveProperty("ChatGPT-Account-Id")
  })

  test("throws without requesting an image when no credentials are loaded", async () => {
    const fetchMock = mock()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const act = requestCodexImage({}, async () => undefined, imageRequest())

    await expect(act).rejects.toThrow("OpenAI ChatGPT OAuth credentials not configured.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("posts to the proxy's generations endpoint without loading or sending credentials when baseURL is given", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const loadSignedInAuth = mock(loadAuth)

    await requestCodexImage({ baseURL: "http://127.0.0.1:3457/v1" }, loadSignedInAuth, imageRequest())

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:3457/v1/images/generations")
    expect(init.headers).toEqual({ "Content-Type": "application/json", originator: "opencode" })
    expect(loadSignedInAuth).not.toHaveBeenCalled()
  })

  test("posts to the proxy's edits endpoint when the proxy baseURL ends with a slash", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const request = imageRequest({ images: ["data:image/png;base64,AAA"] })

    await requestCodexImage({ baseURL: "http://127.0.0.1:3457/v1/" }, loadAuth, request)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:3457/v1/images/edits")
    expect(init.headers).toEqual({ "Content-Type": "application/json", originator: "opencode" })
  })

  test("throws with the status and response body when the request fails", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response("upstream boom", { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const act = requestCodexImage({}, loadAuth, imageRequest())

    await expect(act).rejects.toThrow("codex images request failed: 500 upstream boom")
  })

  test("throws when the response contains no image", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const act = requestCodexImage({}, loadAuth, imageRequest())

    await expect(act).rejects.toThrow("no image returned by codex images endpoint")
  })

  test("throws when the returned image is empty", async () => {
    // An empty image would decode to a 0-byte file and be reported as success.
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const act = requestCodexImage({}, loadAuth, imageRequest())

    await expect(act).rejects.toThrow("no image returned by codex images endpoint")
  })
})
