import { Plugin } from "@opencode/plugin"
import type { Plugin as LegacyPlugin, PluginModule } from "@opencode-ai/plugin"
import { loadOpenAIAuth, loadOpenAIAuthFromConnection } from "./auth"
import { generateImage, IMAGE_ARGUMENT_DESCRIPTIONS, IMAGE_TOOL_DESCRIPTION } from "./image-generation"
import type { GenerateArgs } from "./types"

const GptImagePlugin: LegacyPlugin = async () => {
  // Load the V1 SDK only when V1 calls server(), not during V2 plugin setup.
  const { tool } = await import("@opencode-ai/plugin")
  return {
    tool: {
      gpt_imagegen: tool({
        description: IMAGE_TOOL_DESCRIPTION,
        // https://developers.openai.com/api/docs/guides/image-generation
        args: {
          prompt: tool.schema.string().describe(IMAGE_ARGUMENT_DESCRIPTIONS.prompt),
          out: tool.schema.string().describe(IMAGE_ARGUMENT_DESCRIPTIONS.out),
          quality: tool.schema.enum(["low", "medium", "high", "auto"]).describe(IMAGE_ARGUMENT_DESCRIPTIONS.quality),
          size: tool.schema.string().optional().describe(IMAGE_ARGUMENT_DESCRIPTIONS.size),
          images: tool.schema.array(tool.schema.string()).optional().describe(IMAGE_ARGUMENT_DESCRIPTIONS.images),
        },
        async execute(args, ctx) {
          const auth = await loadOpenAIAuth()
          const result = await generateImage(auth, args, ctx.directory, ctx.abort)
          return { output: result.content, metadata: result.metadata }
        },
      }),
    },
  }
}

export default {
  ...Plugin.define({
    id: "opencode-gpt-imagegen",
    async setup(ctx) {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "gpt_imagegen",
          description: IMAGE_TOOL_DESCRIPTION,
          input: {
            type: "object",
            properties: {
              prompt: { type: "string", description: IMAGE_ARGUMENT_DESCRIPTIONS.prompt },
              out: { type: "string", description: IMAGE_ARGUMENT_DESCRIPTIONS.out },
              quality: {
                type: "string",
                enum: ["low", "medium", "high", "auto"],
                description: IMAGE_ARGUMENT_DESCRIPTIONS.quality,
              },
              size: { type: "string", description: IMAGE_ARGUMENT_DESCRIPTIONS.size },
              images: {
                type: "array",
                items: { type: "string" },
                description: IMAGE_ARGUMENT_DESCRIPTIONS.images,
              },
            },
            required: ["prompt", "out", "quality"],
            additionalProperties: false,
          },
          async execute(input, context) {
            context.signal.throwIfAborted()
            const auth = await loadOpenAIAuthFromConnection(ctx.integration.connection)
            // ToolContext has no directory in V2. Resolve the invoking session's location,
            // not the plugin's setup location, which can differ after a session move.
            const session = await ctx.session.get({ sessionID: context.sessionID })
            return generateImage(auth, input as GenerateArgs, session.location.directory, context.signal)
          },
        })
      })
    },
  }),
  server: GptImagePlugin,
} satisfies PluginModule
