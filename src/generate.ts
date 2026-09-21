import { loadOpenAIAuth } from "./auth"
import { callViaCodexResponses } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import type { GenerateArgs } from "./types"

export type GenerationResult = {
  message: string
  savedPath: string
  versioned: boolean
}

// Generation flow shared by the v1 and v2 tool entrypoints: resolve auth, read
// reference images, call the Codex backend, then save the PNG without
// overwriting. The abort signal is optional so v1 callers can omit it.
export async function generateImage(
  args: GenerateArgs,
  ctxDir: string,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const auth = await loadOpenAIAuth()
  if (!auth) {
    throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
  }

  const inputImageDataUrls = await readReferenceImages(args.images, ctxDir)
  const base64 = await callViaCodexResponses(auth, args, inputImageDataUrls, signal)

  const { savedPath, versioned, message } = await saveGeneratedImage(args.out, ctxDir, base64)
  return { message, savedPath, versioned }
}
