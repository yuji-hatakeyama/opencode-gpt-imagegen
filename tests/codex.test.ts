import { afterEach, describe, expect, mock, test } from "bun:test"
import { callViaCodexResponses, parseImageGenerationResultFromSSE } from "../src/codex"
import type { GenerateArgs } from "../src/types"

// Build a ReadableStream that emits the given raw SSE text, as the fetch body would.
function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function dataEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const imageDoneEvent = (result: string) =>
  dataEvent({ type: "response.output_item.done", item: { type: "image_generation_call", result } })

describe("parseImageGenerationResultFromSSE", () => {
  test("returns the result of the image_generation_call done event", async () => {
    const stream = sseStream(imageDoneEvent("BASE64IMAGE"))
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("BASE64IMAGE")
  })

  test("skips the [DONE] sentinel and unrelated events before the result", async () => {
    const stream = sseStream(
      dataEvent({ type: "response.created" }),
      dataEvent({ type: "response.output_item.done", item: { type: "reasoning" } }),
      imageDoneEvent("RESULT"),
      "data: [DONE]\n\n",
    )
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("ignores non-JSON heartbeat lines", async () => {
    const stream = sseStream("data: ping\n\n", imageDoneEvent("RESULT"))
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("ignores a done event whose item is not an image_generation_call", async () => {
    const stream = sseStream(
      dataEvent({ type: "response.output_item.done", item: { type: "message", result: "not-an-image" } }),
      imageDoneEvent("RESULT"),
    )
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("ignores an image_generation_call whose result is not a string", async () => {
    const stream = sseStream(
      dataEvent({ type: "response.output_item.done", item: { type: "image_generation_call", result: 123 } }),
      imageDoneEvent("RESULT"),
    )
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("throws when the stream contains no image_generation result", async () => {
    const stream = sseStream(dataEvent({ type: "response.created" }), "data: [DONE]\n\n")
    expect(parseImageGenerationResultFromSSE(stream)).rejects.toThrow(
      "no image_generation result returned by codex backend",
    )
  })
})

describe("callViaCodexResponses", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("posts the request to the codex endpoint and returns the parsed result", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response(imageDoneEvent("PARSED")))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const auth = { type: "oauth", access: "tok", accountId: "acct" } as const
    const args: GenerateArgs = { prompt: "a cat", out: "cat.png", quality: "high", size: "1024x1024" }
    const result = await callViaCodexResponses(auth, args, ["data:image/png;base64,AAA"])

    expect(result).toBe("PARSED")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(init.method).toBe("POST")

    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer tok")
    expect(headers["ChatGPT-Account-Id"]).toBe("acct")
    expect(headers.originator).toBe("opencode")
    expect(headers.Accept).toBe("text/event-stream")
    expect(headers["Content-Type"]).toBe("application/json")

    const body = JSON.parse(init.body as string)
    expect(body.model).toBe("gpt-5.5")
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    // The instruction is load-bearing: it forces the backend to emit an image, not text.
    expect(body.instructions).toContain("image_generation")
    expect(body.tool_choice).toEqual({ type: "image_generation" })
    expect(body.tools[0]).toEqual({
      type: "image_generation",
      output_format: "png",
      quality: "high",
      size: "1024x1024",
    })
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "a cat" },
      { type: "input_image", image_url: "data:image/png;base64,AAA" },
    ])
  })

  test("omits optional fields when size, accountId, and reference images are absent", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response(imageDoneEvent("PARSED")))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const auth = { type: "oauth", access: "tok" } as const
    const args: GenerateArgs = { prompt: "a cat", out: "cat.png", quality: "auto" }
    await callViaCodexResponses(auth, args, [])

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers as Record<string, string>).not.toHaveProperty("ChatGPT-Account-Id")
    const body = JSON.parse(init.body as string)
    expect(body.tools[0]).not.toHaveProperty("size")
    expect(body.input[0].content).toEqual([{ type: "input_text", text: "a cat" }])
  })

  test("throws with the status and response body when the request fails", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response("upstream boom", { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const auth = { type: "oauth", access: "tok" } as const
    const args: GenerateArgs = { prompt: "a cat", out: "cat.png", quality: "auto" }
    expect(callViaCodexResponses(auth, args, [])).rejects.toThrow("codex responses request failed: 500 upstream boom")
  })
})
