import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Hooks, Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { type IntegrationAuth, loadOpenAIAuth, loadOpenAIIntegrationAuth } from "./auth"
import { type CodexImagesTarget, callViaCodexImages, chatGptImagesTarget, proxyImagesTarget } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import { IMAGE_SIZES, type ImageSize, SIZE_CHOICES } from "./size"

// https://developers.openai.com/api/docs/guides/image-generation
const argsShape = {
  prompt: tool.schema.string().describe("Description of the image to generate."),
  out: tool.schema
    .string()
    .describe("Output file path, relative to the project directory unless absolute. The plugin writes a PNG."),
  size: tool.schema
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
  images: tool.schema
    .array(tool.schema.string())
    .max(5)
    .nullish()
    .describe("Optional reference image paths, up to 5, relative to the project directory unless absolute."),
  // https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/imagegen_description.md?plain=1#L9
  background: tool.schema
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
const argsSchema = tool.schema.object(argsShape)

// Plugin options, given as `["opencode-gpt-imagegen", { ... }]` in the OpenCode config.
// `baseURL` sends requests to a proxy serving the Codex images endpoints instead of ChatGPT itself.
// A query or fragment would make the endpoint URL resolution drop the last path segment of baseURL.
const optionsSchema = tool.schema.object({
  baseURL: tool.schema
    .url({ protocol: /^https?$/ })
    .refine((value) => {
      const url = new URL(value)
      return url.search === "" && url.hash === ""
    }, "baseURL must not have a query or a fragment")
    .optional(),
})

async function resolveImagesTarget(
  options: PluginOptions | undefined,
  integration?: IntegrationAuth,
): Promise<CodexImagesTarget> {
  const parsed = optionsSchema.safeParse(options ?? {})
  if (!parsed.success) {
    throw new Error(`invalid opencode-gpt-imagegen options: ${tool.schema.prettifyError(parsed.error)}`)
  }
  if (parsed.data.baseURL) {
    return proxyImagesTarget(parsed.data.baseURL)
  }
  const auth = integration ? await loadOpenAIIntegrationAuth(integration) : await loadOpenAIAuth()
  if (!auth) {
    throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
  }
  return chatGptImagesTarget(auth)
}

async function generateImage(
  rawArgs: unknown,
  directory: string,
  options?: PluginOptions,
  integration?: IntegrationAuth,
  signal?: AbortSignal,
  beforeWrite?: (savedPath: string) => Promise<void>,
) {
  const parsed = argsSchema.safeParse(rawArgs)
  if (!parsed.success) throw new Error(tool.schema.prettifyError(parsed.error))
  signal?.throwIfAborted()
  const target = await resolveImagesTarget(options, integration)
  const inputImageDataUrls = await readReferenceImages(parsed.data.images, directory)
  const base64 = await callViaCodexImages(target, parsed.data, inputImageDataUrls, signal)
  signal?.throwIfAborted()
  const { savedPath, versioned, message } = await saveGeneratedImage(parsed.data.out, directory, base64, beforeWrite)
  return { output: message, metadata: { out: savedPath, versioned } }
}

const GptImagePlugin: Plugin = async (_input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const authNote = options?.baseURL
    ? "Sends requests to the proxy set by the plugin's `baseURL` option instead of ChatGPT, so ChatGPT OAuth is not used."
    : "Requires OpenCode to be authenticated with ChatGPT OAuth."
  return {
    tool: {
      gpt_imagegen: tool({
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
        args: argsShape,
        async execute(rawArgs, ctx) {
          return generateImage(rawArgs, ctx.directory, options)
        },
      }),
    },
  }
}

// Structural boundary avoids loading a second Effect runtime into the host.
// The Promise plugin contract is documented at /v2/docs/build/plugins.
export type V2Execution = { sessionID: string; messageID: string; id: string; agent: string; signal: AbortSignal }
export type V2Tool = {
  name: string
  description: string
  input: Record<string, unknown>
  execute(
    input: unknown,
    context: V2Execution,
  ): Promise<{
    content: Array<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string }>
    metadata: Record<string, unknown>
  }>
}
export type V2Context = {
  options: PluginOptions
  integration: IntegrationAuth
  session: { get(input: { sessionID: string }): Promise<{ location: { directory: string } }> }
  permission: {
    assert(input: {
      sessionID: string
      agent: string
      source: { type: "tool"; messageID: string; id: string }
      action: string
      resources: string[]
    }): Promise<void>
  }
  tool: { transform(callback: (editor: { add(tool: V2Tool): void }) => void): Promise<unknown> }
}

async function setupGptImageV2(ctx: V2Context): Promise<void> {
  // Reuse the V1 description and validation, but not its auth-file lookup.
  const legacy = await GptImagePlugin({} as PluginInput, ctx.options)
  const description = legacy.tool?.gpt_imagegen?.description ?? "Generate an image using Codex OAuth."
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "gpt_imagegen",
      description,
      input: tool.schema.toJSONSchema(argsSchema),
      async execute(input, context) {
        const args = argsSchema.parse(input)
        const session = await ctx.session.get({ sessionID: context.sessionID })
        const directory = session.location.directory
        if (!path.isAbsolute(directory)) throw new Error("OpenCode did not supply an absolute session directory.")
        const requestedPath = path.resolve(directory, args.out)
        const permissionSource = {
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool" as const, messageID: context.messageID, id: context.id },
        }
        await ctx.permission.assert({
          ...permissionSource,
          action: "edit",
          resources: [requestedPath],
        })
        for (const reference of args.images ?? []) {
          await ctx.permission.assert({
            ...permissionSource,
            action: "read",
            resources: [path.resolve(directory, reference)],
          })
        }
        const result = await generateImage(
          args,
          directory,
          ctx.options,
          ctx.integration,
          context.signal,
          async (savedPath) => {
            if (savedPath !== requestedPath) {
              await ctx.permission.assert({ ...permissionSource, action: "edit", resources: [savedPath] })
            }
            context.signal.throwIfAborted()
          },
        )
        return {
          content: [
            { type: "text", text: result.output },
            { type: "file", uri: pathToFileURL(result.metadata.out).href, mime: "image/png" },
          ],
          metadata: result.metadata,
        }
      },
    })
  })
}

export default {
  id: "opencode-gpt-imagegen",
  server: GptImagePlugin,
  setup: setupGptImageV2,
} satisfies PluginModule & { setup: typeof setupGptImageV2 }
