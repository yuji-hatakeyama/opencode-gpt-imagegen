import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { xdgData } from "xdg-basedir"
import { createImagegenTool } from "./imagegen"
import { loadOpenAIAuth } from "./v1-auth"

export const server: Plugin = async (_input, options) => {
  const imagegen = createImagegenTool(options, () =>
    loadOpenAIAuth(
      process.env.OPENCODE_AUTH_CONTENT,
      xdgData ? path.join(xdgData, "opencode", "auth.json") : undefined,
    ),
  )
  return {
    tool: {
      gpt_imagegen: {
        description: imagegen.description,
        args: imagegen.schema.shape,
        async execute(input, context) {
          const result = await imagegen.execute(input, context.directory)
          return {
            output: result.message,
            metadata: { out: result.savedPath, versioned: result.versioned },
          }
        },
      },
    },
  }
}
