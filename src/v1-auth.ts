import * as fs from "node:fs/promises"
import type { OpenAIAuth } from "./types"

// Mirrors V1's auth resolution: OPENCODE_AUTH_CONTENT overrides $XDG_DATA_HOME/opencode/auth.json.
// V1 does not expose its Auth service to external plugins.
async function loadAuthData(
  envContent: string | undefined,
  authFile: string | undefined,
): Promise<Record<string, unknown>> {
  if (envContent) {
    return JSON.parse(envContent) as Record<string, unknown>
  }
  if (!authFile) {
    throw new Error("could not determine XDG data directory")
  }
  const raw = await fs.readFile(authFile, "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

export async function loadOpenAIAuth(
  envContent: string | undefined,
  authFile: string | undefined,
): Promise<OpenAIAuth | undefined> {
  try {
    const data = await loadAuthData(envContent, authFile)
    const entry = data.openai as Partial<OpenAIAuth> | undefined
    if (entry?.type === "oauth" && typeof entry.access === "string") {
      return entry as OpenAIAuth
    }
  } catch {
    return undefined
  }
  return undefined
}
