import * as fs from "node:fs/promises"
import * as path from "node:path"
import { xdgData } from "xdg-basedir"
import type { OpenAIAuth } from "./types"

// Mirrors OpenCode's auth resolution: OPENCODE_AUTH_CONTENT overrides $XDG_DATA_HOME/opencode/auth.json.
// The Auth service is not exposed to external plugins, so this reproduces the rules directly.
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

// Resolve through the host in V2: auth.json is no longer authoritative there.
export type IntegrationAuth = {
  connection: {
    active(integrationID: string): Promise<unknown>
    resolve(connection: unknown): Promise<unknown>
  }
}

export async function loadOpenAIIntegrationAuth(integration: IntegrationAuth): Promise<OpenAIAuth> {
  const connection = await integration.connection.active("openai")
  if (!connection) throw new Error("Connect OpenAI with Codex OAuth before generating images.")
  const value = await integration.connection.resolve(connection)
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "oauth" ||
    !("access" in value) ||
    typeof value.access !== "string" ||
    !value.access.trim()
  ) {
    throw new Error("Image generation requires an OpenAI Codex OAuth connection, not an API key.")
  }
  const credential = value as { access: string; metadata?: Record<string, unknown> }
  let claims: Record<string, unknown> = {}
  try {
    const decoded = JSON.parse(Buffer.from(credential.access.split(".")[1] ?? "", "base64url").toString())
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) claims = decoded
  } catch {
    // Some access tokens are opaque. Account metadata can still supply the ID.
  }
  const authClaims = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined
  const organizations = claims.organizations as Array<{ id?: unknown }> | undefined
  const accountId = [
    credential.metadata?.accountId,
    credential.metadata?.chatgpt_account_id,
    claims.chatgpt_account_id,
    authClaims?.chatgpt_account_id,
    organizations?.[0]?.id,
  ].find((value): value is string => typeof value === "string" && value.length > 0)
  return { type: "oauth", access: credential.access, ...(accountId ? { accountId } : {}) }
}
