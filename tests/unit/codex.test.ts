import { afterEach, describe, expect, mock, test } from "bun:test"
import { callViaCodexImages } from "../../src/codex"
import type { GenerateArgs } from "../../src/types"

function imageResponse(b64: string): Response {
  return new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }))
}

function installFetch(handler: () => Promise<Response>) {
  const fetchMock = mock(async (_url: string, _init: RequestInit) => handler())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const AUTH = { type: "oauth", access: "tok", accountId: "acct" } as const
const ARGS: GenerateArgs = { prompt: "a cat", out: "cat.png" }
// Retries are exercised with a zero base delay so the suite does not sleep for real.
const NO_DELAY = { retryBaseDelayMs: 0 }

describe("callViaCodexImages", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("posts a generations request and returns the first image's base64", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))

    const result = await callViaCodexImages(AUTH, { ...ARGS, size: "1024x1536" }, [])

    expect(result).toBe("B64")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(init.method).toBe("POST")

    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer tok")
    expect(headers["ChatGPT-Account-ID"]).toBe("acct")
    expect(headers.originator).toBe("opencode")
    expect(headers["Content-Type"]).toBe("application/json")

    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "a cat\n\nOutput image size — width: 1024px, height: 1536px.",
      background: "auto",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    })
  })

  test("posts an edits request when reference images are given", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))

    await callViaCodexImages(AUTH, ARGS, ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
    expect(JSON.parse(init.body as string)).toEqual({
      images: [{ image_url: "data:image/png;base64,AAA" }, { image_url: "data:image/jpeg;base64,BBB" }],
      prompt: "a cat",
      background: "auto",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    })
  })

  test("appends the size note to the prompt when size is given with reference images", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))

    await callViaCodexImages(AUTH, { ...ARGS, size: "2048x1152" }, ["data:image/png;base64,AAA"])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.prompt).toBe("a cat\n\nOutput image size — width: 2048px, height: 1152px.")
  })

  test("keeps the prompt unchanged when size is omitted", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))

    await callViaCodexImages(AUTH, ARGS, [])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.prompt).toBe("a cat")
  })

  test("keeps the prompt unchanged when size is auto", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))

    await callViaCodexImages(AUTH, { ...ARGS, size: "auto" }, [])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.prompt).toBe("a cat")
  })

  test("omits the ChatGPT-Account-ID header when accountId is absent", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))

    const auth = { type: "oauth", access: "tok" } as const
    await callViaCodexImages(auth, ARGS, [])

    expect(fetchMock.mock.calls[0][1].headers as Record<string, string>).not.toHaveProperty("ChatGPT-Account-ID")
  })

  test("throws when the response contains no image data", async () => {
    installFetch(async () => new Response(JSON.stringify({ created: 1, data: [] })))

    await expect(callViaCodexImages(AUTH, ARGS, [])).rejects.toThrow("image generation returned no image data")
  })

  test("throws when the returned base64 is an empty string", async () => {
    installFetch(async () => imageResponse(""))

    await expect(callViaCodexImages(AUTH, ARGS, [])).rejects.toThrow("image generation returned no image data")
  })

  test("throws when the response body is not valid JSON", async () => {
    installFetch(async () => new Response("not-json"))

    await expect(callViaCodexImages(AUTH, ARGS, [])).rejects.toThrow(
      "image generation failed: stream error: failed to decode image generation response",
    )
  })

  test("treats a missing data array as a decode failure", async () => {
    installFetch(async () => new Response(JSON.stringify({ created: 1 })))

    await expect(callViaCodexImages(AUTH, ARGS, [])).rejects.toThrow(
      "image generation failed: stream error: failed to decode image generation response: missing field `data`",
    )
  })

  test("treats a null data element as a decode failure", async () => {
    installFetch(async () => new Response(JSON.stringify({ created: 1, data: [null] })))

    await expect(callViaCodexImages(AUTH, ARGS, [])).rejects.toThrow(
      "image generation failed: stream error: failed to decode image generation response: missing field `b64_json`",
    )
  })

  test("includes the status reason phrase in the error when present", async () => {
    installFetch(async () => new Response("denied", { status: 403, statusText: "Forbidden" }))

    await expect(callViaCodexImages(AUTH, ARGS, [])).rejects.toThrow(
      "image generation failed: http 403 Forbidden: denied",
    )
  })

  test("throws with the status and body on 4xx without retrying", async () => {
    const fetchMock = installFetch(async () => new Response("bad request", { status: 400 }))

    await expect(callViaCodexImages(AUTH, ARGS, [])).rejects.toThrow("image generation failed: http 400: bad request")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("does not retry a 429 response", async () => {
    const fetchMock = installFetch(async () => new Response("slow down", { status: 429 }))

    await expect(callViaCodexImages(AUTH, ARGS, [])).rejects.toThrow("image generation failed: http 429: slow down")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("retries a 5xx response and returns the result of the retry", async () => {
    let calls = 0
    const fetchMock = installFetch(async () => {
      calls++
      return calls === 1 ? new Response("boom", { status: 500 }) : imageResponse("RETRIED")
    })

    expect(await callViaCodexImages(AUTH, ARGS, [], NO_DELAY)).toBe("RETRIED")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("retries a network error and returns the result of the retry", async () => {
    let calls = 0
    const fetchMock = installFetch(async () => {
      calls++
      if (calls === 1) throw new Error("socket hang up")
      return imageResponse("RETRIED")
    })

    expect(await callViaCodexImages(AUTH, ARGS, [], NO_DELAY)).toBe("RETRIED")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("gives up after 5 attempts when the server keeps returning 5xx", async () => {
    const fetchMock = installFetch(async () => new Response("boom", { status: 503 }))

    await expect(callViaCodexImages(AUTH, ARGS, [], NO_DELAY)).rejects.toThrow(
      "image generation failed: http 503: boom",
    )
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  test("wraps a persistent network error after the retries are exhausted", async () => {
    const fetchMock = installFetch(async () => {
      throw new Error("socket hang up")
    })

    await expect(callViaCodexImages(AUTH, ARGS, [], NO_DELAY)).rejects.toThrow(
      "image generation failed: socket hang up",
    )
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  test("propagates an abort without retrying or wrapping it", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = installFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError")
    })

    await expect(callViaCodexImages(AUTH, ARGS, [], { signal: controller.signal })).rejects.toThrow(
      "The operation was aborted.",
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("propagates an abort raised during the retry backoff without exhausting the retries", async () => {
    const controller = new AbortController()
    const fetchMock = installFetch(async () => new Response("boom", { status: 503 }))

    const promise = callViaCodexImages(AUTH, ARGS, [], { retryBaseDelayMs: 1_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)

    await expect(promise).rejects.toThrow("aborted")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
