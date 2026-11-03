import { z } from "zod"
import { type CodexImagesTarget, callViaCodexImages, chatGptImagesTarget, proxyImagesTarget } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import { IMAGE_SIZES, type ImageSize, SIZE_CHOICES } from "./size"
import type { ImagegenResult, LoadOpenAIAuth } from "./types"

// https://developers.openai.com/api/docs/guides/image-generation
const argsShape = {
  prompt: z.string().describe("Description of the image to generate."),
  out: z
    .string()
    .describe("Output file path, relative to the project directory unless absolute. The plugin writes a PNG."),
  size: z
    .enum(Object.keys(IMAGE_SIZES) as [ImageSize, ...ImageSize[]], {
      error: (issue) =>
        issue.input == null
          ? `Missing size. Use one of: ${SIZE_CHOICES}.`
          : `Unsupported size "${issue.input}". Use one of: ${SIZE_CHOICES}.`,
    })
    .describe(
      [
        `Output size. Only these sizes can be generated: ${SIZE_CHOICES}.`,
        "Typical choices: 1672x941 for a 16:9 video thumbnail, 1254x1254 for a square icon, 941x1672 for a phone wallpaper.",
      ].join(" "),
    ),
  // Same limit as Codex (MAX_EDIT_IMAGES).
  // https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/src/tool.rs#L59
  images: z
    .array(z.string())
    .max(5)
    .nullish()
    .describe("Optional reference image paths, up to 5, relative to the project directory unless absolute."),
  // https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/imagegen_description.md?plain=1#L9
  background: z
    .enum(["opaque", "transparent"])
    .nullish()
    .describe(
      [
        "Optional background of the output image. Defaults to `opaque`.",
        "Use `transparent` when the request calls for a transparent background, including background removal or a cutout.",
        "When editing reference images, preserve their existing transparency unless the user asks to change it.",
      ].join(" "),
    ),
}

// Some OpenCode versions (e.g. 1.18.34) do not validate plugin tool arguments before calling execute,
// so execute validates them against the same schema.
const argsSchema = z.object(argsShape)

// `baseURL` sends requests to a proxy serving the Codex images endpoints instead of ChatGPT itself.
// A query or fragment would make the endpoint URL resolution drop the last path segment of baseURL.
const optionsSchema = z.object({
  baseURL: z
    .url({ protocol: /^https?$/ })
    .refine((value) => {
      const url = new URL(value)
      return url.search === "" && url.hash === ""
    }, "baseURL must not have a query or a fragment")
    .optional(),
})

async function resolveImagesTarget(
  options: Record<string, unknown> | undefined,
  loadOpenAIAuth: LoadOpenAIAuth,
): Promise<CodexImagesTarget> {
  const parsed = optionsSchema.safeParse(options ?? {})
  if (!parsed.success) {
    throw new Error(`invalid opencode-gpt-imagegen options: ${z.prettifyError(parsed.error)}`)
  }
  if (parsed.data.baseURL) {
    return proxyImagesTarget(parsed.data.baseURL)
  }
  const auth = await loadOpenAIAuth()
  if (!auth) {
    throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
  }
  return chatGptImagesTarget(auth)
}

export type ImagegenTool = {
  description: string
  schema: typeof argsSchema
  execute(input: unknown, directory: string, signal?: AbortSignal): Promise<ImagegenResult>
}

export function createImagegenTool(
  options: Record<string, unknown> | undefined,
  loadOpenAIAuth: LoadOpenAIAuth,
): ImagegenTool {
  const authNote = options?.baseURL
    ? "Sends requests to the proxy set by the plugin's `baseURL` option instead of ChatGPT, so ChatGPT OAuth is not used."
    : "Requires OpenCode to be authenticated with ChatGPT OAuth."
  return {
    description: [
      "Generate raster images through the image generation endpoints of the ChatGPT Codex backend.",
      "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
      "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
      "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
      "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
      `${authNote} Returns the absolute path of the saved PNG.`,
      "Before generating, decide the size. If the user named a size that is not supported, or gave no size and the use does not clearly imply a shape, ask the user which size to use (with the question tool when available).",
      "In that question, offer every supported size as an option labeled like `1672x941 (16:9)`, put the one you recommend first with ` (Recommended)` appended to its label, and give each option a short description of what it suits.",
      "Do not add catch-all options such as 'Other' or 'Let me decide'.",
      "In the question text, say that other sizes cannot be generated directly and that the image can be resized or cropped to an exact size afterwards, for example with ImageMagick.",
      "If the use clearly implies a shape, such as a YouTube thumbnail or an app icon, pick the matching size without asking.",
      "The saved image can differ from the requested size by 1px, so do not promise exact pixel dimensions before generating. After generating, tell the user the size reported in the tool result.",
    ].join(" "),
    schema: argsSchema,
    async execute(input, directory, signal) {
      const parsed = argsSchema.safeParse(input)
      if (!parsed.success) {
        throw new Error(z.prettifyError(parsed.error))
      }
      const args = parsed.data
      const target = await resolveImagesTarget(options, loadOpenAIAuth)

      const inputImageDataUrls = await readReferenceImages(args.images, directory)
      const base64 = await callViaCodexImages(target, args, inputImageDataUrls, signal)

      return saveGeneratedImage(args.out, directory, base64)
    },
  }
}
