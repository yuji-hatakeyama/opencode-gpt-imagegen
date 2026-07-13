import { setTimeout as delay } from "node:timers/promises"
import type { GenerateArgs, OpenAIAuth } from "./types"

// Codex backend base URL used for ChatGPT (subscription) auth.
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/model-provider-info/src/lib.rs#L38
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/model-provider-info/src/lib.rs#L241-L259
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/ext/image-generation/src/tool.rs#L57-L58
const IMAGE_MODEL = "gpt-image-2"
export const MAX_EDIT_IMAGES = 5

// The size argument grammar, shared with the tool schema in index.ts. The capture
// groups are what withSizeNote interprets, so acceptance and parsing cannot drift apart.
export const SIZE_ARG_PATTERN = /^(?:auto|(\d+)x(\d+))$/

// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/model-provider-info/src/lib.rs#L262-L268
const REQUEST_MAX_RETRIES = 4
const RETRY_BASE_DELAY_MS = 200

// Retry on 5xx and transport errors only (429 and other 4xx are not retried), like codex's
// run_with_retry; every fetch rejection is treated as a transport error and rethrown raw
// once the retries are exhausted — wrapping is the caller's job, as in codex. The backoff
// rejects on abort, matching codex where dropping the retry future cancels the wait.
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/codex-client/src/retry.rs#L23-L73
async function postWithRetry(url: string, init: RequestInit, baseDelayMs: number): Promise<Response> {
  // https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/codex-client/src/retry.rs#L38-L47
  const backoff = (attempt: number) =>
    delay(baseDelayMs * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2), undefined, {
      signal: init.signal ?? undefined,
    })
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (err) {
      if (init.signal?.aborted || attempt >= REQUEST_MAX_RETRIES) throw err
      await backoff(attempt + 1)
      continue
    }
    if (res.status >= 500 && attempt < REQUEST_MAX_RETRIES) {
      // Free the abandoned body so the keep-alive connection can be reused during the backoff.
      await res.body?.cancel().catch(() => {})
      await backoff(attempt + 1)
      continue
    }
    return res
  }
}

// The backend ignores the structured quality/size fields and derives both from the
// prompt (codex intentionally sends "auto" for everything: "uses automatic image
// parameters", https://github.com/openai/codex/pull/24723 — confirmed empirically
// 2026-07-13: explicit size/quality in the body have no effect, and quality wording
// in the prompt is ignored too, but dimensions written in the prompt are honored
// exactly). Restating WxH in the prompt is therefore the only working dimension control.
function withSizeNote(prompt: string, size?: string): string {
  const m = size?.match(SIZE_ARG_PATTERN)
  if (m?.[1] === undefined || m[2] === undefined) return prompt
  return `${prompt}\n\nOutput image size — width: ${m[1]}px, height: ${m[2]}px.`
}

type CallOptions = {
  // Injectable only so tests can skip the real backoff waits; production callers use the default.
  retryBaseDelayMs?: number
  signal?: AbortSignal
}

// Call the Codex backend images endpoint the way codex's image generation extension does:
// no reference images -> POST images/generations, otherwise POST images/edits.
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/codex-api/src/endpoint/images.rs#L33-L71
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/ext/image-generation/src/tool.rs#L259-L328
export async function callViaCodexImages(
  auth: OpenAIAuth,
  args: GenerateArgs,
  inputImageDataUrls: string[],
  opts: CallOptions = {},
): Promise<string> {
  // Body fields and their fixed "auto" values mirror codex's requests verbatim; the
  // requested size travels via withSizeNote instead (see above).
  // https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/codex-api/src/images.rs#L4-L53
  // https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/ext/image-generation/src/tool.rs#L270-L279
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

  // Auth headers mirror codex's BearerAuthProvider; codex additionally sends client
  // metadata (User-Agent, version, originator=codex_cli_rs) — this plugin identifies
  // itself as opencode instead.
  // https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/model-provider/src/bearer_auth_provider.rs#L32-L46
  // https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/login/src/auth/default_client.rs#L334-L350
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
      originator: "opencode",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  }

  // A single tool-layer wrap around the whole backend call, as in codex's tool.rs;
  // aborts (also possible mid body read) propagate as-is. The inner layers throw
  // codex's layer-native error strings.
  // https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/ext/image-generation/src/tool.rs#L152-L164
  let first: { b64_json?: string } | null | undefined
  try {
    first = await requestFirstImage(`${CODEX_BASE_URL}/${path}`, init, opts.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS)
  } catch (err) {
    if (opts.signal?.aborted) throw err
    throw new Error(`image generation failed: ${err instanceof Error ? err.message : err}`)
  }

  // Unlike codex, an empty string is also rejected: decoding it would write a 0-byte file.
  const b64 = first?.b64_json
  if (!b64) {
    throw new Error("image generation returned no image data")
  }
  return b64
}

// Executes the request and returns the first element of the response's `data` array.
// Errors carry codex's layer-native strings: TransportError::Http displays as
// "http {status}: {body:?}" (status includes the reason phrase) and decode failures as
// ApiError::Stream ("stream error: failed to decode ..."); a missing/invalid `data`
// array or a non-string element is a decode failure too (serde requires those fields).
// Deviation: the HTTP error body is raw text truncated to 500 chars, not Rust's Debug form.
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/http-client/src/error.rs#L9-L15
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/codex-api/src/endpoint/images.rs#L69-L70
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/codex-api/src/error.rs#L13-L14
async function requestFirstImage(
  url: string,
  init: RequestInit,
  baseDelayMs: number,
): Promise<{ b64_json?: string } | null | undefined> {
  const res = await postWithRetry(url, init, baseDelayMs)
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const status = res.statusText ? `${res.status} ${res.statusText}` : `${res.status}`
    throw new Error(`http ${status}: ${detail.slice(0, 500)}`)
  }

  const decodeError = (reason: unknown) =>
    new Error(`stream error: failed to decode image generation response: ${reason}`)
  let json: { data?: Array<{ b64_json?: string } | null> }
  try {
    json = (await res.json()) as typeof json
  } catch (err) {
    throw decodeError(err)
  }
  if (!Array.isArray(json.data)) throw decodeError("missing field `data`")
  const first = json.data[0]
  if (first !== undefined && typeof first?.b64_json !== "string") throw decodeError("missing field `b64_json`")
  return first
}
