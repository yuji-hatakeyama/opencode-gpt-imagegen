import { generateImage } from "./generate"
import { TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA } from "./tool-spec"
import type { GenerateArgs } from "./types"

// OpenCode v2 loads a plugin as a default export with an `id` and a `setup`
// function. Its types live in @opencode/plugin, a package versioned in lockstep
// with the app, so this entrypoint declares only the subset of the context it
// uses instead of pinning either plugin API version.
export type ToolExecuteContext = { signal?: AbortSignal }

export type ToolRegistration = {
  name: string
  description: string
  input: typeof TOOL_INPUT_SCHEMA
  execute(input: unknown, context: ToolExecuteContext): Promise<{ content: string; metadata: Record<string, unknown> }>
}

type ToolEditor = { add(tool: ToolRegistration): void }

export type PluginContext = {
  readonly location: { readonly directory: string }
  readonly tool: { transform(register: (editor: ToolEditor) => void): Promise<unknown> }
}

export const V2_PLUGIN_ID = "opencode-gpt-imagegen"

export async function setupV2(ctx: PluginContext): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "gpt_imagegen",
      description: TOOL_DESCRIPTION,
      input: TOOL_INPUT_SCHEMA,
      async execute(input, context) {
        const { message, savedPath, versioned } = await generateImage(
          input as GenerateArgs,
          ctx.location.directory,
          context.signal,
        )
        return {
          content: message,
          metadata: { out: savedPath, versioned, billing: "subscription" },
        }
      },
    })
  })
}
