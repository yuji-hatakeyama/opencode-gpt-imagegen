import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { fileTypeFromBuffer } from "file-type"
import { xdgData } from "xdg-basedir"

// Codex OAuth responses endpoint URL.
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/model-provider-info/src/lib.rs#L37
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/core/src/client.rs#L146
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"

// Codex model slug used for the hosted image_generation turn.
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/models-manager/models.json#L24
const SUBSCRIPTION_MODEL = "gpt-5.5"

const MAX_OUTPUT_VERSION_SUFFIX = 999

// Minimal subset of OpenCode auth.json's openai OAuth entry required by this plugin.
type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }

type GenerateArgs = {
  prompt: string
  out: string
  quality: "low" | "medium" | "high" | "auto"
  size?: string
  images?: string[]
}

async function readImageAsDataUrl(filePath: string, ctxDir: string): Promise<string> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctxDir, filePath)
  const buf = await fs.readFile(abs)
  const detected = await fileTypeFromBuffer(buf)
  if (!detected?.mime.startsWith("image/")) {
    throw new Error(`unsupported image file type: ${abs}`)
  }
  return `data:${detected.mime};base64,${buf.toString("base64")}`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function pickNonOverwritePath(requested: string): Promise<string> {
  if (!(await pathExists(requested))) return requested
  const dir = path.dirname(requested)
  const ext = path.extname(requested)
  const stem = path.basename(requested, ext)
  for (let n = 2; n <= MAX_OUTPUT_VERSION_SUFFIX; n++) {
    const candidate = path.join(dir, `${stem}-v${n}${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
  throw new Error(
    `could not find a non-conflicting filename under ${dir}/${stem}-vN${ext} (tried up to v${MAX_OUTPUT_VERSION_SUFFIX})`,
  )
}

function buildSavedMessage(savedPath: string, requestedPath: string): string {
  const versionNote =
    savedPath !== requestedPath
      ? ` (the requested path ${requestedPath} already existed; the new image was versioned to avoid overwriting it)`
      : ""
  return `Generated image saved to ${savedPath}${versionNote}.`
}

// Mirrors OpenCode's auth resolution: OPENCODE_AUTH_CONTENT overrides $XDG_DATA_HOME/opencode/auth.json.
// The Auth service is not exposed to external plugins, so this reproduces the rules directly.
async function loadAuthData(): Promise<Record<string, unknown>> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    return JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
  }
  const raw = await fs.readFile(path.join(xdgData!, "opencode", "auth.json"), "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

async function loadOpenAIAuth(): Promise<OpenAIAuth | undefined> {
  try {
    const data = await loadAuthData()
    const entry = data.openai as Partial<OpenAIAuth> | undefined
    if (entry?.type === "oauth" && typeof entry.access === "string") {
      return entry as OpenAIAuth
    }
  } catch {
    return undefined
  }
  return undefined
}

async function parseImageGenerationResultFromSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let result: string | undefined
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6).trim()
      if (data.length === 0 || data === "[DONE]") continue
      let json: Record<string, any>
      try {
        json = JSON.parse(data)
      } catch {
        continue
      }
      if (json.type === "response.output_item.done" && json.item?.type === "image_generation_call") {
        if (typeof json.item.result === "string") result = json.item.result
      }
      if (
        typeof json.result === "string" &&
        typeof json.type === "string" &&
        json.type.includes("image_generation_call")
      ) {
        result = json.result
      }
    }
  }
  if (!result) throw new Error("no image_generation result returned by codex backend")
  return result
}

async function callViaCodexResponses(
  auth: OpenAIAuth,
  args: GenerateArgs,
  inputImageDataUrls: string[],
): Promise<string> {
  const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: args.prompt }]
  for (const dataUrl of inputImageDataUrls) {
    userContent.push({ type: "input_image", image_url: dataUrl })
  }

  // https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/core/src/client.rs#L745-L763
  const body: Record<string, unknown> = {
    model: SUBSCRIPTION_MODEL,
    instructions:
      "You are an image generation assistant running inside the Codex backend. " +
      "Always satisfy the request by invoking the image_generation tool exactly once. " +
      "Do not respond with text only.",
    input: [{ role: "user", content: userContent }],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
        quality: args.quality,
        ...(args.size ? { size: args.size } : {}),
      },
    ],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  }

  const res = await fetch(CODEX_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      originator: "opencode",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "")
    throw new Error(`codex responses request failed: ${res.status} ${detail.slice(0, 500)}`)
  }
  return parseImageGenerationResultFromSSE(res.body)
}

const GptImagePlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  return {
    tool: {
      gpt_image_gen: tool({
        description: [
          "Generate raster images using OpenAI's hosted image_generation tool.",
          "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
          "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
          "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
          "For many distinct assets, invoke gpt_image_gen once per requested asset rather than relying on multi-image output; gpt_image_gen returns one image per call.",
          "Requires OpenCode to be authenticated with ChatGPT OAuth. Returns the absolute path of the saved PNG.",
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
            .string()
            .optional()
            .describe(
              "Optional image size passed to the hosted image_generation tool. Use `auto` or `WIDTHxHEIGHT`; width and height must be multiples of 16px, max edge <= 3840px, long-to-short ratio <= 3:1, and total pixels between 655,360 and 8,294,400.",
            ),
          images: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Optional reference image paths, relative to the project directory unless absolute."),
        },
        async execute(args, ctx) {
          const auth = await loadOpenAIAuth()
          if (!auth) {
            throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
          }

          const inputPaths = args.images ?? []
          const inputImageDataUrls = await Promise.all(
            inputPaths.map((path) => readImageAsDataUrl(path, ctx.directory)),
          )
          const base64 = await callViaCodexResponses(auth, args as GenerateArgs, inputImageDataUrls)

          const requestedPath = path.isAbsolute(args.out) ? args.out : path.resolve(ctx.directory, args.out)
          await fs.mkdir(path.dirname(requestedPath), { recursive: true })
          const savedPath = await pickNonOverwritePath(requestedPath)
          await fs.writeFile(savedPath, Buffer.from(base64, "base64"))

          const versioned = savedPath !== requestedPath

          return {
            output: buildSavedMessage(savedPath, requestedPath),
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
