import { setTimeout as delay } from "node:timers/promises"
import type { GenerateArgs, OpenAIAuth } from "./types"

// Codex backend base URL used for ChatGPT (subscription) auth.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L43
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L349-L366
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L58-L59
const IMAGE_MODEL = "gpt-image-2"
export const MAX_EDIT_IMAGES = 5

// The size argument grammar, shared with the tool schema in index.ts. The capture
// groups are what withSizeNote interprets, so acceptance and parsing cannot drift apart.
export const SIZE_ARG_PATTERN = /^(?:auto|(\d+)x(\d+))$/

// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L31
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L371-L377
const REQUEST_MAX_RETRIES = 4
const RETRY_BASE_DELAY_MS = 200

// Retry on 5xx and transport errors only (429 and other 4xx are not retried), like codex's
// run_with_retry; every fetch rejection is treated as a transport error and rethrown raw
// once the retries are exhausted — wrapping is the caller's job, as in codex. The backoff
// rejects on abort, matching codex where dropping the retry future cancels the wait.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-client/src/retry.rs#L22-L48
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-client/src/retry.rs#L80-L107
async function postWithRetry(url: string, init: RequestInit, baseDelayMs: number): Promise<Response> {
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-client/src/retry.rs#L39-L48
  const backoff = (attempt: number) =>
    delay(baseDelayMs * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2), undefined, {
      signal: init.signal ?? undefined,
    })
  for (let attempt = 1; ; attempt++) {
    const retriesLeft = attempt <= REQUEST_MAX_RETRIES
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (err) {
      if (init.signal?.aborted || !retriesLeft) throw err
      await backoff(attempt)
      continue
    }
    if (res.status >= 500 && retriesLeft) {
      // Free the abandoned body so the keep-alive connection can be reused during the backoff.
      await res.body?.cancel().catch(() => {})
      await backoff(attempt)
      continue
    }
    return res
  }
}

// The backend ignores the structured quality/size fields and derives both from the
// prompt (codex intentionally sends "auto" for everything: "uses automatic image
// parameters", https://github.com/openai/codex/pull/24723 — confirmed empirically on
// 2026-07-13 and 2026-09-10, see docs/adr/0001-port-codex-images-endpoint.md: explicit
// size in the body has no effect, while dimensions written in the prompt are honored
// exactly). Restating WxH in the prompt is therefore the only working dimension control.
function withSizeNote(prompt: string, size?: string): string {
  const [, width, height] = size?.match(SIZE_ARG_PATTERN) ?? []
  if (!width || !height) return prompt
  return `${prompt}\n\nOutput image size — width: ${width}px, height: ${height}px.`
}

type CallOptions = {
  // Sent as x-codex-image-turn-id; codex uses its turn id, this plugin the OpenCode message id.
  turnId: string
  signal?: AbortSignal
  // Injectable only so tests can skip the real backoff waits; production callers use the default.
  retryBaseDelayMs?: number
}

// Call the Codex backend images endpoint the way codex's image generation extension does:
// no reference images -> POST images/generations, otherwise POST images/edits.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/endpoint/images.rs#L35-L55
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L419-L488
export async function callViaCodexImages(
  auth: OpenAIAuth,
  args: Pick<GenerateArgs, "prompt" | "size">,
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
  const [path, body] =
    inputImageDataUrls.length === 0
      ? (["images/generations", generation] as const)
      : (["images/edits", { images: inputImageDataUrls.map((u) => ({ image_url: u })), ...generation }] as const)

  // Auth headers mirror codex's BearerAuthProvider, the turn id header its image backend.
  // codex additionally sends client metadata (User-Agent, originator=codex_cli_rs) —
  // this plugin identifies itself as opencode instead.
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

  // A single tool-layer wrap around the whole backend call, as in codex's tool.rs;
  // aborts (also possible mid body read) propagate as-is. The inner layers throw
  // codex's layer-native error strings.
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L172-L177
  let b64: string | undefined
  try {
    const res = await postWithRetry(`${CODEX_BASE_URL}/${path}`, init, opts.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS)
    b64 = await decodeFirstImage(res)
  } catch (err) {
    if (opts.signal?.aborted) throw err
    throw new Error(`image generation failed: ${err instanceof Error ? err.message : err}`)
  }

  // Unlike codex, an empty string is also rejected: decoding it would write a 0-byte file.
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L185-L197
  if (!b64) {
    throw new Error("image generation returned no image data")
  }
  return b64
}

// Returns the base64 of the first element of the response's `data` array, or undefined
// when the array is empty. Errors carry codex's layer-native strings: TransportError::Http
// displays as "http {status}: {body:?}" (status includes the reason phrase) and decode
// failures as ApiError::Stream ("stream error: failed to decode ..."); a missing `data`
// array or an element without a string `b64_json` is a decode failure too (serde requires
// those fields).
// Deviation: the HTTP error body is raw text truncated to 500 chars, not Rust's Debug form.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/http-client/src/transport.rs#L114-L131
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/http-client/src/error.rs#L10
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/endpoint/images.rs#L77-L78
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/images.rs#L55-L72
async function decodeFirstImage(res: Response): Promise<string | undefined> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const status = res.statusText ? `${res.status} ${res.statusText}` : `${res.status}`
    throw new Error(`http ${status}: ${detail.slice(0, 500)}`)
  }

  const decodeError = (reason: unknown) =>
    new Error(`stream error: failed to decode image generation response: ${reason}`)
  let json: { data?: Array<{ b64_json?: unknown } | null> }
  try {
    json = (await res.json()) as typeof json
  } catch (err) {
    throw decodeError(err)
  }
  if (!Array.isArray(json.data)) throw decodeError("missing field `data`")
  const first = json.data[0]
  if (first === undefined) return undefined
  if (typeof first?.b64_json !== "string") throw decodeError("missing field `b64_json`")
  return first.b64_json
}
