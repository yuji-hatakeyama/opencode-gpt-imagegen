import { EventSourceParserStream } from "eventsource-parser/stream"
import type { GenerateArgs, OpenAIAuth } from "./types"

// Codex OAuth responses endpoint URL.
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/model-provider-info/src/lib.rs#L37
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/core/src/client.rs#L146
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"

// Codex model slug used for the hosted image_generation turn.
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/models-manager/models.json#L24
const SUBSCRIPTION_MODEL = "gpt-5.5"

type CodexSSEEvent = {
  type?: string
  item?: { type?: string; result?: string }
}

export async function parseImageGenerationResultFromSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const events = (stream as unknown as ReadableStream<BufferSource>)
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
  for await (const event of events) {
    if (event.data === "[DONE]") continue
    try {
      const json = JSON.parse(event.data) as CodexSSEEvent
      if (
        json.type === "response.output_item.done" &&
        json.item?.type === "image_generation_call" &&
        typeof json.item.result === "string" &&
        // Reject an empty result: decoding it would write a 0-byte file and report success.
        json.item.result.length > 0
      ) {
        return json.item.result
      }
    } catch {
      // SSE keepalive or non-JSON heartbeat
    }
  }
  throw new Error("no image_generation result returned by codex backend")
}

export async function callViaCodexResponses(
  auth: OpenAIAuth,
  args: GenerateArgs,
  inputImageDataUrls: string[],
): Promise<string> {
  const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: args.prompt }]
  for (const dataUrl of inputImageDataUrls) {
    userContent.push({ type: "input_image", image_url: dataUrl })
  }

  // https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/core/src/client.rs#L745-L763
  const body: Record<string, unknown> = {
    model: SUBSCRIPTION_MODEL,
    instructions:
      "You are an image generation assistant running inside the Codex backend. " +
      "Always satisfy the request by invoking the image_generation tool exactly once. " +
      "Do not respond with text only.",
    input: [{ role: "user", content: userContent }],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
        quality: args.quality,
        ...(args.size ? { size: args.size } : {}),
      },
    ],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  }

  const res = await fetch(CODEX_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      originator: "opencode",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "")
    throw new Error(`codex responses request failed: ${res.status} ${detail.slice(0, 500)}`)
  }
  return parseImageGenerationResultFromSSE(res.body)
}
