import type { Context } from "@opencode/plugin/promise/plugin"
import type { OpenAIAuth } from "./types"

export async function loadOpenAIAuth(
  connections: Pick<Context["integration"]["connection"], "active" | "resolve">,
): Promise<OpenAIAuth | undefined> {
  const connection = await connections.active("openai")
  const credential = connection ? await connections.resolve(connection) : undefined
  if (!credential) return undefined
  if (
    credential.type !== "oauth" ||
    (credential.methodID !== "chatgpt-browser" && credential.methodID !== "chatgpt-headless")
  ) {
    const method = credential.type === "oauth" ? credential.methodID : credential.type
    throw new Error(
      `The OpenAI connection's sign-in method (${method}) cannot generate images. In OpenCode, connect OpenAI and choose "Codex browser (legacy)" or "Codex device code (legacy)".`,
    )
  }
  const accountId = credential.metadata?.accountID
  return {
    type: "oauth",
    access: credential.access,
    ...(typeof accountId === "string" ? { accountId } : {}),
  }
}
