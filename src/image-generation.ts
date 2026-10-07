import { callViaCodexResponses } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import type { GenerateArgs, OpenAIAuth } from "./types"

export const IMAGE_TOOL_DESCRIPTION = [
  "Generate raster images using OpenAI's hosted image_generation tool.",
  "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
  "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
  "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
  "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
  "Requires OpenCode to be authenticated with Codex OAuth (Codex browser or device code in V2, not ChatGPT token sharing). Returns the absolute path of the saved PNG.",
].join(" ")

export const IMAGE_ARGUMENT_DESCRIPTIONS = {
  prompt: "Description of the image to generate.",
  out: "Output file path, relative to the session directory unless absolute. The plugin writes a PNG.",
  quality: "Generation quality passed to the hosted image_generation tool.",
  size: "Optional image size passed to the hosted image_generation tool. Use `auto` or `WIDTHxHEIGHT`; width and height must be multiples of 16px, max edge <= 3840px, long-to-short ratio <= 3:1, and total pixels between 655,360 and 8,294,400.",
  images: "Optional reference image paths, relative to the session directory unless absolute.",
}

export async function generateImage(
  auth: OpenAIAuth | undefined,
  args: GenerateArgs,
  directory: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  if (!auth) {
    throw new Error(
      "OpenAI Codex OAuth credentials not configured. Connect OpenAI using Codex browser or device code in OpenCode V2.",
    )
  }

  const inputImageDataUrls = await readReferenceImages(args.images, directory)
  signal?.throwIfAborted()
  const base64 = await callViaCodexResponses(auth, args, inputImageDataUrls, signal)
  signal?.throwIfAborted()
  const { savedPath, versioned, message } = await saveGeneratedImage(args.out, directory, base64)

  return {
    content: message,
    metadata: { out: savedPath, versioned, billing: "subscription" },
  }
}
