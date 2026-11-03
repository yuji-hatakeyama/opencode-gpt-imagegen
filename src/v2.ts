import type { Plugin } from "@opencode/plugin/promise/plugin"
import { z } from "zod"
import { createImagegenTool } from "./imagegen"
import { loadOpenAIAuth } from "./v2-auth"

export const setup: Plugin["setup"] = async (context) => {
  const imagegen = createImagegenTool(context.options, () => loadOpenAIAuth(context.integration.connection))

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
        const result = await imagegen.execute(args, session.location.directory)
        return {
          content: result.message,
          metadata: { out: result.savedPath, versioned: result.versioned },
        }
      },
    })
  })
}
