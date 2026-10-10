import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadOpenAIAuth } from "./auth"
import { callViaCodexResponses } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import { IMAGE_SIZES, type ImageSize, parseImageSize, SIZE_CHOICES } from "./size"

const GptImagePlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  return {
    tool: {
      gpt_imagegen: tool({
        description: [
          "Generate raster images using OpenAI's hosted image_generation tool.",
          "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
          "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
          "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
          "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
          "Requires OpenCode to be authenticated with ChatGPT OAuth. Returns the absolute path of the saved PNG.",
          "Before generating, decide the size. If the user named a size that is not supported, or gave no size and the use does not clearly imply a shape, ask the user which size to use (with the question tool when available).",
          "In that question, offer every supported size as an option labeled like `1672x941 (16:9)`, put the one you recommend first with ` (Recommended)` appended to its label, and give each option a short description of what it suits.",
          "Do not add catch-all options such as 'Other' or 'Let me decide'.",
          "In the question text, say that other sizes cannot be generated directly and that the image can be resized or cropped to an exact size afterwards, for example with ImageMagick.",
          "If the use clearly implies a shape, such as a YouTube thumbnail or an app icon, pick the matching size without asking.",
          "The saved image can differ from the requested size by 1px, so do not promise exact pixel dimensions before generating. After generating, tell the user the size reported in the tool result.",
        ].join(" "),
        // https://developers.openai.com/api/docs/guides/image-generation
        args: {
          prompt: tool.schema.string().describe("Description of the image to generate."),
          out: tool.schema
            .string()
            .describe("Output file path, relative to the project directory unless absolute. The plugin writes a PNG."),
          quality: tool.schema
            .enum(["low", "medium", "high", "auto"])
            .describe("Generation quality passed to the hosted image_generation tool."),
          size: tool.schema
            .enum(Object.keys(IMAGE_SIZES) as [ImageSize, ...ImageSize[]])
            .optional()
            .describe(
              [
                `Output size. Only these sizes can be generated: ${SIZE_CHOICES}.`,
                "Typical choices: 1672x941 for a 16:9 video thumbnail, 1254x1254 for a square icon, 941x1672 for a phone wallpaper.",
              ].join(" "),
            ),
          images: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Optional reference image paths, relative to the project directory unless absolute."),
        },
        async execute(args, ctx) {
          const size = parseImageSize(args.size)
          const auth = await loadOpenAIAuth()
          if (!auth) {
            throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
          }

          const inputImageDataUrls = await readReferenceImages(args.images, ctx.directory)
          const base64 = await callViaCodexResponses(auth, { ...args, size }, inputImageDataUrls)

          const { savedPath, versioned, message } = await saveGeneratedImage(args.out, ctx.directory, base64)

          return {
            output: message,
            metadata: {
              out: savedPath,
              versioned,
              billing: "subscription",
            },
          }
        },
      }),
    },
  }
}

export default {
  id: "opencode-gpt-imagegen",
  server: GptImagePlugin,
} satisfies PluginModule
