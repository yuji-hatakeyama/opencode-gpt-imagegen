import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { xdgData } from "xdg-basedir"
import { createImagegenTool } from "./imagegen"
import type { LoadOpenAIAuth, OpenAIAuth } from "./types"

// Mirrors V1's auth resolution: OPENCODE_AUTH_CONTENT overrides $XDG_DATA_HOME/opencode/auth.json.
// V1 does not expose its Auth service to external plugins.
async function loadAuthData(): Promise<Record<string, unknown>> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    return JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
  }
  if (!xdgData) {
    throw new Error("could not determine XDG data directory")
  }
  const raw = await fs.readFile(path.join(xdgData, "opencode", "auth.json"), "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

const loadOpenAIAuth: LoadOpenAIAuth = async () => {
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

export const server: Plugin = async (_input, options) => {
  const imagegen = createImagegenTool(options, loadOpenAIAuth)
  return {
    tool: {
      gpt_imagegen: {
        description: imagegen.description,
        args: imagegen.schema.shape,
        async execute(input, context) {
          const result = await imagegen.execute(input, context.directory, context.abort)
          return {
            output: result.message,
            metadata: { out: result.savedPath, versioned: result.versioned },
          }
        },
      },
    },
  }
}
