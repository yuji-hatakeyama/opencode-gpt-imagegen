import { setTimeout as delay } from "node:timers/promises"
import type { OpenAIAuth } from "./types"

// Codex backend base URL used for ChatGPT (subscription) auth.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L43
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L349-L366
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L58-L59
const IMAGE_MODEL = "gpt-image-2"
export const MAX_EDIT_IMAGES = 5

// The size argument grammar, enforced by the tool schema in index.ts. The capture groups
// are what withSizeNote interprets, so acceptance and parsing cannot drift apart.
export const SIZE_ARG_PATTERN = /^(?:auto|([1-9]\d*)x([1-9]\d*))$/

// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L31
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L371-L377
const REQUEST_MAX_RETRIES = 4
const RETRY_BASE_DELAY_MS = 200

// Retry on 5xx and transport errors only (429 and other 4xx are not retried), like codex's
// run_with_retry; every fetch rejection is treated as a transport error (ADR 0001 #8) and
// rethrown raw once the retries are exhausted — wrapping is the caller's job, as in codex.
// The backoff rejects on abort, matching codex where dropping the retry future cancels the wait.
// baseDelayMs is overridable only so tests can skip the real backoff waits.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-client/src/retry.rs#L22-L48
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-client/src/retry.rs#L80-L107
export async function postWithRetry(
  url: string,
  init: RequestInit,
  baseDelayMs = RETRY_BASE_DELAY_MS,
): Promise<Response> {
  // fetch rejects on an invalid header value (an embedded CR/LF or non-Latin1 byte in the
  // token) the same way it rejects on a network failure, so it would be retried; validating
  // once up front fails fast. The runtime's message echoes the header value, so it is replaced.
  try {
    new Headers(init.headers)
  } catch {
    throw new Error("invalid request header value")
  }
  for (let attempt = 1; ; attempt++) {
    const retriesLeft = attempt <= REQUEST_MAX_RETRIES
    try {
      const res = await fetch(url, init)
      if (res.status < 500 || !retriesLeft) {
        // Read the body inside the retried scope, as codex's transport does, so a connection
        // dropped mid-body is retried too. The buffered copy keeps status/statusText/headers.
        // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/http-client/src/transport.rs#L114-L137
        return new Response(await res.arrayBuffer(), res)
      }
      // Free the abandoned body so the keep-alive connection can be reused during the backoff.
      await res.body?.cancel().catch(() => {})
    } catch (err) {
      if (init.signal?.aborted || !retriesLeft) throw err
    }
    // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-client/src/retry.rs#L39-L48
    await delay(baseDelayMs * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2), undefined, {
      signal: init.signal ?? undefined,
    })
  }
}

// The backend ignores the structured size field and honors dimensions written in the
// prompt (ADR 0001 #2), so a WIDTHxHEIGHT size is restated there; "auto" adds nothing.
// Observed 2026-09-10: exact on images/generations, aspect ratio only on images/edits.
function withSizeNote(prompt: string, size?: string): string {
  const [, width, height] = size?.match(SIZE_ARG_PATTERN) ?? []
  if (!width || !height) return prompt
  return `${prompt}\n\nOutput image size — width: ${width}px, height: ${height}px.`
}

type CallOptions = {
  // Sent as x-codex-image-turn-id; codex uses its turn id, this plugin the OpenCode message id.
  turnId: string
  signal?: AbortSignal
}

// Call the Codex backend images endpoint the way codex's image generation extension does:
// no reference images -> POST images/generations, otherwise POST images/edits.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/endpoint/images.rs#L35-L55
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L419-L488
export async function callViaCodexImages(
  auth: OpenAIAuth,
  args: { prompt: string; size?: string },
  inputImageDataUrls: string[],
  opts: CallOptions,
): Promise<string> {
  // Body fields and their fixed "auto" values mirror codex's requests verbatim; the
  // requested size travels via withSizeNote instead (see above).
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/images.rs#L4-L31
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L432-L439
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L479-L487
  const generation = {
    prompt: withSizeNote(args.prompt, args.size),
    background: "auto",
    model: IMAGE_MODEL,
    quality: "auto",
    size: "auto",
  }
  const edits = inputImageDataUrls.length > 0
  const path = edits ? "images/edits" : "images/generations"
  const body = edits ? { images: inputImageDataUrls.map((u) => ({ image_url: u })), ...generation } : generation

  // Auth headers mirror codex's BearerAuthProvider, the turn id header its image backend.
  // codex additionally sends client metadata (User-Agent, originator=codex_cli_rs) —
  // this plugin identifies itself as opencode instead (ADR 0001 #1).
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider/src/bearer_auth_provider.rs#L32-L46
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/backend.rs#L113-L122
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/login/src/auth/default_client.rs#L40
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
      originator: "opencode",
      "x-codex-image-turn-id": opts.turnId,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  }

  // A single tool-layer wrap around the whole backend call, as in codex's tool.rs. An
  // abort surfaces as the signal's own AbortError even when it interrupted the body read,
  // where the inner layers would already have wrapped it.
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L172-L177
  let b64: string | undefined
  try {
    b64 = await readImageResponse(await postWithRetry(`${CODEX_BASE_URL}/${path}`, init))
  } catch (err) {
    opts.signal?.throwIfAborted()
    throw new Error(`image generation failed: ${err instanceof Error ? err.message : err}`)
  }

  // Unlike codex, an empty string is also rejected: decoding it would write a 0-byte file (ADR 0001 #7).
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L185-L197
  if (!b64) {
    throw new Error("image generation returned no image data")
  }
  return b64
}

// Maps a non-2xx response to an error, otherwise returns the base64 of the first element of
// the response's `data` array (undefined when the array is empty). Error strings are codex's
// layer-native ones (ADR 0001 #5); the missing-field reasons use serde's wording because
// `data` and `b64_json` are required in codex's types.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/http-client/src/transport.rs#L114-L131
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/http-client/src/error.rs#L10
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/endpoint/images.rs#L77-L78
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/images.rs#L55-L72
async function readImageResponse(res: Response): Promise<string | undefined> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const status = res.statusText ? `${res.status} ${res.statusText}` : `${res.status}`
    throw new Error(`http ${status}: ${detail.slice(0, 500)}`)
  }

  const decodeError = (reason: unknown) =>
    new Error(`failed to decode image generation response: ${reason instanceof Error ? reason.message : reason}`)
  const json: { data?: Array<{ b64_json?: unknown } | null> } | null = await res.json().catch((err: unknown) => {
    throw decodeError(err)
  })
  if (!Array.isArray(json?.data)) throw decodeError("missing field `data`")
  const first = json.data[0]
  if (first === undefined) return undefined
  if (typeof first?.b64_json !== "string") throw decodeError("missing field `b64_json`")
  return first.b64_json
}
