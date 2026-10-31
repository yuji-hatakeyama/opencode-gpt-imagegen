import { appendSizeToPrompt } from "./size"
import type { GenerateArgs, OpenAIAuth } from "./types"

// Codex OAuth images endpoint URLs. Codex calls edits when reference images are given.
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/model-provider-info/src/lib.rs#L80
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/codex-api/src/endpoint/images.rs#L62-L83
const CODEX_IMAGES_BASE_URL = "https://chatgpt.com/backend-api/codex"

// Same body as Codex. The backend appears to ignore model, quality, and size, and honors only background.
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/src/tool.rs#L414-L440
// https://github.com/yuji-hatakeyama/opencode-gpt-imagegen/issues/107#issuecomment-6020014602
const CODEX_REQUEST_DEFAULTS = { model: "gpt-image-2", quality: "auto", size: "auto" }

type CodexImagesResponse = { data?: Array<{ b64_json?: string }> }

// Where the images endpoints live and which credentials go with them.
export type CodexImagesTarget = { baseURL: string; headers: Record<string, string> }

export function chatGptImagesTarget(auth: OpenAIAuth): CodexImagesTarget {
  return {
    baseURL: CODEX_IMAGES_BASE_URL,
    headers: {
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
    },
  }
}

// A proxy that serves the same endpoints holds the ChatGPT credentials itself, so none are sent to it.
export function proxyImagesTarget(baseURL: string): CodexImagesTarget {
  return { baseURL, headers: {} }
}

function imagesEndpoint(baseURL: string, operation: "generations" | "edits"): string {
  return new URL(`images/${operation}`, baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString()
}

export async function callViaCodexImages(
  target: CodexImagesTarget,
  args: GenerateArgs,
  inputImageDataUrls: string[],
  signal?: AbortSignal,
): Promise<string> {
  const isEdit = inputImageDataUrls.length > 0
  const body = {
    prompt: appendSizeToPrompt(args.prompt, args.size),
    ...CODEX_REQUEST_DEFAULTS,
    background: args.background ?? "opaque",
    ...(isEdit ? { images: inputImageDataUrls.map((dataUrl) => ({ image_url: dataUrl })) } : {}),
  }

  const res = await fetch(imagesEndpoint(target.baseURL, isEdit ? "edits" : "generations"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...target.headers,
      originator: "opencode",
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`codex images request failed: ${res.status} ${detail.slice(0, 500)}`)
  }
  const image = ((await res.json()) as CodexImagesResponse).data?.[0]?.b64_json
  // Reject an empty image too: decoding it would write a 0-byte file and report success.
  if (!image) {
    throw new Error("no image returned by codex images endpoint")
  }
  return image
}
