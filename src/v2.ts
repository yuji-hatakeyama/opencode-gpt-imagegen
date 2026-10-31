import type { Plugin } from "@opencode/plugin/promise/plugin"
import { z } from "zod"
import { createImagegenTool } from "./imagegen"
import type { LoadOpenAIAuth } from "./types"

export const setup: Plugin["setup"] = async (context) => {
  const loadOpenAIAuth: LoadOpenAIAuth = async () => {
    const connection = await context.integration.connection.active("openai")
    const credential = connection ? await context.integration.connection.resolve(connection) : undefined
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

  const imagegen = createImagegenTool(context.options, loadOpenAIAuth)

  // Convert with the schema's own Zod instance so descriptions survive a different host Zod registry.
  const input = z.toJSONSchema(imagegen.schema, { io: "input" })
  await context.tool.transform((editor) => {
    editor.add({
      name: "gpt_imagegen",
      description: imagegen.description,
      input,
      // Keep the tool available when Code Mode's execute permission is denied.
      options: { codemode: false },
      async execute(args, execution) {
        const session = await context.session.get({ sessionID: execution.sessionID })
        // Earlier V2 hosts omit signal; image generation still works without cancellation.
        const result = await imagegen.execute(args, session.location.directory, execution.signal)
        return {
          content: result.message,
          metadata: { out: result.savedPath, versioned: result.versioned },
        }
      },
    })
  })
}
