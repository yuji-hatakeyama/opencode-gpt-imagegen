import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadOpenAIAuth } from "./auth"
import { callViaCodexImages, MAX_EDIT_IMAGES, SIZE_ARG_PATTERN } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"

const GptImagePlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  return {
    tool: {
      gpt_imagegen: tool({
        description: [
          "Generate raster images with OpenAI's gpt-image-2 model.",
          "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
          "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
          `Reference images may be attached through \`images\` (at most ${MAX_EDIT_IMAGES}); label each image's role inline in \`prompt\`, for example: 'Image 1: reference image'.`,
          "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
          "Requires OpenCode to be authenticated with ChatGPT OAuth. Returns the absolute path of the saved PNG; an existing file at `out` is never overwritten, a `-vN` suffixed path is used instead.",
        ].join(" "),
        // No quality argument, and `size` is restated in the prompt: see withSizeNote in codex.ts.
        // OpenCode does not validate args against this schema before execute; the constraints
        // below steer the model, and the runtime checks live in the helper modules.
        args: {
          prompt: tool.schema.string().describe("Description of the image to generate."),
          out: tool.schema
            .string()
            .describe("Output file path, relative to the project directory unless absolute. The plugin writes a PNG."),
          size: tool.schema
            .string()
            .regex(SIZE_ARG_PATTERN)
            .optional()
            .describe(
              "Optional image size. Use `auto` or `WIDTHxHEIGHT`; width and height must be multiples of 16px, max edge <= 3840px, long-to-short ratio <= 3:1, and total pixels between 655,360 and 8,294,400.",
            ),
          images: tool.schema
            .array(tool.schema.string())
            .max(MAX_EDIT_IMAGES)
            .optional()
            .describe(
              `Optional reference image paths (at most ${MAX_EDIT_IMAGES}), relative to the project directory unless absolute.`,
            ),
        },
        async execute(args, ctx) {
          const auth = await loadOpenAIAuth()
          if (!auth) {
            throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
          }

          const inputImageDataUrls = await readReferenceImages(args.images, ctx.directory)
          const base64 = await callViaCodexImages(auth, args, inputImageDataUrls, {
            turnId: ctx.messageID,
            signal: ctx.abort,
          })

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
