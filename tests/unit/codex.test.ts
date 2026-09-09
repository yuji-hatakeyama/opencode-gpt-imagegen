import { afterEach, describe, expect, mock, test } from "bun:test"
import { callViaCodexImages, postWithRetry } from "../../src/codex"

function imageResponse(b64: string): Response {
  return new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }))
}

function installFetch(handler: () => Promise<Response>) {
  const fetchMock = mock(async (_url: string, _init: RequestInit) => handler())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function sentBody(fetchMock: ReturnType<typeof installFetch>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string)
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("postWithRetry", () => {
  const ENDPOINT = "https://example.test/images"

  // Retries are exercised with a zero base delay so the suite does not sleep for real.
  test("retries a 5xx response and returns the response of the retry", async () => {
    const fetchMock = installFetch(async () => new Response("ok"))
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))

    const res = await postWithRetry(ENDPOINT, {}, 0)

    expect(await res.text()).toBe("ok")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("retries a network error and returns the response of the retry", async () => {
    const fetchMock = installFetch(async () => new Response("ok"))
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"))

    const res = await postWithRetry(ENDPOINT, {}, 0)

    expect(await res.text()).toBe("ok")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("returns the last 5xx response after 5 attempts", async () => {
    const fetchMock = installFetch(async () => new Response("boom", { status: 503 }))

    const res = await postWithRetry(ENDPOINT, {}, 0)

    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  test("rethrows a persistent network error unwrapped after 5 attempts", async () => {
    const fetchMock = installFetch(async () => {
      throw new Error("socket hang up")
    })

    await expect(postWithRetry(ENDPOINT, {}, 0)).rejects.toThrow("socket hang up")
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  test("retries when the connection drops while reading the body", async () => {
    const fetchMock = installFetch(async () => new Response("ok"))
    const droppedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket closed"))
      },
    })
    fetchMock.mockResolvedValueOnce(new Response(droppedBody))

    const res = await postWithRetry(ENDPOINT, {}, 0)

    expect(await res.text()).toBe("ok")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("rejects an invalid header value without calling fetch or echoing the value", async () => {
    const fetchMock = installFetch(async () => new Response("ok"))
    const token = "secret-token"

    const promise = postWithRetry(ENDPOINT, { headers: { Authorization: `Bearer ${token}\r\nX: y` } }, 0)

    await expect(promise).rejects.toThrow("invalid request header value")
    await expect(promise).rejects.not.toThrow(token)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test("does not retry a 429 response", async () => {
    const fetchMock = installFetch(async () => new Response("slow down", { status: 429 }))

    const res = await postWithRetry(ENDPOINT, {}, 0)

    expect(res.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("rejects with the AbortError when aborted during the backoff", async () => {
    const controller = new AbortController()
    const fetchMock = installFetch(async () => new Response("boom", { status: 503 }))

    const promise = postWithRetry(ENDPOINT, { signal: controller.signal }, 1_000)
    setTimeout(() => controller.abort(), 20)

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("callViaCodexImages", () => {
  const AUTH = { type: "oauth", access: "tok", accountId: "acct" } as const
  const ARGS = { prompt: "a cat" }
  const TURN = { turnId: "msg_1" }
  // The fixed part of every request body; codex sends these values verbatim.
  const GENERATION_BODY = { background: "auto", model: "gpt-image-2", quality: "auto", size: "auto" }

  test("posts a generations request and returns the first image's base64", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))
    const width = 1024
    const height = 1536

    const result = await callViaCodexImages(AUTH, { ...ARGS, size: `${width}x${height}` }, [], TURN)

    expect(result).toBe("B64")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(init.method).toBe("POST")

    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${AUTH.access}`)
    expect(headers["ChatGPT-Account-ID"]).toBe(AUTH.accountId)
    expect(headers.originator).toBe("opencode")
    expect(headers["x-codex-image-turn-id"]).toBe(TURN.turnId)
    expect(headers["Content-Type"]).toBe("application/json")

    expect(sentBody(fetchMock)).toEqual({
      prompt: `${ARGS.prompt}\n\nOutput image size — width: ${width}px, height: ${height}px.`,
      ...GENERATION_BODY,
    })
  })

  test("posts an edits request when reference images are given", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))
    const refs = ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"]

    await callViaCodexImages(AUTH, ARGS, refs, TURN)

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
    expect(sentBody(fetchMock)).toEqual({
      images: refs.map((image_url) => ({ image_url })),
      prompt: ARGS.prompt,
      ...GENERATION_BODY,
    })
  })

  for (const { name, size } of [
    { name: "omitted", size: undefined },
    { name: "auto", size: "auto" },
  ]) {
    test(`keeps the prompt unchanged when size is ${name}`, async () => {
      const fetchMock = installFetch(async () => imageResponse("B64"))

      await callViaCodexImages(AUTH, { ...ARGS, size }, [], TURN)

      expect(sentBody(fetchMock).prompt).toBe(ARGS.prompt)
    })
  }

  test("omits the ChatGPT-Account-ID header when accountId is absent", async () => {
    const fetchMock = installFetch(async () => imageResponse("B64"))

    await callViaCodexImages({ type: "oauth", access: AUTH.access }, ARGS, [], TURN)

    expect(fetchMock.mock.calls[0][1].headers as Record<string, string>).not.toHaveProperty("ChatGPT-Account-ID")
  })

  for (const { name, body } of [
    { name: "an empty data array", body: JSON.stringify({ created: 1, data: [] }) },
    { name: "an empty-string b64_json", body: JSON.stringify({ created: 1, data: [{ b64_json: "" }] }) },
  ]) {
    test(`throws "no image data" on ${name}`, async () => {
      installFetch(async () => new Response(body))

      await expect(callViaCodexImages(AUTH, ARGS, [], TURN)).rejects.toThrow("image generation returned no image data")
    })
  }

  for (const { name, body, reason } of [
    { name: "a non-JSON body", body: "not-json", reason: "" },
    { name: "a missing data array", body: JSON.stringify({ created: 1 }), reason: ": missing field `data`" },
    {
      name: "a data element without b64_json",
      body: JSON.stringify({ created: 1, data: [{ generation_id: "g1" }] }),
      reason: ": missing field `b64_json`",
    },
  ]) {
    test(`treats ${name} as a decode failure`, async () => {
      installFetch(async () => new Response(body))

      await expect(callViaCodexImages(AUTH, ARGS, [], TURN)).rejects.toThrow(
        `image generation failed: failed to decode image generation response${reason}`,
      )
    })
  }

  test("includes the status reason phrase in the error when present", async () => {
    installFetch(async () => new Response("denied", { status: 403, statusText: "Forbidden" }))

    await expect(callViaCodexImages(AUTH, ARGS, [], TURN)).rejects.toThrow(
      "image generation failed: http 403 Forbidden: denied",
    )
  })

  test("wraps a non-retryable HTTP error with its status and body", async () => {
    const fetchMock = installFetch(async () => new Response("bad request", { status: 400 }))

    await expect(callViaCodexImages(AUTH, ARGS, [], TURN)).rejects.toThrow(
      "image generation failed: http 400: bad request",
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("propagates an abort raised before the response as the signal's reason", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = installFetch(async () => {
      throw controller.signal.reason
    })

    await expect(callViaCodexImages(AUTH, ARGS, [], { ...TURN, signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("propagates an abort raised while reading the body as the signal's reason", async () => {
    const controller = new AbortController()
    // A body whose read aborts the call mid-stream, as a cancelled fetch would.
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        controller.abort()
        streamController.error(controller.signal.reason)
      },
    })
    installFetch(async () => new Response(body))

    const rejection = await callViaCodexImages(AUTH, ARGS, [], { ...TURN, signal: controller.signal }).catch((e) => e)

    expect(rejection).toBe(controller.signal.reason)
  })

  test("propagates an abort raised during the retry backoff as the signal's reason, not the timer's", async () => {
    const controller = new AbortController()
    installFetch(async () => new Response("boom", { status: 503 }))

    const promise = callViaCodexImages(AUTH, ARGS, [], { ...TURN, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)

    expect(await promise.catch((e) => e)).toBe(controller.signal.reason)
  })
})
