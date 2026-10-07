import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { IntegrationDomain } from "@opencode/plugin/promise/integration"
import type { OpenAIAuth } from "./types"

// Mirrors OpenCode V1's auth resolution: OPENCODE_AUTH_CONTENT overrides $XDG_DATA_HOME/opencode/auth.json.
// V1 does not expose its Auth service to external plugins, so this reproduces the rules directly.
async function loadAuthData(): Promise<Record<string, unknown>> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    return JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
  }
  const { xdgData } = await import("xdg-basedir")
  if (!xdgData) {
    throw new Error("could not determine XDG data directory")
  }
  const raw = await fs.readFile(path.join(xdgData, "opencode", "auth.json"), "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

export async function loadOpenAIAuth(): Promise<OpenAIAuth | undefined> {
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

// V2 manages active credentials and token refresh through the integration API.
// Never fall back to a V1 auth file: it could select a different or stale account.
export async function loadOpenAIAuthFromConnection(
  connection: Pick<IntegrationDomain["connection"], "active" | "resolve">,
): Promise<OpenAIAuth | undefined> {
  const active = await connection.active("openai")
  if (!active) return undefined
  const credential = await connection.resolve(active)
  if (credential?.type !== "oauth") return undefined
  if (credential.methodID === "chatgpt-token-sharing") {
    throw new Error(
      "ChatGPT token sharing cannot be used with the Codex image-generation backend. " +
        "Connect OpenAI using Codex browser (legacy) or Codex device code (legacy), and select that connection.",
    )
  }
  if (credential.methodID !== "chatgpt-browser" && credential.methodID !== "chatgpt-headless") return undefined
  const accountId = credential.metadata?.accountID
  return {
    type: "oauth",
    access: credential.access,
    ...(typeof accountId === "string" ? { accountId } : {}),
  }
}
